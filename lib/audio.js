import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVaultFiles } from './vault-files.js';
import { run, throwIfAborted, isAbort } from './process.js';

export const MODEL_HASH = '9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794';
const MODEL_URL = `https://openaipublic.azureedge.net/main/whisper/models/${MODEL_HASH}/small.pt`;
const PYTHON = process.env.DSH_LITERATURE_PYTHON || 'python3';
const FFMPEG = process.env.DSH_LITERATURE_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.DSH_LITERATURE_FFPROBE || 'ffprobe';
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
export const MAX_RECORDING_SECONDS = 4 * 60 * 60;
const TRANSCRIPTION_SECONDS = 90;
const STORAGE = '文献库/_data/recordings';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIME = new Map([['audio/webm', 'webm'], ['audio/ogg', 'ogg'], ['audio/mp4', 'm4a']]);
const WAITING = new Set(['queued', 'running']);

function error(message, status = 400, code = 'voice-input') { return Object.assign(new Error(message), { status, code }); }
function idOf(value) { if (!UUID.test(String(value))) throw error('录音编号无效'); return value; }
function readableError(cause) { return isAbort(cause) ? '任务已中止，可继续处理已保存的录音。' : String(cause?.message || '操作失败').slice(0, 240); }
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function writeAtomic(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(data);
    await file.sync();
    await file.close(); file = null;
    await rename(temporary, path);
  } finally {
    await file?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
const writeJson = (path, value) => writeAtomic(path, JSON.stringify(value));
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
const chunkName = seq => String(seq).padStart(8, '0') + '.bin';
const now = () => new Date().toISOString();
function audioFormat(value) {
  const type = String(value || '').toLowerCase().split(';', 1)[0].trim();
  const extension = MIME.get(type);
  if (!extension) throw error('应用当前无法录制受支持的音频格式。', 415, 'voice-format');
  return { mimeType: type, extension };
}

async function digestFile(path, signal) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
  return digest.digest('hex');
}
async function findVerifiedCheckpoint(candidates, verified, signal) {
  for (const path of candidates) {
    throwIfAborted(signal);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size > 800 * 1024 * 1024 || info.size < 200 * 1024 * 1024) continue;
    const key = `${path}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (verified.has(key) || await digestFile(path, signal) === MODEL_HASH) { verified.add(key); return path; }
  }
  return null;
}
function formatProgress(record) { return { ...record, transcript: { ...record.transcript, parts: record.transcript.parts || [] } }; }

function createRuntime({ python = PYTHON, modelRoot, ffmpeg = FFMPEG, ffprobe = FFPROBE } = {}) {
  const candidates = [join(modelRoot, 'small.pt'), join(homedir(), '.cache', 'whisper', 'small.pt')];
  const verified = new Set();
  let environment;
  async function probe(signal) {
    if (!environment) {
      environment = Promise.all([
        run(python, ['-B', '-c', 'import whisper, torch; print(whisper.__version__)'], { signal, timeout: 20_000, maxBuffer: 16_384 }),
        run(ffmpeg, ['-version'], { signal, timeout: 20_000, maxBuffer: 16_384 }),
        run(ffprobe, ['-version'], { signal, timeout: 20_000, maxBuffer: 16_384 }),
      ])
        .then(() => ({ ready: true }))
        .catch(cause => { if (isAbort(cause)) { environment = undefined; throw cause; } return { ready: false }; });
    }
    return environment;
  }
  return {
    async status(signal) {
      if (!(await probe(signal)).ready) return { status: 'unavailable', message: '需要本机 Python 3.14 的 Whisper、Torch 和 FFmpeg。' };
      return { status: await findVerifiedCheckpoint(candidates, verified, signal) ? 'ready' : 'missing', model: 'Whisper small 多语种' };
    },
    async setup({ signal, progress }) {
      if (!(await probe(signal)).ready) throw error('本机 Whisper 或 FFmpeg 不可用。', 503, 'whisper-unavailable');
      if (await findVerifiedCheckpoint(candidates, verified, signal)) return;
      await mkdir(modelRoot, { recursive: true, mode: 0o700 });
      const temporary = join(modelRoot, `small.${randomUUID()}.part`);
      const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(3_600_000)]);
      let file;
      try {
        const response = await fetch(MODEL_URL, { signal: fetchSignal, redirect: 'error' });
        if (!response.ok || !response.body) throw error(`模型下载失败（HTTP ${response.status}）`, 502, 'whisper-download');
        const declared = Number(response.headers.get('content-length'));
        const maximum = 800 * 1024 * 1024;
        if (declared > maximum) throw error('模型响应超过大小限制。', 502, 'whisper-size');
        const digest = createHash('sha256');
        let bytes = 0;
        file = await open(temporary, 'wx', 0o600);
        for await (const chunk of response.body) {
          throwIfAborted(fetchSignal);
          bytes += chunk.length;
          if (bytes > maximum) throw error('模型响应超过大小限制。', 502, 'whisper-size');
          digest.update(chunk);
          await file.writeFile(chunk);
          progress({ status: 'downloading', receivedBytes: bytes, totalBytes: declared || null });
        }
        progress({ status: 'verifying', receivedBytes: bytes, totalBytes: declared || bytes });
        if (digest.digest('hex') !== MODEL_HASH) throw error('模型完整性校验失败，请重试。', 422, 'whisper-integrity');
        await file.sync(); await file.close(); file = null;
        throwIfAborted(signal);
        await rename(temporary, candidates[0]);
      } finally {
        await file?.close().catch(() => {});
        await rm(temporary, { force: true }).catch(() => {});
      }
    },
    async finalize({ source, output, extension, signal }) {
      const muxer = extension === 'm4a' ? 'mp4' : extension;
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', source, '-map', '0:a:0', '-vn', '-c:a', 'copy', '-f', muxer, output], { signal, timeout: 180_000, maxBuffer: 65_536 });
      const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', output], { signal, timeout: 30_000, maxBuffer: 65_536 });
      const durationSeconds = Number(stdout.trim());
      if (!(durationSeconds > 0) || durationSeconds > MAX_RECORDING_SECONDS + 20) throw error('录音长度异常，已保留原始录音分段。', 422, 'voice-duration');
      const directory = await mkdtemp(join(tmpdir(), 'dsh-wave-'));
      try {
        const sample = join(directory, 'wave.pcm');
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', output, '-vn', '-ac', '1', '-ar', '1000', '-f', 's16le', sample], { signal, timeout: 180_000, maxBuffer: 65_536 });
        const pcm = await readFile(sample, { signal });
        const count = Math.floor(pcm.length / 2), bins = Math.min(160, count), waveform = [];
        for (let i = 0; i < bins; i++) {
          const start = Math.floor(i * count / bins), end = Math.floor((i + 1) * count / bins);
          let max = 0;
          for (let j = start; j < end; j++) max = Math.max(max, Math.abs(pcm.readInt16LE(j * 2)));
          waveform.push(Math.round(max / 32768 * 1000) / 1000);
        }
        return { durationSeconds, waveform };
      } finally { await rm(directory, { force: true, recursive: true }); }
    },
    async transcribe({ audio, directory, parts, language, signal, progress }) {
      const model = await findVerifiedCheckpoint(candidates, verified, signal);
      if (!model) throw error('请先准备 Whisper small 模型。', 409, 'whisper-model-missing');
      const scratch = await mkdtemp(join(tmpdir(), 'dsh-whisper-'));
      const manifest = join(scratch, 'task.json');
      let observer;
      try {
        await writeJson(manifest, { model, audio, directory, parts, language, ffmpeg });
        const observe = async () => {
          const files = await readdir(directory).catch(() => []);
          progress(files.filter(file => /^\d{6}\.json$/.test(file)).length);
        };
        observer = setInterval(() => observe().catch(() => {}), 500);
        observer.unref?.();
        const script = fileURLToPath(new URL('./voice_whisper.py', import.meta.url));
        await run(python, ['-B', script, manifest], { signal, timeout: Math.max(300_000, parts.length * 180_000), maxBuffer: 128 * 1024 });
        await observe();
      } finally { clearInterval(observer); await rm(scratch, { force: true, recursive: true }); }
    },
  };
}

export async function createAudioLibrary({ vaultPath, getDocument, summarize, python, modelRoot, runtime } = {}) {
  const vault = await realpath(vaultPath);
  const files = createVaultFiles(vault);
  const paths = async (id, name = '', required = false) => files.path(`${STORAGE}/${idOf(id)}/${name}`, { required });
  const engine = runtime || createRuntime({ python, modelRoot: modelRoot || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'literature-hub', 'whisper') });
  const lifetime = new AbortController(), jobs = new Set(), locks = new Map(), progress = new Map(), controls = new Map();
  let setupJob, setupState, activeRecording, transcription, initialized;
  const check = () => throwIfAborted(lifetime.signal);
  function lock(key, action) {
    const next = (locks.get(key) || Promise.resolve()).catch(() => {}).then(action);
    locks.set(key, next);
    next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
    return next;
  }
  function task(work) {
    const job = Promise.resolve().then(work);
    jobs.add(job);
    job.finally(() => jobs.delete(job)).catch(() => {});
    return job;
  }
  function jobSignal(key) {
    const controller = new AbortController(); controls.set(key, controller);
    return AbortSignal.any([lifetime.signal, controller.signal]);
  }
  async function load(id) {
    try { return await readJson(await paths(id, 'metadata.json', true)); }
    catch (cause) { if (cause.code === 'ENOENT' || cause.code === 'not-found') throw error('录音不存在。', 404, 'voice-not-found'); throw cause; }
  }
  async function save(record) {
    record.updatedAt = now();
    await writeJson(await paths(record.id, 'metadata.json'), record);
    return record;
  }
  async function doc(id) {
    const document = await getDocument(idOf(id));
    if (!document || document.id !== id) throw error('录音关联的文献不存在。', 404, 'voice-document');
    return document;
  }
  async function records() {
    const root = await files.path(STORAGE);
    const names = await readdir(root, { withFileTypes: true });
    const items = await Promise.all(names.filter(name => name.isDirectory() && UUID.test(name.name)).map(name => load(name.name).catch(() => null)));
    return items.filter(Boolean);
  }
  function projection(record, detailed = true) {
    const fileUrl = record.status === 'saved' ? `/literature-hub/api/voice/file?${new URLSearchParams({ id: record.id, docId: record.docId })}` : null;
    const projected = { ...record, fileUrl, url: fileUrl, assetId: record.id, mediaLink: fileUrl ? `${STORAGE}/${record.id}/audio.${record.extension}` : null };
    if (progress.has(record.id)) projected.transcript = { ...record.transcript, done: progress.get(record.id) };
    if (progress.has(`summary:${record.id}`)) projected.summary = { ...record.summary, progress: progress.get(`summary:${record.id}`) };
    if (!detailed) {
      projected.transcript = { status: record.transcript.status, done: projected.transcript.done, total: record.transcript.total, error: record.transcript.error };
      projected.summary = { status: record.summary.status, error: record.summary.error };
      delete projected.waveform;
    }
    return formatProgress(projected);
  }
  async function init() {
    check();
    if (!initialized) initialized = (async () => {
      await mkdir(await files.path(STORAGE, { required: false }), { recursive: true, mode: 0o700 });
      for (const record of await records()) {
        let dirty = false;
        if (record.status === 'recording' || record.status === 'saving') { record.status = 'interrupted'; dirty = true; }
        if (WAITING.has(record.transcript.status)) { record.transcript.status = 'interrupted'; dirty = true; }
        if (WAITING.has(record.summary.status)) { record.summary.status = 'interrupted'; dirty = true; }
        if (dirty) await save(record);
      }
    })();
    await initialized;
  }
  async function recordedChunks(id) {
    const directory = await paths(id, 'chunks');
    const list = (await readdir(directory).catch(cause => { if (cause.code === 'ENOENT') return []; throw cause; })).filter(file => /^\d{8}\.bin$/.test(file)).sort();
    if (list.some((file, i) => file !== chunkName(i))) throw error('录音分段不连续，原始分段已保留。', 409, 'voice-sequence');
    return list;
  }
  async function finalize(id) {
    const record = await load(id);
    if (record.status === 'saved') return projection(record);
    const chunks = await recordedChunks(id);
    if (!chunks.length) { record.status = 'interrupted'; record.error = '未收到录音数据。'; return projection(await save(record)); }
    record.status = 'saving'; await save(record);
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-voice-'));
    const source = join(scratch, 'capture.' + record.extension), output = join(scratch, 'audio.' + record.extension);
    let stream;
    try {
      stream = await open(source, 'wx', 0o600);
      for (const chunk of chunks) { check(); await stream.writeFile(await readFile(await paths(id, 'chunks/' + chunk, true), { signal: lifetime.signal })); }
      await stream.close(); stream = null;
      const result = await engine.finalize({ source, output, extension: record.extension, signal: lifetime.signal });
      check();
      const target = await paths(id, 'audio.' + record.extension);
      // Cross-volume temporary directories are possible, so commit with a vault-local atomic rename.
      await writeAtomic(target, createReadStream(output, { signal: lifetime.signal }));
      Object.assign(record, result, { status: 'saved', bytes: (await stat(target)).size, chunks: chunks.length, error: null, revision: record.revision + 1 });
      await save(record);
      await rm(await paths(id, 'chunks'), { recursive: true, force: true }).catch(() => {});
      return projection(record);
    } catch (cause) {
      record.status = 'interrupted'; record.error = readableError(cause); await save(record);
      if (isAbort(cause)) throw cause;
      return projection(record);
    } finally {
      await stream?.close().catch(() => {});
      await rm(scratch, { recursive: true, force: true });
    }
  }
  const api = {
    init,
    async withoutActiveRecording(docId,action) {
      await init();
      return lock('recording-start',async()=>{
        if (activeRecording&&(await load(activeRecording)).docId===docId) throw error('请先停止这份文档的录音。',409,'voice-busy');
        return action();
      });
    },
    async status() { await init(); return { model: setupState || await engine.status(lifetime.signal), maxRecordingSeconds: MAX_RECORDING_SECONDS }; },
    async list({ docId } = {}) { await init(); await doc(docId); return (await records()).filter(record => record.docId === docId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(record => projection(record, false)); },
    async get(id, { docId } = {}) { await init(); const record = await load(id); if (docId !== undefined && idOf(docId) !== record.docId) throw error('此录音不属于当前文献。', 404, 'voice-not-found'); await doc(record.docId); return projection(record); },
    async assetMetadata(id, { docId } = {}) {
      await init();
      const record = await load(id);
      if (idOf(docId) !== record.docId || record.status !== 'saved') throw error('此录音不属于当前文献或尚未保存。', 404, 'voice-not-found');
      return projection(record, false);
    },
    async file(id, options) { const record = await api.get(id, options); if (record.status !== 'saved') throw error('录音尚未保存。', 409, 'voice-not-ready'); return { path: await paths(id, 'audio.' + audioFormat(record.mimeType).extension, true), mimeType: record.mimeType }; },
    async start({ docId, title, mimeType } = {}) {
      await init();
      return lock('recording-start', async () => {
        check(); const document = await doc(docId); check();
        if (activeRecording) throw error('已有一段录音正在进行。', 409, 'voice-busy');
        const id = randomUUID(), format = audioFormat(mimeType);
        const record = { id, docId, title: String(title || document.title || '录音').trim().slice(0, 160) || '录音', ...format, createdAt: now(), status: 'recording', bytes: 0, chunks: 0, durationSeconds: null, waveform: [], revision: 0, transcript: { status: 'empty', revision: 0, text: '', parts: [] }, summary: { status: 'empty', text: '', todos: [] } };
        await mkdir(await paths(id, 'chunks'), { recursive: true, mode: 0o700 });
        await save(record); activeRecording = id;
        return projection(record);
      });
    },
    async chunk({ id, seq, base64 } = {}) {
      await init(); idOf(id);
      if (!Number.isInteger(seq) || seq < 0 || seq > 10_000 || typeof base64 !== 'string' || base64.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw error('录音分段无效或超限。', 413, 'voice-chunk-size');
      const bytes = Buffer.from(base64, 'base64');
      if (!bytes.length || bytes.length > MAX_CHUNK_BYTES || bytes.toString('base64') !== base64) throw error('录音分段无效。');
      return lock(id, async () => {
        check(); const record = await load(id);
        if (record.status !== 'recording' || activeRecording !== id) throw error('录音已结束。', 409, 'voice-not-recording');
        const path = await paths(id, 'chunks/' + chunkName(seq));
        if (await exists(path)) {
          if (!(await readFile(path)).equals(bytes)) throw error('该录音分段与已保存内容不一致。', 409, 'voice-sequence');
          if (seq < record.chunks) return { id, seq, bytes: record.bytes };
        } else {
          if (seq !== record.chunks) throw error('录音分段顺序不正确。', 409, 'voice-sequence');
          if (record.bytes + bytes.length > MAX_AUDIO_BYTES) throw error('录音超过本地容量上限，已保存分段保留。', 413, 'voice-size');
          await writeAtomic(path, bytes);
        }
        record.chunks = seq + 1; record.bytes += bytes.length; await save(record);
        return { id, seq, bytes: record.bytes };
      });
    },
    async stop({ id } = {}) { await init(); idOf(id); return lock(id, async () => { await doc((await load(id)).docId); if (activeRecording === id) activeRecording = null; return finalize(id); }); },
    async interrupt({ id } = {}) { await init(); idOf(id); return lock(id, async () => { const record = await load(id); await doc(record.docId); if (activeRecording === id) activeRecording = null; if (record.status === 'recording') { record.status = 'interrupted'; await save(record); } return projection(record); }); },
    async recover({ id } = {}) { await init(); idOf(id); return lock(id, async () => { const record = await load(id); await doc(record.docId); if (record.status === 'recording' && activeRecording === id) throw error('请先停止录音。', 409, 'voice-busy'); return finalize(id); }); },
    async setup() {
      await init();
      if (!setupJob) {
        setupState = { status: 'downloading', receivedBytes: 0, totalBytes: null };
        const signal = jobSignal('setup');
        setupJob = task(async () => {
          try { await engine.setup({ signal, progress: status => { setupState = status; } }); setupState = { status: 'ready', model: 'Whisper small 多语种' }; }
          catch (cause) { setupState = { status: signal.aborted ? 'interrupted' : 'failed', error: readableError(cause) }; }
          finally { controls.delete('setup'); setupJob = null; }
        });
      }
      return { model: setupState, maxRecordingSeconds: MAX_RECORDING_SECONDS };
    },
    async transcribe({ id, language = 'auto' } = {}) {
      await init(); idOf(id);
      if (!/^(auto|[a-z]{2,3})$/.test(language)) throw error('识别语言无效。');
      return lock('transcription-start', () => lock(id, async () => {
        const record = await load(id); await doc(record.docId);
        if (record.status !== 'saved') throw error('请先保存录音。', 409, 'voice-not-ready');
        if (transcription === id) return projection(record);
        if (transcription) throw error('另一段录音正在转写，请稍后重试。', 409, 'voice-busy');
        if (WAITING.has(record.summary.status)) throw error('摘要正在生成，请稍后重试。', 409, 'voice-busy');
        const status = setupState || await engine.status(lifetime.signal);
        if (status.status !== 'ready') throw error('请先准备 Whisper small 模型。', 409, 'whisper-model-missing');
        const parts = Array.from({ length: Math.ceil(record.durationSeconds / TRANSCRIPTION_SECONDS) }, (_, index) => ({ index, start: index * TRANSCRIPTION_SECONDS, end: Math.min((index + 1) * TRANSCRIPTION_SECONDS, record.durationSeconds) }));
        const directory = await paths(id, 'transcripts/' + language);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        record.transcript = { ...record.transcript, status: 'running', language, total: parts.length, done: 0, error: null };
        await save(record);
        transcription = id;
        const key = `transcribe:${id}`, signal = jobSignal(key);
        task(async () => {
          try {
            await engine.transcribe({ audio: await paths(id, 'audio.' + record.extension, true), directory, parts, language, signal, progress: done => progress.set(id, done) });
            throwIfAborted(signal);
            const output = await Promise.all(parts.map(part => readJson(join(directory, String(part.index).padStart(6, '0') + '.json'))));
            const text = output.map(part => part.text).filter(Boolean).join('\n\n');
            await lock(id, async () => {
              const current = await load(id);
              const edited = current.transcript.corrected === true;
              current.transcript = { status: 'ready', language, machineText: text, text: edited ? current.transcript.text : text, corrected: edited, parts: edited ? current.transcript.parts : output, machineParts: edited ? output : undefined, done: parts.length, total: parts.length, revision: current.transcript.revision + 1 };
              if (current.summary.text) current.summary.status = 'stale';
              current.revision++; await save(current);
            });
          } catch (cause) {
            await lock(id, async () => { const current = await load(id); current.transcript.status = signal.aborted || isAbort(cause) ? 'interrupted' : 'failed'; current.transcript.error = readableError(cause); current.transcript.done = progress.get(id) || 0; await save(current); });
          } finally { controls.delete(key); progress.delete(id); transcription = null; }
        });
        return projection(record);
      }));
    },
    async summary({ id } = {}) {
      await init(); idOf(id);
      if (typeof summarize !== 'function') throw error('当前模型摘要不可用。', 503, 'voice-summary-unavailable');
      return lock(id, async () => {
        const record = await load(id); await doc(record.docId);
        const transcript = record.transcript.text;
        if (!transcript?.trim() || record.transcript.status !== 'ready') throw error('请先完成转写。', 409, 'voice-transcript-missing');
        if (WAITING.has(record.summary.status)) return projection(record);
        const revision = record.transcript.revision;
        record.summary = { ...record.summary, status: 'running', error: null }; await save(record);
        const key = `summary:${id}`, signal = jobSignal(key);
        task(async () => {
          try {
            const parts = record.transcript.parts || [];
            const onProgress = value => { if (!signal.aborted) progress.set(key, value); };
            const result = await summarize({ docId: record.docId, recordingId: id, transcript, parts, durationSeconds: record.durationSeconds, corrected: record.transcript.corrected === true, signal, onProgress });
            throwIfAborted(signal);
            if (typeof result?.text !== 'string' || !result.text.trim()) throw error('模型没有返回可用摘要。', 422, 'voice-summary-empty');
            await lock(id, async () => {
              const current = await load(id);
              current.summary = { status: current.transcript.revision === revision ? 'ready' : 'stale', text: result.text, todos: normalizeTodos(result.todos), sourceRevision: revision, completedAt: now() };
              current.revision++; await save(current);
            });
          } catch (cause) { await lock(id, async () => { const current = await load(id); current.summary.status = signal.aborted || isAbort(cause) ? 'interrupted' : 'failed'; current.summary.error = readableError(cause); await save(current); }); }
          finally { controls.delete(key); progress.delete(key); }
        });
        return projection(record);
      });
    },
    async cancel({ id, kind } = {}) {
      await init();
      if (kind === 'setup') { controls.get('setup')?.abort('模型准备已取消'); return api.status(); }
      if (!['transcribe', 'summary'].includes(kind)) throw error('任务类型无效。');
      const record = await api.get(id);
      controls.get(`${kind}:${id}`)?.abort('任务已取消');
      return record;
    },
    async edit({ id, expectedRevision, title, transcript, transcriptParts, summary, todos } = {}) {
      await init(); idOf(id);
      return lock(id, async () => {
        const record = await load(id); await doc(record.docId);
        if (expectedRevision !== record.revision) throw error('录音笔记已更新，请刷新后重试。', 409, 'voice-revision');
        if (title !== undefined) record.title = String(title).trim().slice(0, 160) || record.title;
        if (transcript !== undefined || transcriptParts !== undefined) {
          if (transcriptParts !== undefined) {
            if (!Array.isArray(transcriptParts) || transcriptParts.length !== record.transcript.parts.length || transcriptParts.some((value, index) => value.index !== record.transcript.parts[index].index || typeof value.text !== 'string')) throw error('转写分段数据无效。');
            transcript = transcriptParts.map(value => value.text).filter(Boolean).join('\n\n');
          }
          if (typeof transcript !== 'string' || transcript.length > 600_000) throw error('转写内容无效或过长。');
          if (WAITING.has(record.transcript.status)) throw error('请等待转写任务结束。', 409, 'voice-busy');
          const previous = record.transcript;
          const parts = transcriptParts ? previous.parts.map((part, index) => ({ ...part, text: transcriptParts[index].text })) : [{ index: 0, start: 0, end: record.durationSeconds, text: transcript, coarse: true }];
          record.transcript = { ...previous, text: transcript, parts, machineParts: previous.machineParts || previous.parts, corrected: true, status: 'ready', revision: previous.revision + 1 };
          if (record.summary.text && !WAITING.has(record.summary.status)) record.summary.status = 'stale';
        }
        if (summary !== undefined || todos !== undefined) {
          if (WAITING.has(record.summary.status)) throw error('请等待摘要任务结束。', 409, 'voice-busy');
          if (summary !== undefined) {
            if (typeof summary !== 'string' || summary.length > 100_000) throw error('摘要内容无效或过长。');
            record.summary.text = summary;
          }
          if (todos !== undefined) record.summary.todos = normalizeTodos(todos);
        }
        record.revision++; return projection(await save(record));
      });
    },
    async close() {
      lifetime.abort('文献库已关闭');
      const id = activeRecording; activeRecording = null;
      if (id) await lock(id, async () => { const record = await load(id); if (record.status === 'recording') { record.status = 'interrupted'; await save(record); } }).catch(() => {});
      await Promise.allSettled([...jobs, ...locks.values()]);
    },
  };
  return api;
}

function normalizeTodos(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map(item => ({ id: typeof item?.id === 'string' ? item.id.slice(0, 100) : randomUUID(), text: String(item?.text || '').trim().slice(0, 1000), done: item?.done === true, ...(Number.isFinite(item?.at) && item.at >= 0 ? { at: item.at } : {}) })).filter(item => item.text);
}
