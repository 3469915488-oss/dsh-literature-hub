import { readFile, writeFile, mkdir, rename, readdir, stat, lstat, realpath, rm, copyFile, rmdir, link } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, relative, basename, extname, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { readInput, parseDocument, parsePdf, capabilities, fault } from './import.js';
import { createSearch } from './search.js';
import { createVaultFiles, slash, supportedFile } from './vault-files.js';
import { parseNoteContent, serializeNoteContent, legacyNoteFields, splitFrontmatter, tagsFromMarkdown, uniqueTags } from './note-content.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const safeName = value => {
  let name = String(value || '未命名').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || '未命名';
  while (Buffer.byteLength(name) > 150) name = Array.from(name).slice(0, -1).join('');
  return name;
};
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const json = async (path, fallback = null) => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
};
async function atomic(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp, value, { mode: 0o600 }); await rename(temp, path); }
  finally { await rm(temp, { force: true }).catch(() => {}); }
}
const atomicJson = (path, value) => atomic(path, JSON.stringify(value, null, 2) + '\n');

export async function createStore({ vaultPath, resolveAudioAsset } = {}) {
  if (!vaultPath || !String(vaultPath).trim()) throw fault('请先选择 Obsidian 仓库');
  const vault = resolve(vaultPath);
  const info = await stat(vault).catch(() => null);
  if (!info?.isDirectory()) throw fault('Obsidian 仓库目录不存在', 404);
  const vaultReal = await realpath(vault);
  const root = join(vaultReal, '文献库');
  const dirs = { originals: '未分类', texts: '_data/texts', annotations: '_data/annotations', sessions: '_data/sessions', study: '_data/study', previews: '_data/previews', data: '_data' };
  const renameJournal = join(root, dirs.data, 'pending-rename.json');
  const trashJournal = join(root, dirs.data, 'pending-trash.json');
  const fs = createVaultFiles(vaultReal);
  const index = createSearch(vaultReal);
  const tasks = new AbortController();
  let closed = false;
  const active = () => { if (closed) throw fault('文献库已停用', 503, 'store-closed'); };
  let ready;
  async function init() {
    active();
    if (!ready) ready = (async () => {
      await fs.path('文献库', { required: false });
      await mkdir(root, { recursive: true });
      for (const dir of Object.values(dirs)) {
        await fs.path(slash(join('文献库', dir)), { required: false });
        await mkdir(join(root, dir), { recursive: true });
        const actual = await realpath(join(root, dir));
        if (!actual.startsWith(vaultReal + sep)) throw fault('文献库子目录不能指向仓库以外的位置');
      }
      const actualRoot = await realpath(root);
      if (!actualRoot.startsWith(vaultReal + sep)) throw fault('文献库目录不能指向仓库以外的位置');
    })();
    await ready;
    return { vaultPath: vaultReal, root };
  }
  function itemPath(id) {
    if (!/^[a-f0-9-]{36}$/.test(String(id))) throw fault('文献编号无效');
    return join(root, dirs.data, id + '.json');
  }
  function normalize(item) {
    if (!item.schemaVersion || item.schemaVersion < 2) {
      for (const key of ['originalPath', 'pdfPath', 'textPath', 'notePath', 'annotationsPath', 'studyPath']) if (item[key]) item[key] = slash(join('文献库', item[key]));
      for (const session of item.sessions || []) if (session.path) session.path = slash(join('文献库', session.path));
      item.schemaVersion = 2;
      item.legacyLayout = true;
    }
    item.notes ||= { revision: 0, hash: '', blocks: [] };
    item.annotations ||= { items: [], revision: 0 };
    item.annotations.sourceHash ||= item.hash;
    item.previewRevision ??= item.pdfPath ? 1 : 0;
    item.previewHistory ||= item.pdfPath ? [{ revision: item.previewRevision, path: item.pdfPath, pageCount: item.pageCount || item.pages?.length || null, createdAt: item.createdAt }] : [];
    for (const annotation of item.annotations.items) { annotation.documentHash ||= item.annotations.sourceHash; annotation.previewRevision ??= item.previewRevision; }
    item.study ||= { revision: 0 };
    item.sessions ||= [];
    return item;
  }
  async function load(id) {
    const item = await json(await fs.path(slash(relative(vaultReal, itemPath(id))), { required: false }));
    if (!item) throw fault('文献不存在', 404, 'not-found');
    return normalize(item);
  }
  async function store(item) { item.updatedAt = new Date().toISOString(); await atomicJson(await fs.path(slash(relative(vaultReal, itemPath(item.id))), { required: false }), item); }
  async function records() {
    await init();
    const files = await readdir(join(root, dirs.data));
    const out = [];
    for (const name of files.filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
      const record = await json(await fs.path(slash(join('文献库', dirs.data, name)))).catch(() => null);
      if (record) out.push(normalize(record));
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  async function inside(rel, { required = true } = {}) {
    if (!rel) throw fault('文件位置未设置', 404, 'not-found');
    return fs.path(rel, { required });
  }
  async function lock(fn) {
    await init();
    const lockPath = join(root, dirs.data, '.write-lock');
    const start = Date.now();
    for (;;) {
      try { await mkdir(lockPath); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stamp = await stat(lockPath).catch(() => null);
        if (stamp && Date.now() - stamp.mtimeMs > 90_000) { await rm(lockPath, { recursive: true, force: true }); continue; }
        if (Date.now() - start > 15_000) throw fault('资料正在保存，请稍后重试', 409, 'store-busy');
        await new Promise(done => setTimeout(done, 25));
      }
    }
    try { active(); await recoverRename(); await recoverTrash(); return await fn(); }
    finally { await rm(lockPath, { recursive: true, force: true }); }
  }
  async function noteState(item) {
    const path = item.notePath ? await inside(item.notePath, { required: false }) : null;
    const disk = path ? await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : null;
    const text = disk ?? '';
    const digest = hash(text);
    const parsed = parseNoteContent(text);
    const changed = path && digest !== item.notes.hash;
    const annotationRevision = item.annotations.revision;
    syncAnnotationNotes(item, parsed.content, changed && disk !== null ? item.notes.blocks || [] : []);
    if (changed) {
      item.notes = { ...item.notes, blocks: parsed.blocks, freeText: parsed.freeText, hash: digest, revision: (item.notes.revision || 0) + 1 };
    }
    if (item.annotations.revision !== annotationRevision) await writeAnnotationMirror(item);
    if (changed || item.annotations.revision !== annotationRevision) await store(item);
    const content = projectAnnotations(item, parsed.content);
    return { text, frontmatter: parsed.frontmatter, content, ...legacyNoteFields(content, parsed.frontmatter), formatVersion: 2, revision: item.notes.revision || 0, path: item.notePath || null, createdDate: item.notes.createdDate || null };
  }
  function referenceFor(item, annotation) {
    const page = annotation.page || (annotation.pageIndex !== undefined ? annotation.pageIndex + 1 : undefined);
    const label = { draw: '勾画', highlight: '高亮', underline: '下划线' }[annotation.type || annotation.kind] || '批注';
    const quote = String(annotation.anchor?.quote || annotation.text || `${page ? `第 ${page} 页 · ` : ''}${label}`);
    const id = annotation.noteId || `a-${hash(String(annotation.id || quote)).slice(0, 32)}`;
    const anchor = { ...annotation.anchor, ...(annotation.rects?.length ? { rects: annotation.rects } : {}), ...(annotation.points?.length ? { points: annotation.points } : {}) };
    return {
      kind: 'quote', id, noteId: id, annotationId: annotation.id, quote, text: String(annotation.note || ''),
      anchor, page,
      previewRevision: annotation.previewRevision, documentHash: annotation.documentHash || item.hash,
      createdAt: annotation.createdAt || item.createdAt, updatedAt: annotation.updatedAt,
    };
  }
  function projectAnnotations(item, content) {
    const references = content.filter(node => node.kind === 'quote');
    const linked = new Set(references.map(node => node.annotationId).filter(Boolean));
    const ids = new Set(references.map(node => node.id));
    const projected = [];
    for (const annotation of item.annotations.items) {
      if (annotation.noteSuppressed || linked.has(annotation.id) || ids.has(annotation.noteId)) continue;
      const node = referenceFor(item, annotation);
      if (node && !ids.has(node.id)) { projected.push(node); ids.add(node.id); }
    }
    return [...content, ...projected];
  }
  function syncAnnotationNotes(item, content, previous = []) {
    let changed = false;
    const references = content.filter(node => node.kind === 'quote');
    const byId = new Map(references.map(node => [node.id, node]));
    const byAnnotation = new Map(references.filter(node => node.annotationId).map(node => [node.annotationId, node]));
    const previousIds = new Set(previous.map(node => node.id));
    const previousLinks = new Set(previous.map(node => node.annotationId).filter(Boolean));
    item.annotations.items = item.annotations.items.filter(annotation => {
      const node = byAnnotation.get(annotation.id) || byId.get(annotation.noteId);
      if (node) {
        if (annotation.noteId !== node.id || annotation.note !== node.text || annotation.noteSuppressed) {
          annotation.noteId = node.id;
          annotation.note = node.text;
          delete annotation.noteSuppressed;
          changed = true;
        }
        return true;
      }
      const removed = previousLinks.has(annotation.id) || previousIds.has(annotation.noteId);
      changed ||= removed;
      return !removed;
    });
    if (changed) item.annotations.revision++;
  }
  async function refreshSource(item) {
    const original = await inside(item.originalPath);
    const info = await stat(original), stamp = `${info.mtimeMs}:${info.size}`;
    if (item.fileStamp === stamp) return;
    const bytes = await readFile(original);
    const digest = hash(bytes);
    item.fileStamp = stamp;
    if (digest === item.hash) return;
    item.fileRevision = (item.fileRevision || 1) + 1;
    item.previousHashes = [...new Set([...(item.previousHashes || []), item.hash])];
    if (['markdown', 'text'].includes(item.type)) {
      const parsed = await parseDocument({ bytes, name: basename(item.originalPath), originalPath: original, signal: tasks.signal });
      Object.assign(item, parsedFields(parsed));
    } else item.parseStatus = 'changed';
    item.hash = digest;
    item.metadataRevision = (item.metadataRevision || 0) + 1;
    await store(item);
  }
  async function document(item) {
    active();
    await refreshSource(item);
    const notes = await noteState(item);
    return {
      id: item.id, title: item.title, type: item.type, source: item.source, tags: item.tags || [], hash: item.hash, metadata: item.metadata || {}, metadataRevision: item.metadataRevision || 0, parseStatus: item.parseStatus || 'ready',
      originalPath: await inside(item.originalPath), pdfPath: item.pdfPath ? await inside(item.pdfPath) : null,
      path: item.originalPath, folder: slash(dirname(item.originalPath)) === '.' ? '' : slash(dirname(item.originalPath)), name: basename(item.originalPath), registered: !!item.registered,
      text: item.text, markdown: item.markdown, blocks: item.blocks, body: item.body, parseDetails: item.parseDetails, previewRevision: item.previewRevision || 0, previewHistory: item.previewHistory || [], preview: item.preview, pageCount: item.pageCount, pages: item.pages, ocr: item.ocr, warnings: item.warnings || [], fileRevision: item.fileRevision || 1,
      notes, annotations: { ...item.annotations, stale: !!item.annotations.sourceHash && item.annotations.sourceHash !== item.hash, items: item.annotations.items.map(annotation => ({ ...annotation, stale: (annotation.documentHash || item.annotations.sourceHash) !== item.hash || ((annotation.rects?.length || annotation.points?.length) && annotation.previewRevision !== item.previewRevision) || false })) }, progress: item.progress || { page: 1, zoom: 1 },
      study: item.study || { revision: 0 }, sessions: item.sessions || [], createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  }
  function checkRevision(actual, expected) {
    if (expected !== undefined && expected !== null && Number(expected) !== actual) {
      throw Object.assign(fault('内容已被其他窗口或 Obsidian 修改，请刷新后保存', 409, 'revision-conflict'), { revision: actual });
    }
  }
  const header = item => `---\ndocument_id: ${item.id}\ntitle: ${JSON.stringify(item.title)}\ntags: ${JSON.stringify(item.tags || [])}\nsource: ${JSON.stringify(item.source)}\n---\n\n`;
  function patchFrontmatter(text, item, changedFields) {
    const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) return header(item) + text;
    const lines = match[1].split(/\r?\n/), result = [];
    const values = { title: JSON.stringify(item.title), tags: JSON.stringify(item.tags || []) };
    const updates = Object.fromEntries(changedFields.map(field => [field, values[field]]));
    const written = new Set();
    for (let i = 0; i < lines.length; i++) {
      const field = /^(title|tags):/.exec(lines[i])?.[1];
      if (!field || !Object.hasOwn(updates, field)) { result.push(lines[i]); continue; }
      if (!written.has(field)) { result.push(`${field}: ${updates[field]}`); written.add(field); }
      while (i + 1 < lines.length && /^(?:\s+\S|\s*-\s)/.test(lines[i + 1])) i++;
    }
    for (const key of Object.keys(updates)) if (!written.has(key)) result.push(`${key}: ${updates[key]}`);
    const nl = match[0].includes('\r\n') ? '\r\n' : '\n';
    const bom = match[0].startsWith('\uFEFF') ? '\uFEFF' : '';
    return `${bom}---${nl}${result.join(nl)}${nl}---${nl}` + text.slice(match[0].length);
  }
  async function writeManaged(path, content, item, key) {
    const abs = await inside(path, { required: false });
    const previous = await readFile(abs, 'utf8').catch(() => null);
    if (previous !== null && item.generatedHashes?.[key] && hash(previous) !== item.generatedHashes[key]) {
      // Keep externally edited Markdown intact, including edits to an older generated copy.
      item.generatedCopies ||= {};
      let alternate = item.generatedCopies[key]?.path || abs.replace(/\.md$/i, '.generated.md');
      alternate = await fs.path(slash(relative(vaultReal, resolve(alternate))), { required: false });
      const oldAlternate = await readFile(alternate, 'utf8').catch(() => null);
      if (oldAlternate !== null && hash(oldAlternate) !== item.generatedCopies[key]?.hash) {
        alternate = abs.replace(/\.md$/i, `.generated-${Date.now()}-${randomUUID().slice(0, 8)}.md`);
      }
      await atomic(alternate, content);
      item.generatedCopies[key] = { path: alternate, hash: hash(content) };
      return;
    }
    await atomic(abs, content);
    item.generatedHashes ||= {};
    item.generatedHashes[key] = hash(content);
  }
  async function writeAnnotationMirror(item) {
    item.annotationsPath ||= internalPath('annotations', item.id + '.md');
    const markdown = header(item) + `# ${item.title} · 批注\n\n` + item.annotations.items.map(annotation => {
      const quote = annotation.text || annotation.anchor?.quote;
      return `## 第 ${annotation.page || ((annotation.pageIndex ?? 0) + 1)} 页 · ${annotation.type || annotation.kind || '高亮'}\n\n${quote ? '> ' + String(quote).replace(/\n/g, '\n> ') + '\n\n' : ''}${annotation.note || ''}\n\n<!-- annotation:${annotation.id} -->\n`;
    }).join('\n');
    await writeManaged(item.annotationsPath, markdown, item, 'annotations');
  }
  const internalPath = (dir, name) => slash(join('文献库', dirs[dir], name));
  const noteFilename = (stem, date) => fs.name(`${stem}笔记${date}.md`);
  const parsedFields = parsed => ({ text: parsed.text || '', markdown: parsed.markdown, blocks: parsed.blocks, body: parsed.body, preview: parsed.preview, pageCount: parsed.pageCount, parseDetails: parsed.parseDetails || { body: parsed.body && { status: parsed.body.status, engine: parsed.body.engine, pageMapping: parsed.body.pageMapping }, preview: parsed.preview, pageCount: parsed.pageCount, ocr: parsed.ocr?.pages || [] }, pages: parsed.pages || [], ocr: parsed.ocr, warnings: parsed.warnings || [] });
  const bodyMarkdown = item => header(item) + `# ${item.title}\n\n` + (item.markdown || item.body?.markdown || (item.pages || []).map(p => `## 第 ${p.page} 页\n\n${p.text}\n`).join('\n'));
  async function copyVerified(source, target, digest) {
    await mkdir(dirname(target), { recursive: true });
    try { await copyFile(source, target, constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (hash(await readFile(target)) !== digest) throw fault('目标位置已有不同内容的文件', 409, 'destination-exists');
    }
    if (hash(await readFile(target)) !== digest) throw fault('文件复制校验失败', 500, 'copy-verification-failed');
  }
  async function noteDestination(item) {
    if (item.notePath) return await inside(item.notePath, { required: false });
    const date = today();
    const stem = basename(item.originalPath, extname(item.originalPath));
    const rel = slash(join(dirname(item.originalPath), noteFilename(stem, date)));
    const target = await inside(rel, { required: false });
    if (await stat(target).catch(() => null)) throw fault('同目录已有同名笔记，请先重命名该文件', 409, 'note-name-conflict');
    item.notePath = rel;
    item.notes.createdDate = date;
    return target;
  }
  async function audioAsset(id, assetId) {
    const asset = await resolveAudioAsset?.({ id, assetId });
    if (!asset?.path) return null;
    return { ...asset, path: fs.relativePath(asset.path), transcriptPath: asset.transcriptPath ? fs.relativePath(asset.transcriptPath) : undefined };
  }
  const renderNote = (item, content, frontmatter) => serializeNoteContent(content, { frontmatter, originalPath: item.originalPath, notePath: item.notePath, resolveAudioAsset: assetId => audioAsset(item.id, assetId) });
  async function normalizeNoteContent(item, nodes, previous) {
    if (!Array.isArray(nodes) || nodes.length > 10_000) throw fault('笔记段落数据无效');
    const ids = new Set(), linked = new Set(), byId = new Map(previous.filter(node => node.id).map(node => [node.id, node]));
    const byAnnotation = new Map(item.annotations.items.map(annotation => [annotation.id, annotation]));
    const result = [];
    for (const node of nodes) {
      if (node?.kind === 'markdown' && typeof node.markdown === 'string') { result.push({ kind: 'markdown', markdown: node.markdown }); continue; }
      if (!node || !['quote', 'audio'].includes(node.kind)) throw fault('笔记包含无效段落');
      const id = String(node.id || node.noteId || randomUUID());
      if (ids.has(id) || id.length > 200) throw fault('笔记编号重复或无效');
      ids.add(id);
      const old = byId.get(id);
      if (node.kind === 'audio') {
        const assetId = node.assetId;
        if (typeof assetId !== 'string' || !/^[\w-]{1,200}$/.test(assetId)) throw fault('录音编号无效');
        if ((old?.kind !== 'audio' || old.assetId !== assetId) && !await audioAsset(item.id, assetId)) throw fault('找不到此文献的录音', 404, 'audio-not-found');
        result.push({ kind: 'audio', id, assetId, assetMarkdown: old?.kind === 'audio' && old.assetId === assetId ? old.assetMarkdown : undefined });
        continue;
      }
      const prior = old?.kind === 'quote' ? old : undefined;
      const annotation = byAnnotation.get(prior ? prior.annotationId : node.annotationId);
      const origin = prior || (annotation && referenceFor(item, annotation)) || {};
      const annotationId = prior?.annotationId || annotation?.id;
      if (annotationId && linked.has(annotationId)) throw fault('同一批注不能关联多条笔记');
      if (annotationId) linked.add(annotationId);
      const quote = String(node.quote ?? origin.quote ?? ''), text = String(node.text ?? origin.text ?? '');
      const updatedAt = prior?.quote === quote && prior?.text === text ? prior.updatedAt : new Date().toISOString();
      result.push({ ...origin, kind: 'quote', id, noteId: id, annotationId, quote, text, createdAt: origin.createdAt || new Date().toISOString(), updatedAt });
    }
    return result;
  }
  function legacyNoteUpdate(current, { text, freeText, blocks }) {
    if (text !== undefined && typeof text !== 'string') throw fault('笔记内容必须是文本');
    const raw = text === undefined ? null : parseNoteContent(text);
    if (raw?.content.some(node => node.kind !== 'markdown')) {
      const supplied = new Set(raw.content.map(node => node.id).filter(Boolean));
      const retained = current.content.filter(node => node.kind !== 'markdown' && !supplied.has(node.id));
      return { content: [...raw.content, ...retained], frontmatter: raw.frontmatter || current.frontmatter };
    }
    const plain = text ?? freeText;
    const frontmatter = plain === undefined ? current.frontmatter : splitFrontmatter(String(plain)).frontmatter || current.frontmatter;
    let content = [...current.content];
    if (plain !== undefined && String(plain).trimEnd() !== current.freeText) {
      const { body } = splitFrontmatter(String(plain));
      const prose = content.map((node, index) => node.kind === 'markdown' && node.markdown.trim() ? index : -1).filter(index => index >= 0);
      if (prose.length > 1) throw fault('笔记已有分段排版，请使用统一编辑器保存全文', 409, 'note-format-conflict');
      if (prose.length === 1) content[prose[0]] = { kind: 'markdown', markdown: body };
      else content.unshift({ kind: 'markdown', markdown: body });
    }
    if (blocks !== undefined) {
      if (!Array.isArray(blocks)) throw fault('笔记段落数据无效');
      const replacements = new Map(blocks.map(block => {
        if (!block || typeof block !== 'object') throw fault('笔记段落数据无效');
        const id = String(block.id || block.noteId || randomUUID());
        return [id, { ...block, kind: 'quote', id }];
      }));
      if (replacements.size !== blocks.length) throw fault('笔记编号重复或无效');
      content = content.flatMap(node => {
        if (node.kind !== 'quote') return [node];
        const replacement = replacements.get(node.id);
        replacements.delete(node.id);
        return replacement ? [replacement] : [];
      });
      content.push(...replacements.values());
    }
    return { content, frontmatter };
  }
  async function persistNotes(item, content, frontmatter, current, { sync = true } = {}) {
    const existing = !!item.notePath;
    const target = await noteDestination(item);
    const text = await renderNote(item, content, frontmatter);
    if (existing) {
      const actual = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      if (hash(actual) !== hash(current.text)) throw fault('笔记在保存期间被修改，请刷新后保存', 409, 'revision-conflict');
      await atomic(target, text);
    } else {
      try { await writeFile(target, text, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code === 'EEXIST') throw fault('同目录已有同名笔记', 409, 'note-name-conflict'); throw error; }
    }
    item.notes = { ...item.notes, hash: hash(text), revision: current.revision + 1, formatVersion: 2, ...legacyNoteFields(content, frontmatter) };
    if (sync) syncAnnotationNotes(item, content, current.blocks);
  }
  function annotationForSave(item, annotation, previous) {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) throw fault('批注数据无效');
    if (annotation.tags !== undefined && (!Array.isArray(annotation.tags) || annotation.tags.length > 100 || annotation.tags.some(tag => typeof tag !== 'string' || tag.length > 100))) throw fault('批注标签应为不超过 100 项的文本数组');
    const note = annotation.note === undefined ? previous?.note : String(annotation.note);
    return {
      ...annotation, id: String(annotation.id || randomUUID()),
      tags: annotation.tags === undefined ? previous?.tags : uniqueTags(annotation.tags),
      noteId: previous?.noteId || annotation.noteId, note,
      noteSuppressed: previous?.noteSuppressed && note === previous.note ? true : undefined,
      updatedAt: annotation.updatedAt || new Date().toISOString(),
      documentHash: previous?.documentHash || annotation.documentHash || item.hash,
      previewRevision: previous?.previewRevision ?? annotation.previewRevision ?? item.previewRevision,
    };
  }
  async function parseInput(input, originalPath, pdfPath) {
    active();
    try {
      if (input.bytes.subarray(0, 5).toString() === '%PDF-' || extname(input.name).toLowerCase() === '.pdf') {
        const parsed = await parsePdf(originalPath, { signal: tasks.signal });
        return { type: 'pdf', pdfPath: originalPath, ...parsed, preview: { status: 'ready', engine: 'original', quality: 'original', pageCount: parsed.pageCount, warnings: [] } };
      }
      return await parseDocument({ ...input, originalPath, pdfOutputPath: pdfPath, signal: tasks.signal });
    }
    catch (error) {
      active();
      if (tasks.signal.aborted || error.name === 'AbortError') throw error;
      if (pdfPath && pdfPath !== originalPath) await rm(pdfPath, { force: true });
      const ext = extname(input.name).toLowerCase();
      return { type: ext === '.pdf' ? 'pdf' : ['.doc', '.docx', '.odt', '.rtf', '.ppt', '.pptx'].includes(ext) ? 'document' : 'text', pdfPath: ext === '.pdf' ? originalPath : null, text: '', pages: [], ocr: { used: false, words: [], errors: [] }, warnings: [`正文解析失败，原件已保留：${error.message}`], parseStatus: 'failed' };
    }
  }
  function newItem(id, input, options, originalPath, pdfRelative, parsed, digest) {
    return {
      schemaVersion: 2, id, title: safeName(options.title || options.metadata?.title || basename(input.name, extname(input.name))),
      type: parsed.type, source: input.source, tags: Array.isArray(options.tags) ? uniqueTags(options.tags) : [], hash: digest, metadata: options.metadata || {}, parseStatus: parsed.parseStatus || 'ready',
      originalPath, pdfPath: parsed.pdfPath ? pdfRelative : null, textPath: internalPath('texts', id + '.md'), notePath: null,
      annotationsPath: internalPath('annotations', id + '.md'), studyPath: internalPath('study', id + '.md'), ...parsedFields(parsed),
      notes: { revision: 0, hash: '', blocks: [] }, annotations: { items: [], revision: 0, sourceHash: digest }, progress: { page: 1, zoom: 1 }, study: { revision: 0 }, sessions: [], fileRevision: 1, previewRevision: parsed.pdfPath ? 1 : 0,
      previewHistory: parsed.pdfPath ? [{ revision: 1, path: pdfRelative, pageCount: parsed.pageCount || parsed.pages?.length || null, createdAt: new Date().toISOString() }] : [],
      createdAt: new Date().toISOString(), generatedHashes: {}, registered: !!options.registered,
    };
  }
  async function importBytes(input, options = {}) {
    await init();
    const folder = fs.relativePath(options.folder ?? options.destination ?? '文献库/未分类');
    await fs.directory(folder);
    const digest = hash(input.bytes);
    const duplicate = await lock(async () => {
      const item = (await records()).find(r => r.hash === digest);
      if (item && (options.metadata || options.tags)) {
        item.metadata = { ...item.metadata, ...options.metadata };
        item.tags = uniqueTags([...(item.tags || []), ...(Array.isArray(options.tags) ? options.tags : [])]);
        await store(item);
      }
      return item ? { ...(await document(item)), duplicate: true } : null;
    });
    if (duplicate) return options.retry && duplicate.parseStatus === 'failed' ? api.reparse(duplicate.id) : duplicate;
    const id = randomUUID();
    const ext = input.bytes.subarray(0, 5).toString() === '%PDF-' ? '.pdf' : extname(input.name).toLowerCase() || '.txt';
    const base = safeName(basename(input.name, extname(input.name)));
    let originalPath = slash(join(folder, base + ext));
    if (await stat(await inside(originalPath, { required: false })).catch(() => null)) originalPath = slash(join(folder, `${base}--${id.slice(0, 8)}${ext}`));
    const absOriginal = await inside(originalPath, { required: false });
    try { await writeFile(absOriginal, input.bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      originalPath = slash(join(folder, `${base}--${id}${ext}`));
      await writeFile(await inside(originalPath, { required: false }), input.bytes, { flag: 'wx', mode: 0o600 });
    }
    const originalAbsolute = await inside(originalPath);
    if (hash(await readFile(originalAbsolute)) !== digest) throw fault('原件复制校验失败，请重新导入', 500, 'copy-verification-failed');
    const pdfRelative = ext === '.pdf' ? originalPath : internalPath('previews', id + '.pdf');
    const parsed = await parseInput(input, originalAbsolute, await inside(pdfRelative, { required: false }));
    const item = newItem(id, input, options, originalPath, pdfRelative, parsed, digest);
    return await lock(async () => {
      const existing = (await records()).find(r => r.hash === digest);
      if (existing) {
        await rm(originalAbsolute, { force: true });
        if (parsed.pdfPath && parsed.pdfPath !== originalAbsolute) await rm(parsed.pdfPath, { force: true });
        return { ...(await document(existing)), duplicate: true };
      }
      const content = bodyMarkdown(item);
      await atomic(await inside(item.textPath, { required: false }), content);
      item.generatedHashes.text = hash(content);
      await store(item);
      return document(item);
    });
  }
  function normalizeArgs(value, rest, key) {
    return typeof value === 'string' ? { id: value, ...(key ? { [key]: rest } : rest || {}) } : value || {};
  }
  const summary = ({ id, title, type, source, tags, metadata, metadataRevision = 0, parseStatus, progress, createdAt, updatedAt, hash: digest, warnings, sessions, originalPath, notePath, registered }) => ({ id, title, type, source, tags, metadata, metadataRevision, parseStatus, progress, createdAt, updatedAt, hash: digest, warnings, path: originalPath, folder: slash(dirname(originalPath)) === '.' ? '' : slash(dirname(originalPath)), name: basename(originalPath), notePath, registered: !!registered, sessions: (sessions || []).map(({ messages, transcript, ...session }) => session) });
  function remapItem(item, source, destination) {
    const changed = value => value === source || value?.startsWith(source + '/') ? destination + value.slice(source.length) : value;
    for (const key of ['originalPath', 'pdfPath', 'textPath', 'notePath', 'annotationsPath', 'studyPath']) if (item[key]) item[key] = changed(item[key]);
    for (const session of item.sessions || []) if (session.path) session.path = changed(session.path);
    for (const preview of item.previewHistory || []) if (preview.path) preview.path = changed(preview.path);
    if (item.source?.type === 'vault' && item.source.path) item.source.path = changed(item.source.path);
  }
  async function transactionFile(rel) {
    await inside(rel, { required: false });
    return join(vaultReal, fs.relativePath(rel));
  }
  async function fileDigest(path) {
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return info?.isFile() ? hash(await readFile(path)) : null;
  }
  async function fileIdentity(path) {
    const info = await lstat(path, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return info?.isFile() ? `${info.dev}:${info.ino}` : null;
  }
  async function settleFileTransfer(files, committed) {
    for (const entry of files) {
      const original = await transactionFile(entry.from), destination = await transactionFile(entry.to), temp = await transactionFile(entry.temp);
      if (committed) {
        // An Obsidian edit after the commit belongs to the user and is kept in place.
        if (await fileDigest(destination) === entry.nextHash && await fileDigest(original) === entry.hash &&
          (!entry.identity || await fileIdentity(original) === entry.identity)) await rm(original);
      } else {
        const before = await lstat(temp).catch(() => null), after = await lstat(destination).catch(() => null);
        if (before?.isFile() && after?.isFile() && before.dev === after.dev && before.ino === after.ino) await rm(destination);
      }
      await rm(temp, { force: true });
    }
  }
  async function recoverRename() {
    const pending = await json(renameJournal);
    if (!pending) return;
    const record = await load(pending.id).catch(error => { if (error.status === 404) return null; throw error; });
    const committed = record?.originalPath === pending.next && record.metadataRevision === pending.revision;
    await settleFileTransfer(pending.files, committed);
    await rm(renameJournal, { force: true });
  }
  const trashPath = (id, file) => {
    itemPath(id);
    return internalPath('data', join('trash', id, file));
  };
  const trashFilename = (key, item) => ({ original: 'original' + extname(item.originalPath), note: 'note.md', record: 'record.json' })[key];
  const trashedSummary = ({ id, title, originalPath, deletedAt }) => ({ id, title, originalPath, deletedAt });
  async function recoverTrash() {
    const pending = await json(trashJournal);
    if (!pending) return;
    await settleFileTransfer(pending.files, pending.committed);
    const manifest = await transactionFile(trashPath(pending.entry.id, 'entry.json'));
    if (pending.committed && pending.action === 'delete') await atomicJson(manifest, pending.entry);
    if (pending.committed && pending.action === 'restore') await rm(manifest, { force: true });
    await rm(trashJournal, { force: true });
    if (pending.action === 'restore' ? pending.committed : !pending.committed) await rmdir(dirname(manifest)).catch(() => {});
    index.invalidate();
  }
  async function transferTrash(action, entry, item) {
    const targets = { original: item.originalPath, note: item.notePath, record: slash(relative(vaultReal, itemPath(item.id))) };
    const operation = randomUUID();
    const files = [];
    for (const { key, hash: digest } of entry.files) {
      const archive = trashPath(entry.id, trashFilename(key, item)), original = targets[key];
      const [from, to] = action === 'delete' ? [original, archive] : [archive, original];
      const source = await transactionFile(from), destination = await transactionFile(to);
      if (await inside(from) !== source) throw fault('不能移动符号链接文件', 403, 'unsafe-path');
      if (await lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw fault('目标位置已有文件，请先移走同名文件', 409, 'destination-exists');
      if (await inside(slash(dirname(to))) !== dirname(destination)) throw fault('不能写入符号链接目录', 403, 'unsafe-path');
      if (await fileDigest(source) !== digest) throw fault('文件已修改，请刷新后重试', 409, 'revision-conflict');
      files.push({ from, to, temp: slash(join(dirname(to), `.${operation}-${key}.trash.tmp`)), hash: digest, nextHash: digest, identity: await fileIdentity(source) });
    }
    const pending = { action, entry, files, committed: false };
    await atomicJson(trashJournal, pending);
    try {
      for (const file of files) {
        const temp = await transactionFile(file.temp);
        await copyFile(await transactionFile(file.from), temp, constants.COPYFILE_EXCL);
        if (await fileDigest(temp) !== file.hash) throw fault('文件在移动期间被修改，请刷新后重试', 409, 'revision-conflict');
        try { await link(temp, await transactionFile(file.to)); }
        catch (error) { if (error.code === 'EEXIST') throw fault('目标位置已有文件，请先移走同名文件', 409, 'destination-exists'); throw error; }
      }
      for (const file of files) {
        const source = await transactionFile(file.from);
        if (await fileDigest(source) !== file.hash || await fileIdentity(source) !== file.identity) throw fault('文件在移动期间被修改，请刷新后重试', 409, 'revision-conflict');
      }
      await atomicJson(trashJournal, { ...pending, committed: true });
    } finally { await recoverTrash(); }
  }
  async function deleteDocumentUnlocked({ id, expectedRevision, expectedHash, expectedNotesRevision, expectedAnnotationsRevision } = {}) {
    const item = await load(id);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw fault('删除前请读取文献版本', 400, 'metadata-revision-required');
    checkRevision(item.metadataRevision || 0, expectedRevision);
    const originalHash = await fileDigest(await transactionFile(item.originalPath));
    if (!originalHash) throw fault('原件已移走或删除', 404, 'not-found');
    if (originalHash !== item.hash || expectedHash !== undefined && expectedHash !== originalHash) throw fault('原件已修改，请刷新后重试', 409, 'revision-conflict');
    const notes = await noteState(item);
    checkRevision(notes.revision, expectedNotesRevision);
    checkRevision(item.annotations.revision, expectedAnnotationsRevision);
    const files = [{ key: 'original', hash: originalHash }];
    if (item.notePath) {
      const noteHash = await fileDigest(await transactionFile(item.notePath));
      if (noteHash && noteHash !== hash(notes.text)) throw fault('笔记已修改，请刷新后重试', 409, 'revision-conflict');
      if (noteHash) files.push({ key: 'note', hash: noteHash });
    }
    files.push({ key: 'record', hash: await fileDigest(itemPath(id)) });
    const entry = { id, title: item.title, originalPath: item.originalPath, deletedAt: new Date().toISOString(), files };
    const folder = dirname(await transactionFile(trashPath(id, 'entry.json')));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await transferTrash('delete', entry, item);
    return trashedSummary(entry);
  }
  async function restoreDocumentUnlocked({ id } = {}) {
    const entry = await json(await transactionFile(trashPath(id, 'entry.json')));
    const record = await json(await transactionFile(trashPath(id, 'record.json')));
    if (!entry || !record || record.id !== id || entry.id !== id) throw fault('回收区中没有这份文献', 404, 'not-found');
    const item = normalize(record);
    const keys = new Set(Array.isArray(entry.files) ? entry.files.map(file => file?.key) : []);
    const allowed = item.notePath ? ['original', 'record', 'note'] : ['original', 'record'];
    if (!keys.has('original') || !keys.has('record') || keys.size !== entry.files.length || entry.originalPath !== item.originalPath ||
      entry.files.some(file => !file || !/^[a-f0-9]{64}$/.test(file.hash) || !allowed.includes(file.key))) {
      throw fault('回收区记录不完整，文件已保留', 409, 'trash-invalid');
    }
    await transferTrash('restore', entry, item);
    await refreshSource(item);
    item.metadataRevision = (item.metadataRevision || 0) + 1;
    await store(item);
    return document(item);
  }
  async function renameDocumentUnlocked({ id, name, expectedRevision } = {}) {
    const item = await load(id);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw fault('命名前请读取文献版本', 400, 'metadata-revision-required');
    checkRevision(item.metadataRevision || 0, expectedRevision);
    const currentNotes = await noteState(item);
    const title = fs.name(name);
    const folder = dirname(item.originalPath), ext = extname(item.originalPath);
    const next = slash(join(folder, fs.name(title + ext)));
    if (next === item.originalPath && title === item.title) return document(item);
    const previous = item.originalPath, oldNote = item.notePath;
    const nextNote = oldNote ? slash(join(folder, noteFilename(title, item.notes.createdDate || today()))) : null;
    const source = await transactionFile(previous);
    const operation = randomUUID();
    const files = [];
    async function stage(from, to, text, expectedHash) {
      if (!from || from === to) return;
      const original = await transactionFile(from), destination = await transactionFile(to);
      if (await lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw fault(from === oldNote ? '同目录已有同名笔记' : '同目录已有同名文件', 409, from === oldNote ? 'note-name-conflict' : 'destination-exists');
      const digest = await fileDigest(original);
      if (!digest) {
        if (from === oldNote) return;
        throw fault('原件已移走或删除', 404, 'not-found');
      }
      if (expectedHash && digest !== expectedHash) throw fault('笔记在改名期间被修改，请刷新后重试', 409, 'revision-conflict');
      files.push({ from, to, temp: slash(join(dirname(to), `.${operation}-${files.length}.rename.tmp`)), hash: digest, nextHash: text === undefined ? digest : hash(text), text });
    }
    remapItem(item, previous, next);
    item.notePath = nextNote;
    item.metadata = { ...item.metadata, title: item.metadata?.title || item.title };
    item.title = title;
    item.metadataRevision = expectedRevision + 1;
    await stage(previous, next);
    if (oldNote && nextNote !== oldNote) {
      const text = currentNotes.content.some(node => node.kind !== 'markdown') ? await renderNote(item, currentNotes.content, currentNotes.frontmatter) : currentNotes.text;
      await stage(oldNote, nextNote, text, hash(currentNotes.text));
      if (hash(text) !== hash(currentNotes.text)) item.notes = { ...item.notes, ...legacyNoteFields(currentNotes.content, currentNotes.frontmatter), hash: hash(text), revision: currentNotes.revision + 1 };
    }
    if (!files.length) { await store(item); return document(item); }
    await atomicJson(renameJournal, { id, next, revision: item.metadataRevision, files: files.map(({ text, ...entry }) => entry) });
    try {
      for (const file of files) {
        const temp = await transactionFile(file.temp), original = file.from === previous ? source : await transactionFile(file.from);
        if (file.text === undefined) await copyFile(original, temp, constants.COPYFILE_EXCL);
        else await writeFile(temp, file.text, { flag: 'wx', mode: 0o600 });
        if (await fileDigest(temp) !== file.nextHash) throw fault('改名副本校验失败', 500, 'copy-verification-failed');
        try { await link(temp, await transactionFile(file.to)); }
        catch (error) { if (error.code === 'EEXIST') throw fault('改名目标已被占用', 409, 'destination-exists'); throw error; }
      }
      for (const file of files) if (await fileDigest(await transactionFile(file.from)) !== file.hash) throw fault('原文件在改名期间被修改，请刷新后重试', 409, 'revision-conflict');
      await store(item);
    } finally { await recoverRename(); }
    index.invalidate();
    return document(item);
  }
  async function moveDocumentUnlocked({ id, destination, name }) {
    const item = await load(id);
    const currentNotes = await noteState(item);
    const folder = fs.relativePath(destination ?? (dirname(item.originalPath) === '.' ? '' : dirname(item.originalPath)));
    await fs.directory(folder);
    const filename = name === undefined ? basename(item.originalPath) : fs.name(name);
    if (extname(filename).toLowerCase() !== extname(item.originalPath).toLowerCase()) throw fault('重命名时请保留文件扩展名', 400, 'file-extension');
    const next = slash(join(folder, filename));
    if (next === item.originalPath) return document(item);
    const old = item.originalPath, source = await inside(old), target = await inside(next, { required: false });
    if (await stat(target).catch(() => null)) throw fault('目标位置已有同名文件', 409, 'destination-exists');
    const oldNote = item.notePath;
    const nextNote = oldNote ? slash(join(folder, noteFilename(basename(filename, extname(filename)), item.notes.createdDate || today()))) : null;
    if (nextNote && nextNote !== oldNote && await stat(await inside(nextNote, { required: false })).catch(() => null)) throw fault('目标位置已有同名笔记', 409, 'note-name-conflict');
    const bytes = await readFile(source);
    const digest = hash(bytes);
    await copyVerified(source, target, digest);
    if (oldNote && nextNote !== oldNote) {
      const noteSource = await inside(oldNote), noteBytes = await readFile(noteSource);
      await copyVerified(noteSource, await inside(nextNote, { required: false }), hash(noteBytes));
    }
    if (hash(await readFile(source)) !== digest || (oldNote && hash(await readFile(await inside(oldNote))) !== hash(currentNotes.text))) {
      await rm(target);
      if (oldNote && nextNote !== oldNote) await rm(await inside(nextNote));
      throw fault('文件在移动期间被修改，已保留原件，请刷新后重试', 409, 'revision-conflict');
    }
    item.originalPath = next;
    if (item.source?.type === 'vault') item.source.path = next;
    if (item.pdfPath === old) item.pdfPath = next;
    for (const preview of item.previewHistory || []) if (preview.path === old) preview.path = next;
    if (nextNote) item.notePath = nextNote;
    if (nextNote && currentNotes.content.some(node => node.kind !== 'markdown')) {
      const text = await renderNote(item, currentNotes.content, currentNotes.frontmatter);
      await atomic(await inside(nextNote), text);
      item.notes = { ...item.notes, hash: hash(text), revision: currentNotes.revision + 1 };
    }
    await store(item);
    await rm(source);
    if (oldNote && nextNote !== oldNote) await rm(await inside(oldNote));
    index.invalidate?.();
    return document(item);
  }
  const api = {
    init,
    close() { closed = true; tasks.abort(); index.close?.(); },
    async status() {
      await init();
      return { vaultPath: vaultReal, root, count: (await records()).length, converters: await capabilities() };
    },
    async list(options) {
      if (options && options.path !== undefined) return (await api.files(options)).documents;
      return (await records()).map(summary);
    },
    async folders(options = {}) { await init(); return fs.folders(typeof options === 'string' ? options : options.path || ''); },
    async files({ path = '' } = {}) {
      await init();
      const directory = await fs.entries(path), items = await records();
      const byPath = new Map(items.map(item => [item.originalPath, item]));
      const notes = new Map(items.filter(item => item.notePath).map(item => [item.notePath, item]));
      const documents = directory.entries.filter(entry => entry.isFile() && supportedFile(entry.name)).flatMap(entry => {
        const rel = slash(join(directory.path, entry.name)), item = byPath.get(rel);
        if (notes.has(rel)) return [];
        if (item) return { ...summary(item), registered: true, kind: 'document' };
        return { name: entry.name, path: rel, folder: directory.path, title: basename(entry.name, extname(entry.name)), type: /\.pdf$/i.test(entry.name) ? 'pdf' : /\.(docx?|odt|rtf|pptx?)$/i.test(entry.name) ? 'document' : /\.html?$/i.test(entry.name) ? 'web' : /\.txt$/i.test(entry.name) ? 'text' : 'markdown', registered: false, kind: 'document' };
      }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      return { path: directory.path, documents };
    },
    async folder(options) {
      return lock(async () => {
        const result = await fs.mutate(options);
        if (result.previousPath && result.previousPath !== result.path) {
          for (const item of await records()) {
            const before = JSON.stringify(item);
            remapItem(item, result.previousPath, result.path);
            if (JSON.stringify(item) !== before) await store(item);
          }
        }
        index.invalidate?.();
        return result;
      });
    },
    async moveDocument(options) { return lock(() => moveDocumentUnlocked(options)); },
    async renameDocument(options) { return lock(() => renameDocumentUnlocked(options)); },
    async deleteDocument(options) { return lock(() => deleteDocumentUnlocked(options)); },
    async restoreDocument(options) { return lock(() => restoreDocumentUnlocked(options)); },
    async listDeletedDocuments() {
      return lock(async () => {
        const folder = await transactionFile(internalPath('data', 'trash'));
        const entries = await readdir(folder, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        const documents = [];
        for (const dir of entries.filter(dir => dir.isDirectory() && /^[a-f0-9-]{36}$/.test(dir.name))) {
          const entry = await json(await transactionFile(trashPath(dir.name, 'entry.json')));
          if (entry) documents.push(trashedSummary(entry));
        }
        return { documents: documents.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)) };
      });
    },
    async register({ path, title, tags, metadata } = {}) {
      await init();
      const actual = await fs.path(path, { user: true });
      if (!(await stat(actual)).isFile() || !supportedFile(actual)) throw fault('请选择支持的本地文献文件', 400, 'unsupported-file');
      const relativePath = slash(relative(vaultReal, actual));
      const old = (await records()).find(item => item.originalPath === relativePath || item.notePath === relativePath);
      if (old) return api.get(old.id);
      const id = randomUUID(), bytes = await readFile(actual), digest = hash(bytes);
      const pdfRelative = /\.pdf$/i.test(actual) ? relativePath : internalPath('previews', id + '.pdf');
      const input = { bytes, name: basename(actual), source: { type: 'vault', path: relativePath } };
      const parsed = await parseInput(input, actual, await inside(pdfRelative, { required: false }));
      return lock(async () => {
        const duplicate = (await records()).find(item => item.originalPath === relativePath || item.notePath === relativePath);
        if (duplicate) return document(duplicate);
        const item = newItem(id, input, { title, tags: tags ?? (parsed.type === 'markdown' ? tagsFromMarkdown(bytes.toString('utf8')) : []), metadata, registered: true }, relativePath, pdfRelative, parsed, digest);
        await writeManaged(item.textPath, bodyMarkdown(item), item, 'text');
        await store(item);
        return document(item);
      });
    },
    async get(id) { return lock(async () => document(await load(typeof id === 'object' ? id.id : id))); },
    async importFile(options) { return importBytes(await readInput(options), options); },
    async importUrl() { throw fault('文献库仅支持本地文件，已关闭网页抓取', 403, 'offline-only'); },
    async updateMetadata({ id, title, tags, expectedRevision } = {}) {
      if (title === undefined && tags === undefined) throw fault('请提供标题或标签');
      if (title !== undefined && (typeof title !== 'string' || !title.trim())) throw fault('标题不能为空');
      if (tags !== undefined && (!Array.isArray(tags) || tags.length > 100 || tags.some(tag => typeof tag !== 'string' || tag.length > 100))) throw fault('标签应为不超过 100 项的文本数组');
      return lock(async () => {
        const item = await load(id);
        checkRevision(item.metadataRevision || 0, expectedRevision);
        await noteState(item);
        const nextTitle = title === undefined ? item.title : safeName(title);
        const nextTags = tags === undefined ? item.tags || [] : uniqueTags(tags);
        if (nextTitle === item.title && JSON.stringify(nextTags) === JSON.stringify(item.tags || [])) return document(item);
        const changedFields = [...(title !== undefined ? ['title'] : []), ...(tags !== undefined ? ['tags'] : [])];
        item.title = nextTitle; item.tags = nextTags;
        if (title !== undefined) item.metadata = { ...item.metadata, title: nextTitle };
        item.metadataRevision = (item.metadataRevision || 0) + 1;
        const files = [
          [item.notePath, 'notes'], [item.textPath, 'text'], [item.annotationsPath, 'annotations'], [item.studyPath, 'study'],
          ...(item.sessions || []).filter(session => session.path).map(session => [session.path, 'session:' + session.sessionId]),
        ];
        for (const [path, key] of files) {
          if (!path) continue;
          const abs = await inside(path, { required: false });
          const current = await readFile(abs, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (current === null) continue;
          const patched = patchFrontmatter(current, item, changedFields);
          if (patched === current) continue;
          await atomic(abs, patched);
          if (key === 'notes') {
            const { blocks, freeText } = parseNoteContent(patched);
            item.notes = { ...item.notes, blocks, freeText, hash: hash(patched), revision: item.notes.revision + 1 };
          }
          else if (item.generatedHashes?.[key] === hash(current)) item.generatedHashes[key] = hash(patched);
        }
        await store(item);
        return document(item);
      });
    },
    async reparse(id, options = {}) {
      await init();
      const before = await load(id);
      const original = await inside(before.originalPath);
      const bytes = await readFile(original);
      const ext = extname(original);
      const nextPreviewRevision = (before.previewRevision || 0) + 1;
      const pdfRelative = ext === '.pdf' ? before.originalPath : internalPath('previews', before.id + '.r' + nextPreviewRevision + '.pdf');
      const parsed = options.page !== undefined
        ? await parsePdf(await inside(before.pdfPath || before.originalPath), { page: options.page, forceOcr: true, signal: tasks.signal })
        : ext === '.pdf'
          ? { type: 'pdf', pdfPath: original, ...(await parsePdf(original, { signal: tasks.signal })), preview: { status: 'ready', engine: 'original', quality: 'original', warnings: [] } }
          : await parseDocument({ bytes, name: basename(original), originalPath: original, pdfOutputPath: await inside(pdfRelative, { required: false }), signal: tasks.signal });
      return lock(async () => {
        const item = await load(id);
        if (options.page !== undefined) {
          const page = Number(options.page), mergePages = (previous = [], incoming = []) => [...previous.filter(value => value.page !== page), ...incoming].sort((a, b) => a.page - b.page);
          item.pages = mergePages(item.pages, parsed.pages);
          item.pageCount = parsed.pageCount || item.pageCount;
          item.ocr = { ...item.ocr, ...parsed.ocr, pages: mergePages(item.ocr?.pages, parsed.ocr?.pages), words: mergePages(item.ocr?.words, parsed.ocr?.words), errors: mergePages(item.ocr?.errors, parsed.ocr?.errors) };
          item.warnings = [...new Set([...(item.warnings || []), ...(parsed.warnings || [])])];
          if (item.type === 'pdf') {
            item.text = item.pages.map(page => page.text || '').join('\n\n');
            item.markdown = item.pages.map(page => `## 第 ${page.page} 页\n\n${page.text || ''}`).join('\n\n');
            item.blocks = [...(item.blocks || []).filter(block => block.page !== page), ...(parsed.blocks || [])];
            item.body = { ...item.body, markdown: item.markdown, blocks: item.blocks };
          }
          item.parseDetails = { ...item.parseDetails, ocr: item.ocr.pages, pageCount: item.pageCount };
        } else Object.assign(item, parsedFields(parsed));
        const digest = hash(bytes);
        if (digest !== item.hash) { item.previousHashes = [...new Set([...(item.previousHashes || []), item.hash])]; item.fileRevision = (item.fileRevision || 1) + 1; item.hash = digest; }
        if (options.page === undefined) {
          if (parsed.pdfPath && pdfRelative !== item.pdfPath) {
            item.previewRevision = nextPreviewRevision;
            item.previewHistory.push({ revision: nextPreviewRevision, path: pdfRelative, pageCount: parsed.pageCount || parsed.pages?.length || null, createdAt: new Date().toISOString() });
            item.pdfPath = pdfRelative;
          } else if (parsed.pdfPath) item.pdfPath = pdfRelative;
          else if (item.pdfPath) { item.warnings.push('新预览未生成，上一版 PDF 已保留'); item.pageCount = before.pageCount || before.pages?.length || null; item.pages = before.pages || []; }
          item.type = parsed.type;
          item.parseStatus = parsed.parseStatus || (['failed', 'empty'].includes(parsed.body?.status) ? 'failed' : 'ready');
        } else if (item.type === 'pdf') item.parseStatus = ['failed', 'empty'].includes(parsed.body?.status) ? 'failed' : 'ready';
        const content = bodyMarkdown(item);
        await writeManaged(item.textPath, content, item, 'text');
        await store(item); return document(item);
      });
    },
    async search(options = {}) { active(); if (options.path !== undefined) await fs.directory(options.path); return index.search(options, await records()); },
    async readNote(path) {
      const actual = await fs.path(typeof path === 'object' ? path.path : path, { user: true });
      if (!/\.m(?:ark)?d(?:own)?$/i.test(actual)) throw fault('只能读取当前仓库内的 Markdown 笔记', 403);
      return { path: relative(vaultReal, actual), title: basename(actual, extname(actual)), text: await readFile(actual, 'utf8') };
    },
    async saveNote(value, rest, revision) {
      const args = normalizeArgs(value, rest, 'text');
      if (revision !== undefined) args.expectedRevision = revision;
      return lock(async () => {
        const item = await load(args.id); const current = await noteState(item);
        checkRevision(current.revision, args.expectedRevision);
        checkRevision(item.annotations.revision, args.expectedAnnotationsRevision);
        if (args.content === undefined && args.text === undefined && args.blocks === undefined && args.freeText === undefined) throw fault('请提供笔记正文或段落');
        if (args.content !== undefined && (!Number.isInteger(args.expectedRevision) || args.expectedRevision < 0)) throw fault('保存前请读取笔记版本', 400, 'note-revision-required');
        const update = args.content === undefined ? legacyNoteUpdate(current, args) : { content: args.content, frontmatter: current.frontmatter };
        const annotationRevision = item.annotations.revision;
        if (args.restoreAnnotations !== undefined) {
          if (!Array.isArray(args.content) || !Array.isArray(args.restoreAnnotations) || args.restoreAnnotations.length > 10_000 || !Number.isInteger(args.expectedAnnotationsRevision)) throw fault('恢复批注前请读取笔记和批注版本');
          const existing = new Set(item.annotations.items.map(annotation => annotation.id));
          const links = new Map(args.content.filter(node => node?.kind === 'quote' && node.annotationId).map(node => [node.annotationId, node.id || node.noteId]));
          for (const annotation of args.restoreAnnotations) {
            if (typeof annotation?.id !== 'string' || !annotation.id || existing.has(annotation.id) || !annotation.noteId || links.get(annotation.id) !== annotation.noteId) throw fault('要恢复的批注与引用不匹配', 409, 'annotation-restore-conflict');
            item.annotations.items.push(annotationForSave(item, annotation));
            existing.add(annotation.id);
          }
        }
        const content = await normalizeNoteContent(item, update.content, current.content);
        await persistNotes(item, content, update.frontmatter, current);
        if (args.restoreAnnotations?.length && item.annotations.revision === annotationRevision) item.annotations.revision++;
        if (item.annotations.revision !== annotationRevision) await writeAnnotationMirror(item);
        await store(item); return document(item);
      });
    },
    async saveAnnotations(value, rest, revision) {
      const args = normalizeArgs(value, rest, 'annotations');
      args.annotations ??= args.items;
      if (revision !== undefined) args.expectedRevision = revision;
      return lock(async () => {
        const item = await load(args.id);
        const current = await noteState(item);
        checkRevision(item.annotations.revision, args.expectedRevision);
        checkRevision(current.revision, args.expectedNotesRevision);
        if (!Array.isArray(args.annotations) || args.annotations.length > 10_000) throw fault('批注数据无效');
        const old = new Map(item.annotations.items.map(annotation => [annotation.id, annotation]));
        const items = args.annotations.map(annotation => annotationForSave(item, annotation, old.get(String(annotation?.id))));
        const active = new Map(items.map(annotation => [annotation.id, annotation]));
        if (active.size !== items.length) throw fault('批注编号重复');
        const priorByNote = new Map([...old.values()].filter(annotation => annotation.noteId).map(annotation => [annotation.noteId, annotation]));
        let content = current.content.flatMap(node => {
          if (node.kind !== 'quote') return [node];
          const previous = old.get(node.annotationId) || priorByNote.get(node.id);
          if (!previous) return [node];
          const annotation = active.get(previous.id);
          if (!annotation) return [];
          if (annotation.note !== undefined && annotation.note !== previous.note && annotation.note !== node.text) return [{ ...node, text: annotation.note, updatedAt: new Date().toISOString() }];
          return [node];
        });
        item.annotations = { items, revision: item.annotations.revision + 1, sourceHash: item.hash };
        content = projectAnnotations(item, content);
        const refs = new Map(content.filter(node => node.kind === 'quote' && node.annotationId).map(node => [node.annotationId, node]));
        for (const annotation of items) {
          const ref = refs.get(annotation.id);
          if (ref) { annotation.noteId = ref.id; annotation.note = ref.text; }
        }
        const changed = JSON.stringify(content) !== JSON.stringify(current.content);
        const previouslyProjected = current.content.some(node => node.kind === 'quote' && !item.notes.blocks?.some(block => block.id === node.id));
        if (changed || previouslyProjected) await persistNotes(item, content, current.frontmatter, current, { sync: false });
        await writeAnnotationMirror(item);
        await store(item); return document(item);
      });
    },
    async saveProgress(value, rest) {
      const args = normalizeArgs(value, rest);
      return lock(async () => {
        const item = await load(args.id);
        item.progress = { ...item.progress, page: Math.max(1, Math.min(item.pageCount ?? (item.pages?.length || 1), Number(args.page) || 1)), zoom: Math.max(0.25, Math.min(5, Number(args.zoom) || 1)), ...(args.anchor ? { anchor: args.anchor } : {}), updatedAt: new Date().toISOString() };
        await store(item); return document(item);
      });
    },
    async saveStudy(value, rest, revision) {
      const args = normalizeArgs(value, rest, 'study');
      if (revision !== undefined) args.expectedRevision = revision;
      return lock(async () => {
        const item = await load(args.id);
        checkRevision(item.study.revision, args.expectedRevision);
        if (!args.study || typeof args.study !== 'object' || Array.isArray(args.study)) throw fault('学习记录无效');
        item.study = { ...item.study, ...args.study, revision: item.study.revision + 1, updatedAt: new Date().toISOString() };
        const readable = Object.entries(item.study).filter(([key]) => !['revision', 'updatedAt'].includes(key)).map(([key, data]) => `## ${key}\n\n${typeof data === 'string' ? data : '```json\n' + JSON.stringify(data, null, 2) + '\n```'}\n`).join('\n');
        await writeManaged(item.studyPath, header(item) + `# ${item.title} · 学习记录\n\n` + readable, item, 'study');
        await store(item); return document(item);
      });
    },
    async saveSession(value, rest) {
      const args = normalizeArgs(value, rest);
      return lock(async () => {
        const item = await load(args.id);
        if (!args.sessionId || !/^[\w.:/-]{1,200}$/.test(args.sessionId)) throw fault('会话编号无效');
        let session = item.sessions.find(s => s.sessionId === args.sessionId);
        if (!session) { session = { sessionId: args.sessionId, messages: [], createdAt: new Date().toISOString() }; item.sessions.push(session); }
        session.mode = args.mode || session.mode || 'reading';
        const incoming = Array.isArray(args.messages) ? args.messages : [];
        for (const message of incoming) {
          const key = String(message.id || (message.seq !== undefined ? `seq:${message.seq}` : hash(JSON.stringify(message))));
          const old = session.messages.findIndex(m => m.id === key);
          if (old >= 0) session.messages[old] = { ...session.messages[old], ...message, id: key };
          else session.messages.push({ ...message, id: key });
        }
        session.messages.sort((a, b) => Number.isFinite(a.seq) && Number.isFinite(b.seq) ? a.seq - b.seq : 0);
        if (typeof args.transcript === 'string') session.transcript = args.transcript;
        session.updatedAt = args.updatedAt || new Date().toISOString();
        const name = `${item.id}--${hash(args.sessionId).slice(0, 16)}.md`;
        session.path = internalPath('sessions', name);
        const text = session.transcript || session.messages.map(m => `## ${m.role === 'user' ? '提问' : '回答'}${m.time ? ' · ' + m.time : ''}\n\n${m.text || ''}\n`).join('\n');
        await writeManaged(session.path, header(item) + `# ${item.title} · 阅读对话\n\n` + text, item, 'session:' + args.sessionId);
        await store(item); return document(item);
      });
    },
    async filePath(id, view = 'pdf', revision) {
      const item = await load(id);
      revision = typeof revision === 'object' ? revision.revision : revision;
      const path = view === 'original' ? item.originalPath : view === 'text' ? item.textPath : revision !== undefined && revision !== null && revision !== '' ? item.previewHistory.find(preview => preview.revision === Number(revision))?.path : item.pdfPath;
      if (!path) throw fault('此文件没有 PDF 预览', 404);
      return inside(path);
    },
    async migrateLayout() {
      return lock(async () => {
        const journalPath = join(root, dirs.data, 'layout-migration.json');
        const journal = await json(journalPath, { version: 2, documents: {} });
        const report = { migrated: 0, resumed: 0, files: 0, errors: [] };
        const saveJournal = () => atomicJson(journalPath, { ...journal, updatedAt: new Date().toISOString() });
        const items = await records();
        for (const item of items) {
          if (!item.legacyLayout && !journal.documents[item.id]) continue;
          try {
            let entry = journal.documents[item.id];
            if (!entry) {
              const ext = extname(item.originalPath), folder = '文献库/未分类';
              let original = slash(join(folder, safeName(item.title) + ext));
              if (await stat(await inside(original, { required: false })).catch(() => null)) original = slash(join(folder, safeName(item.title) + '--' + item.id.slice(0, 8) + ext));
              const date = item.notes.createdDate || String(item.createdAt || new Date().toISOString()).slice(0, 10);
              const mappings = [[item.originalPath, original]];
              if (item.pdfPath && item.pdfPath !== item.originalPath) mappings.push([item.pdfPath, internalPath('previews', item.id + '.pdf')]);
              if (item.notePath) mappings.push([item.notePath, slash(join(folder, `${safeName(basename(original, ext))}笔记${date}.md`))]);
              for (const [key, dir] of [['textPath', 'texts'], ['annotationsPath', 'annotations'], ['studyPath', 'study']]) if (item[key]) mappings.push([item[key], internalPath(dir, item.id + '.md')]);
              for (const session of item.sessions) if (session.path) mappings.push([session.path, internalPath('sessions', basename(session.path))]);
              const files = [];
              for (const [from, to] of mappings) {
                const source = await inside(from, { required: false });
                const bytes = await readFile(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
                if (bytes !== null) files.push({ from, to, hash: hash(bytes), archive: slash(join('文献库', dirs.data, 'legacy', from)), state: 'pending' });
              }
              entry = journal.documents[item.id] = { state: 'copying', date, files, mappings, createdAt: new Date().toISOString() };
              await saveJournal();
            } else if (entry.state === 'done') continue;
            else report.resumed++;
            for (const file of entry.files) {
              if (file.state !== 'pending') continue;
              const source = await inside(file.from, { required: false });
              const actualHash = hash(await readFile(source));
              if (actualHash !== file.hash) throw fault('旧文件在迁移期间发生修改，已暂停该文献迁移', 409, 'migration-source-changed');
              await copyVerified(source, await inside(file.to, { required: false }), file.hash);
              file.state = 'verified'; report.files++;
              await saveJournal();
            }
            if (entry.state === 'copying') {
              const byPath = new Map(entry.mappings || entry.files.map(file => [file.from, file.to]));
              for (const key of ['originalPath', 'pdfPath', 'textPath', 'notePath', 'annotationsPath', 'studyPath']) if (byPath.has(item[key])) item[key] = byPath.get(item[key]);
              for (const session of item.sessions) if (byPath.has(session.path)) session.path = byPath.get(session.path);
              for (const preview of item.previewHistory) if (byPath.has(preview.path)) preview.path = byPath.get(preview.path);
              item.notes.createdDate = entry.date;
              if (item.notePath) {
                const text = await readFile(await inside(item.notePath), 'utf8');
                const parsed = parseNoteContent(text);
                const content = projectAnnotations(item, parsed.content);
                const updated = content.some(node => node.kind !== 'markdown') ? await renderNote(item, content, parsed.frontmatter) : text;
                await atomic(await inside(item.notePath), updated);
                item.notes = { ...item.notes, ...legacyNoteFields(content, parsed.frontmatter), hash: hash(updated), formatVersion: 2 };
              }
              item.legacyLayout = false;
              await store(item);
              entry.state = 'committed'; await saveJournal();
            }
            for (const file of entry.files) {
              if (file.state === 'archived' || file.from === file.to) continue;
              const source = await inside(file.from, { required: false });
              const bytes = await readFile(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
              if (bytes !== null) {
                if (hash(bytes) !== file.hash) throw fault('旧文件已修改，归档暂停，原文件予以保留', 409, 'migration-source-changed');
                await copyVerified(source, await inside(file.archive, { required: false }), file.hash);
                await rm(source);
              } else if (hash(await readFile(await inside(file.archive))) !== file.hash) throw fault('迁移归档校验失败', 500, 'copy-verification-failed');
              file.state = 'archived'; await saveJournal();
            }
            entry.state = 'done'; await saveJournal(); report.migrated++;
          } catch (error) { report.errors.push({ id: item.id, message: error.message, code: error.code }); }
        }
        for (const dir of ['附件', '正文', '笔记', '批注', '对话', '学习']) {
          const old = await inside(slash(join('文献库', dir)), { required: false });
          await rmdir(old).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
        }
        index.invalidate?.();
        return report;
      });
    },
    async migrate({ roots, studyRoot, literatureStore } = {}) {
      const sources = roots || [join(homedir(), '.dsh-paper-reader', 'data'), join(homedir(), '.dsh', 'storages', 'dsh-literature', 'pdfs'), join(homedir(), 'Downloads', 'ai-library', 'items')];
      const report = { imported: 0, duplicates: 0, errors: [], sources: sources.map(String), files: [], studyArchives: [], sidecars: 0, literatureAnnotations: 0 };
      const files = [];
      async function walk(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (entry.name.startsWith('.')) continue;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile() && /\.(pdf|docx?|md|markdown|html?|txt)$/i.test(entry.name)) files.push(path);
        }
      }
      for (const source of sources) await walk(source);
      for (const path of files) {
        try {
          const result = await api.importFile({ path, tags: ['旧库迁移'] });
          if (result.duplicate) report.duplicates++; else report.imported++;
          report.files.push({ path, id: result.id, hash: result.hash, duplicate: !!result.duplicate });
        } catch (error) { report.errors.push({ path, message: error.message }); }
      }
      // Preserve per-paper reading plans beside each imported source PDF.
      for (const file of report.files.filter(f => /\.pdf$/i.test(f.path))) {
        const sidecar = file.path.replace(/\.pdf$/i, '.study.json');
        try {
          const legacy = await json(sidecar);
          if (legacy) {
            const current = await api.get(file.id);
            if (!current.study.legacyPaperReader) {
              await api.saveStudy({ id: file.id, study: { legacyPaperReader: legacy, tasks: Array.isArray(legacy.plan) ? legacy.plan.map(step => ({ id: 'legacy-' + step.id, text: step.title, done: step.status === 'done' })) : [] }, expectedRevision: current.study.revision });
              report.sidecars++;
            }
          }
        } catch (error) { report.errors.push({ path: sidecar, message: error.message }); }
      }
      // Literature's own store contains citations, free notes and annotation geometry.
      const legacyStorePath = literatureStore || join(homedir(), '.dsh', 'storages', 'dsh-literature', 'store.json');
      try {
        const legacy = await json(legacyStorePath);
        if (legacy) {
          for (const [key, entry] of Object.entries(legacy.items || {})) {
            const sourcePdf = entry.pdf?.path || entry.export?.pdfPath;
            const file = sourcePdf ? report.files.find(f => resolve(f.path) === resolve(sourcePdf)) : null;
            if (!file) continue;
            await lock(async () => {
              const item = await load(file.id);
              if (item.metadata?.legacyLiteratureKey) return;
              item.metadata = { ...item.metadata, ...entry.record, legacyLiteratureKey: key };
              if (entry.record?.title) item.title = String(entry.record.title);
              await store(item);
            });
            const current = await api.get(file.id);
            const annotations = legacy.annotations?.[key];
            if (Array.isArray(annotations) && annotations.length && !current.annotations.items.length) {
              await api.saveAnnotations({ id: file.id, annotations, expectedRevision: current.annotations.revision });
              report.literatureAnnotations += annotations.length;
            }
            if (Array.isArray(entry.notes) && entry.notes.length && !current.notes.text.includes('<!-- legacy-literature-notes -->')) {
              const notes = entry.notes.map(n => typeof n === 'string' ? n : n.text).filter(Boolean).join('\n\n');
              await api.saveNote({ id: file.id, text: current.notes.text + '\n<!-- legacy-literature-notes -->\n\n' + notes + '\n', expectedRevision: current.notes.revision });
            }
          }
          const copy = join(root, dirs.data, 'legacy-literature-store.json');
          const bytes = await readFile(legacyStorePath); await atomic(copy, bytes);
          if (hash(await readFile(copy)) !== hash(bytes)) throw new Error('旧文献库副本校验失败');
        }
      } catch (error) { report.errors.push({ path: legacyStorePath, message: error.message }); }
      // Global coach archives have no one-to-one document mapping: retain their hierarchy
      // with verified JSON copies and a readable/searchable Markdown projection.
      const oldStudyRoot = studyRoot || join(homedir(), '.dsh', 'study-coach');
      const archiveRoot = join(root, '学习', '旧学习档案');
      async function archiveStudy(dir) {
        if (resolve(dir).startsWith(root + sep)) return;
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (entry.name.startsWith('.')) continue;
          const source = join(dir, entry.name);
          if (entry.isDirectory()) await archiveStudy(source);
          else if (entry.isFile() && /\.(json|md)$/i.test(entry.name)) {
            try {
              const bytes = await readFile(source); const rel = relative(oldStudyRoot, source);
              const target = join(archiveRoot, rel);
              const exists = await readFile(target).catch(() => null);
              if (exists && hash(exists) !== hash(bytes)) {
                // Existing archive may have been edited after migration.
                await atomic(target + '.source-copy', bytes);
              } else await atomic(target, bytes);
              const copied = exists && hash(exists) !== hash(bytes) ? target + '.source-copy' : target;
              if (hash(await readFile(copied)) !== hash(bytes)) throw new Error('旧学习档案副本校验失败');
              if (/\.json$/i.test(entry.name)) {
                const data = JSON.parse(bytes.toString('utf8'));
                const md = `# 旧学习档案 · ${rel}\n\n来源：${source}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
                const mdTarget = target + '.md';
                const current = await readFile(mdTarget, 'utf8').catch(() => null);
                if (current === null || current === md) await atomic(mdTarget, md);
              }
              report.studyArchives.push({ source, path: relative(vaultReal, copied), hash: hash(bytes) });
            } catch (error) { report.errors.push({ path: source, message: error.message }); }
          }
        }
      }
      await archiveStudy(oldStudyRoot);
      await atomicJson(join(root, dirs.data, 'migration-report.json'), report);
      return report;
    },
  };
  await init();
  if (await stat(renameJournal).catch(() => null) || await stat(trashJournal).catch(() => null)) await lock(async () => {});
  return api;
}
