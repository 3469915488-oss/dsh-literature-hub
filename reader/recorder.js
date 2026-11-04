const SLICE_MS = 5_000;
const MAX_TIME_MS = 4 * 60 * 60 * 1_000;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
const TERMINAL = new Set(['idle', 'saved', 'interrupted', 'error']);

async function encodeBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const strings = [];
  for (let i = 0; i < bytes.length; i += 0x8000) strings.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(strings.join(''));
}
function stopTracks(stream) { for (const track of stream?.getTracks() || []) track.stop(); }
function micError(cause) {
  if (['NotAllowedError', 'SecurityError'].includes(cause?.name)) return '麦克风未授权。请在系统设置的“隐私与安全性 → 麦克风”中允许 DeepSeek Harness。';
  if (cause?.name === 'NotFoundError') return '未找到可用麦克风。';
  if (cause?.name === 'NotReadableError') return '麦克风暂时不可用，请检查输入设备。';
  return cause?.message || '录音未开始。';
}

// Instantiated in the main Harness renderer, where the desktop permission handler permits audio input.
export function createRecorder({ post, onState, mediaDevices = globalThis.navigator?.mediaDevices, Recorder = globalThis.MediaRecorder, now = () => performance.now() } = {}) {
  let state = { state: 'idle', elapsedMs: 0 };
  let instance, sequence = 0, destroyed = false;
  const getState = () => ({ ...state });
  function emit(next) { state = { ...state, ...next }; onState?.(getState()); }
  function elapsed(current) { return Math.round(current.elapsed + (current.started === null ? 0 : Math.max(0, now() - current.started))); }
  function freeze(current) { current.elapsed = elapsed(current); current.started = null; }
  function release(current) {
    clearInterval(current.timer);
    stopTracks(current.stream);
    current.stream = null;
  }
  async function upload(current, blob, seq) {
    const base64 = await encodeBlob(blob);
    for (let attempt = 0; ; attempt++) {
      try { await post('/voice/chunk', { id: current.recording.id, seq, base64 }); return; }
      catch (cause) {
        if (attempt >= 2 || cause?.status >= 400 && cause.status < 500) throw cause;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  function settle(current) {
    if (current.finalizing) return current.finished;
    current.finalizing = true;
    freeze(current);
    release(current);
    (async () => {
      await current.queue.catch(() => {});
      let recording = current.recording;
      const interrupted = current.interrupt || !!current.failure;
      try {
        if (recording) recording = await post(interrupted ? '/voice/interrupt' : '/voice/stop', { id: recording.id });
        const saved = recording?.status === 'saved';
        if (instance === current) {
          emit({ state: saved ? 'saved' : 'interrupted', elapsedMs: current.elapsed, recording, id: recording?.id, message: saved ? '' : current.failure ? '录音写入中断，已保存的分段可恢复。' : recording?.error || '录音已停止，已保存分段可恢复。' });
        }
      } catch (cause) {
        if (instance === current) emit({ state: 'interrupted', elapsedMs: current.elapsed, recording, id: recording?.id, message: '录音暂时无法合并，可在录音列表中恢复。' });
      } finally {
        if (instance === current) instance = null;
        current.complete(getState());
      }
    })();
    return current.finished;
  }
  function end(current, interrupt = false) {
    if (!current || current.finalizing) return current?.finished || Promise.resolve(getState());
    current.interrupt ||= interrupt;
    if (current.stopping) return current.finished;
    current.stopping = true;
    freeze(current);
    emit({ state: 'stopping', elapsedMs: current.elapsed });
    if (current.capture?.state === 'recording' || current.capture?.state === 'paused') {
      try { current.capture.stop(); }
      catch (cause) { current.failure = cause; settle(current); }
      release(current);
    } else if (current.recording) settle(current);
    else if (current.pending) {
      release(current);
      if (!current.allocated) {
        // getUserMedia is not cancellable. Stop a late stream immediately when its promise resolves.
        current.pending = false;
        if (instance === current) { emit({ state: 'interrupted', message: '录音已取消。' }); instance = null; }
        current.complete(getState());
      }
    } else settle(current);
    return current.finished;
  }
  async function start({ docId, title } = {}) {
    if (destroyed || instance || !TERMINAL.has(state.state)) return getState();
    if (!docId) return getState();
    if (!mediaDevices?.getUserMedia || !Recorder) { emit({ state: 'error', docId, message: '当前窗口不支持麦克风录音。' }); return getState(); }
    const current = { token: ++sequence, docId, pending: true, elapsed: 0, started: null, seq: 0, queued: 0, queue: Promise.resolve() };
    current.finished = new Promise(resolve => { current.complete = resolve; });
    instance = current;
    emit({ state: 'requesting', docId, title, id: null, recording: null, elapsedMs: 0, message: '' });
    try {
      const stream = await mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      if (current.stopping || destroyed || instance !== current) { stopTracks(stream); return getState(); }
      current.stream = stream;
      const mimeType = MIME_TYPES.find(type => Recorder.isTypeSupported?.(type));
      current.capture = new Recorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 });
      current.allocated = true;
      current.recording = await post('/voice/start', { docId, title, mimeType: current.capture.mimeType || mimeType || 'audio/webm' });
      current.pending = false;
      if (current.stopping || destroyed || instance !== current) { current.interrupt = true; await settle(current); return getState(); }
      const capture = current.capture;
      capture.addEventListener('dataavailable', event => {
        if (!event.data?.size || current.failure) return;
        const seq = current.seq++;
        if (++current.queued > 12) { current.failure = new Error('录音写入积压'); end(current, true); return; }
        current.queue = current.queue.then(() => upload(current, event.data, seq)).finally(() => { current.queued--; });
        current.queue.catch(cause => { current.failure = cause; end(current, true); });
      });
      capture.addEventListener('stop', () => settle(current), { once: true });
      capture.addEventListener('error', event => { current.failure = event.error || new Error('音频采集中断'); end(current, true); });
      for (const track of stream.getTracks()) track.addEventListener?.('ended', () => {
        if (!current.stopping && !current.finalizing) { current.failure = new Error('麦克风已断开'); end(current, true); }
      });
      capture.start(SLICE_MS);
      current.started = now();
      emit({ state: 'recording', id: current.recording.id, recording: current.recording });
      current.timer = setInterval(() => {
        if (instance !== current || current.stopping) return;
        const elapsedMs = elapsed(current);
        if (elapsedMs >= MAX_TIME_MS) end(current);
        else emit({ elapsedMs });
      }, 250);
    } catch (cause) {
      current.pending = false;
      release(current);
      if (current.recording) { current.failure = cause; current.interrupt = true; await settle(current); }
      else if (instance === current) { instance = null; emit({ state: 'error', message: micError(cause) }); current.complete(getState()); }
    }
    return getState();
  }
  function pause() {
    const current = instance;
    if (current?.capture?.state !== 'recording' || current.stopping) return getState();
    try { current.capture.requestData?.(); current.capture.pause(); freeze(current); emit({ state: 'paused', elapsedMs: current.elapsed }); }
    catch (cause) { current.failure = cause; end(current, true); }
    return getState();
  }
  function resume() {
    const current = instance;
    if (current?.capture?.state !== 'paused' || current.stopping) return getState();
    try { current.capture.resume(); current.started = now(); emit({ state: 'recording' }); }
    catch (cause) { current.failure = cause; end(current, true); }
    return getState();
  }
  return {
    start, stop: () => end(instance), pause, resume, interrupt: () => end(instance, true), getState,
    destroy() { destroyed = true; return end(instance, true); },
  };
}
