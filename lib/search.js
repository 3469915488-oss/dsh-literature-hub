import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname, dirname } from 'node:path';
import { hiddenEntry, slash } from './vault-files.js';
import { parseNoteContent, tagsFromMarkdown, normalizeTag, uniqueTags } from './note-content.js';

function tokens(value) {
  const text = String(value).toLowerCase();
  const terms = text.match(/[\p{L}\p{N}_-]+/gu) || [];
  for (const span of text.match(/[\p{Script=Han}]+/gu) || []) {
    for (let i = 0; i < span.length - 1; i++) terms.push(span.slice(i, i + 2));
    if (span.length === 1) terms.push(span);
  }
  return [...new Set(terms)];
}
const parent = path => dirname(path) === '.' ? '' : slash(dirname(path));
function chunks(text, extra = {}) {
  const result = [];
  for (const part of String(text || '').split(/(?=^## 第 \d+ 页\s*$)/m)) {
    const page = /^## 第 (\d+) 页/m.exec(part)?.[1];
    for (let start = 0; start < part.length; start += 900) result.push({ text: part.slice(start, start + 1100), ...(page ? { page: Number(page) } : {}), ...extra });
  }
  return result.length ? result : [{ text: '', ...extra }];
}

export function createSearch(vaultPath) {
  const cache = new Map();
  let closed = false;
  async function refresh() {
    if (closed) return;
    const seen = new Set(), queue = [vaultPath];
    while (queue.length && !closed) {
      const dir = queue.pop();
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (hiddenEntry(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile() && ['.md', '.markdown'].includes(extname(entry.name).toLowerCase())) {
          const info = await stat(path).catch(() => null);
          if (!info || info.size > 12 * 1024 * 1024) continue;
          seen.add(path);
          const old = cache.get(path);
          if (old && old.mtime === info.mtimeMs && old.ctime === info.ctimeMs && old.size === info.size) continue;
          const text = await readFile(path, 'utf8').catch(() => '');
          const rel = slash(relative(vaultPath, path));
          cache.set(path, {
            path: rel, title: /^#\s+(.+)$/m.exec(text)?.[1] || entry.name.replace(/\.m(?:ark)?d(?:own)?$/i, ''),
            tags: tagsFromMarkdown(text),
            text, chunks: chunks(text), mtime: info.mtimeMs, ctime: info.ctimeMs, size: info.size,
          });
        }
      }
    }
    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
  }
  return {
    refresh,
    invalidate() { cache.clear(); },
    close() { closed = true; cache.clear(); },
    async search({ q = '', scope = 'all', type, tag, path, limit = 40 } = {}, records = []) {
      await refresh();
      if (closed) return [];
      const query = String(q).trim().toLowerCase(), terms = tokens(query);
      const originals = new Map(records.map(record => [record.originalPath, record]));
      const notes = new Map(records.filter(record => record.notePath).map(record => [record.notePath, record]));
      const annotationTags = new Map(records.flatMap(record => (record.annotations?.items || []).map(annotation => [`${record.id}:${annotation.id}`, Array.isArray(annotation.tags) ? annotation.tags : []])));
      const cachedPaths = new Set([...cache.values()].map(entry => entry.path));
      const entries = [], indexedReferences = new Set();
      for (const cached of cache.values()) {
        const original = originals.get(cached.path), note = notes.get(cached.path);
        if (original) {
          // Vault Markdown stays searchable immediately after an external edit.
          entries.push({ ...cached, id: original.id, record: original, kind: 'document', folder: parent(original.originalPath) });
        } else if (note) {
          const content = (cached.noteContent ||= parseNoteContent(cached.text)).content;
          const pieces = content.flatMap(node => {
            if (node.kind === 'quote') {
              if (node.annotationId) indexedReferences.add(`${note.id}:${node.annotationId}`);
              return chunks([node.quote, node.text].filter(Boolean).join('\n\n'), { noteId: node.id, page: node.page, annotationId: node.annotationId, tags: annotationTags.get(`${note.id}:${node.annotationId}`) });
            }
            return node.kind === 'markdown' && node.markdown.trim() ? chunks(node.markdown) : [];
          });
          if (pieces.length) entries.push({ ...cached, id: note.id, linkedDocumentId: note.id, record: note, kind: 'note', folder: parent(note.originalPath), chunks: pieces });
        } else entries.push({ ...cached, kind: 'document', folder: parent(cached.path) });
      }
      for (const record of records) {
        const base = { id: record.id, title: record.title, path: record.originalPath, folder: parent(record.originalPath), record };
        if (!cachedPaths.has(record.originalPath)) {
          let pieces;
          if (record.blocks?.length) pieces = record.blocks.flatMap(block => chunks(block.text || block.markdown, { blockId: block.id, ...(block.page ? { page: block.page } : {}) }));
          else if (record.pages?.length) pieces = record.pages.flatMap(page => chunks(page.text, { page: page.page }));
          else pieces = chunks(record.text || record.markdown || '');
          entries.push({ ...base, kind: 'document', chunks: pieces });
        }
        if (record.annotations?.items?.length) entries.push({ ...base, kind: 'annotation', chunks: record.annotations.items.map(annotation => ({ text: [annotation.anchor?.quote || annotation.text, indexedReferences.has(`${record.id}:${annotation.id}`) ? null : annotation.note].filter(Boolean).join('\n\n'), page: annotation.page || ((annotation.pageIndex ?? 0) + 1), annotationId: annotation.id, tags: annotationTags.get(`${record.id}:${annotation.id}`) })) });
        if (record.study && Object.keys(record.study).some(key => !['revision', 'updatedAt'].includes(key))) entries.push({ ...base, kind: 'study', chunks: chunks(JSON.stringify(record.study)) });
        for (const session of record.sessions || []) {
          const text = session.transcript || (session.messages || []).map(message => message.text || '').join('\n\n');
          if (text) entries.push({ ...base, kind: 'conversation', chunks: chunks(text, { sessionId: session.sessionId }) });
        }
      }
      const hits = [], requestedPath = path === undefined ? undefined : slash(String(path)).replace(/^\.\/?/, '').replace(/\/$/, '');
      const requestedTag = normalizeTag(tag);
      for (const entry of entries) {
        if (requestedPath !== undefined && entry.folder !== requestedPath) continue;
        if (scope === 'library' && !entry.path.startsWith('文献库/')) continue;
        if (scope && !['all', 'vault', 'library'].includes(scope) && entry.id !== scope && entry.folder !== scope) continue;
        const types = type === 'docx' ? ['document'] : type === 'md' ? ['markdown', 'text', 'web'] : [type];
        if (type && !types.includes(entry.record?.type || 'markdown')) continue;
        const documentTags = entry.record ? entry.record.tags || [] : entry.tags || [];
        const candidates = entry.chunks.map(chunk => ({ ...chunk, tags: uniqueTags([...documentTags, ...(chunk.tags || [])]) })).filter(chunk => !requestedTag || chunk.tags.includes(requestedTag));
        for (const chunk of query ? candidates : candidates.slice(0, 1)) {
          const title = entry.record?.title || entry.title;
          const haystack = (title + '\n' + entry.title + '\n' + chunk.text).toLowerCase(), matched = terms.filter(term => haystack.includes(term));
          if (query && !matched.length) continue;
          const score = (query && haystack.includes(query) ? 6 : 0) + matched.length / Math.max(terms.length, 1) * 4 + (query && title.toLowerCase().includes(query) ? 5 : 0);
          const at = chunk.text.toLowerCase().indexOf(query), start = Math.max(0, at - 100);
          const snippet = chunk.text.slice(start, start + 380).replace(/^---[\s\S]*?---\s*/, '');
          hits.push({ id: entry.id, linkedDocumentId: entry.linkedDocumentId, noteId: chunk.noteId, path: entry.path, folder: entry.folder, title, tags: chunk.tags, snippet, page: chunk.page, blockId: chunk.blockId, annotationId: chunk.annotationId, sessionId: chunk.sessionId, kind: entry.kind, score });
        }
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(100, Number(limit) || 40)));
    },
    get size() { return cache.size; },
  };
}
