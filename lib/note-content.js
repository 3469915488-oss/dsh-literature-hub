import { basename, dirname, extname, relative, sep } from 'node:path';

const FRONTMATTER = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const MARKER = /<!-- dlh-(note|audio):([A-Za-z0-9_-]+) -->\r?\n([\s\S]*?)<!-- \/dlh-\1 -->[ \t]*(?:\r?\n|$)/g;
const BODY = '<!-- dlh-note-body -->';

export function splitFrontmatter(text) {
  const frontmatter = FRONTMATTER.exec(text)?.[0] || '';
  return { frontmatter, body: text.slice(frontmatter.length) };
}

function decodeMarker(kind, encoded, visible) {
  try {
    const meta = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!meta || typeof meta.id !== 'string' || !meta.id) return null;
    if (kind === 'audio') return typeof meta.assetId === 'string' && meta.assetId ? { kind: 'audio', id: meta.id, assetId: meta.assetId, assetMarkdown: visible.replace(/\r?\n$/, '') } : null;
    const bodyAt = visible.indexOf(BODY);
    const prefix = bodyAt < 0 ? '' : visible.slice(0, bodyAt);
    const quoted = /^(?:>[^\r\n]*(?:\r?\n|$))+/.exec(prefix)?.[0];
    const quote = quoted ? quoted.replace(/\r?\n$/, '').split(/\r?\n/).map(line => line.replace(/^> ?/, '')).join('\n') : String(meta.quote || '');
    const body = bodyAt < 0 ? visible : visible.slice(bodyAt + BODY.length);
    const extra = prefix.slice(quoted?.length || 0).replace(/^\s*\[原文\]\(<[^\r\n]+>\)\s*/, '').trim();
    const text = body.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    return { ...meta, kind: 'quote', noteId: meta.id, quote, text: extra ? [extra, text].filter(Boolean).join('\n\n') : text };
  } catch { return null; }
}

export function parseNoteContent(value = '') {
  const text = String(value), { frontmatter, body } = splitFrontmatter(text);
  const content = [], ids = new Set();
  let offset = 0;
  for (const match of body.matchAll(MARKER)) {
    const node = decodeMarker(match[1], match[2], match[3]);
    if (!node || ids.has(node.id)) continue;
    if (match.index > offset) content.push({ kind: 'markdown', markdown: body.slice(offset, match.index) });
    ids.add(node.id);
    content.push(node);
    offset = match.index + match[0].length;
  }
  if (offset < body.length) content.push({ kind: 'markdown', markdown: body.slice(offset) });
  return { frontmatter, content, ...legacyNoteFields(content, frontmatter) };
}

export function legacyNoteFields(content, frontmatter = '') {
  const freeText = frontmatter + content.filter(node => node.kind === 'markdown').map(node => node.markdown).join('');
  const blocks = content.filter(node => node.kind === 'quote').map(({ kind, ...block }) => block);
  return { freeText: freeText.trimEnd(), blocks };
}

function relativeLink(from, to) {
  return relative(dirname(from), to).split(sep).map(part => encodeURIComponent(part)).join('/');
}

function quoteMarkdown(node, originalPath) {
  const { kind, text, ...meta } = node;
  const quote = node.quote ? '> ' + node.quote.replace(/\n/g, '\n> ') + '\n\n' : '';
  const page = node.page && extname(originalPath).toLowerCase() === '.pdf' ? '#page=' + node.page : '';
  const link = `[原文](<./${encodeURIComponent(basename(originalPath))}${page}>)\n\n`;
  const encoded = Buffer.from(JSON.stringify(meta)).toString('base64url');
  return `<!-- dlh-note:${encoded} -->\n${quote}${link}${BODY}\n${text || ''}\n<!-- /dlh-note -->\n`;
}

export async function serializeNoteContent(content, { frontmatter = '', originalPath, notePath, resolveAudioAsset } = {}) {
  let result = frontmatter;
  for (const node of content) {
    if (node.kind === 'markdown') {
      result += node.markdown;
      continue;
    }
    if (result && !result.endsWith('\n\n')) result += result.endsWith('\n') ? '\n' : '\n\n';
    if (node.kind === 'quote') result += quoteMarkdown(node, originalPath);
    else if (node.kind === 'audio') {
      const meta = Buffer.from(JSON.stringify({ id: node.id, assetId: node.assetId })).toString('base64url');
      const asset = await resolveAudioAsset?.(node.assetId);
      const label = String(asset?.title || '录音').replace(/[\[\]\r\n]/g, '');
      const link = asset?.path ? `![${label}](<${relativeLink(notePath, asset.path)}>)` : node.assetMarkdown || label;
      const transcript = asset?.transcriptPath ? `\n\n[转写](<${relativeLink(notePath, asset.transcriptPath)}>)` : '';
      result += `<!-- dlh-audio:${meta} -->\n${link}${transcript}\n<!-- /dlh-audio -->\n`;
    }
  }
  return result;
}

export const normalizeTag = value => String(value ?? '').trim().replace(/^#+/, '').trim().normalize('NFC');
export const uniqueTags = values => [...new Set(values.map(normalizeTag).filter(Boolean))];

export function tagsFromMarkdown(value) {
  const { frontmatter } = splitFrontmatter(String(value || ''));
  const match = /^tags:[ \t]*([^\r\n]*)\r?\n((?:[ \t]*-[ \t]+[^\r\n]*\r?\n)*)/m.exec(frontmatter);
  if (!match) return [];
  let tags;
  try { tags = JSON.parse(match[1]); } catch {}
  if (!Array.isArray(tags)) {
    const list = match[2].trim().split(/\r?\n/).map(line => line.trim().replace(/^-\s+/, ''));
    tags = match[1] ? match[1].trim().replace(/^\[|\]$/g, '').split(',') : list;
  }
  return uniqueTags(tags.map(tag => String(tag).trim().replace(/^["']|["']$/g, '')));
}
