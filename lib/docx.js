import mammoth from 'mammoth';
import TurndownService from 'turndown';
import gfmPlugin from 'turndown-plugin-gfm';
import sanitizeHtml from 'sanitize-html';
import { parseHTML } from 'linkedom';
import { createHash } from 'node:crypto';
import { throwIfAborted } from './process.js';

const ALLOWED_TAGS = ['p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'blockquote', 'pre', 'code', 'strong', 'b', 'em', 'i', 's', 'del', 'u', 'a', 'sup', 'sub', 'br', 'hr'];
export function cleanDocumentHtml(html) {
  return sanitizeHtml(String(html), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'id', 'title'], '*': ['id'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], ol: ['start'] },
    allowedSchemes: ['https', 'http', 'mailto'], allowProtocolRelative: false,
    transformTags: { a: (_tag, attrs) => ({ tagName: 'a', attribs: { ...(attrs.href && /^(?:https?:|mailto:|#)/i.test(attrs.href) ? { href: attrs.href } : {}), ...(attrs.id ? { id: attrs.id } : {}) } }), img: () => ({ tagName: 'p', text: '[图片请查看 PDF 预览]', attribs: {} }) },
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'svg', 'math', 'template'],
  });
}
function textOf(node) {
  const copy = node.cloneNode(true);
  for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
  for (const row of copy.querySelectorAll('tr')) { for (const cell of row.children) cell.append('\t'); row.append('\n'); }
  for (const p of copy.querySelectorAll('p,li')) p.append('\n');
  return copy.textContent.replace(/\u00a0/g, ' ').replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function markdownConverter() {
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  service.use(gfmPlugin.gfm);
  service.addRule('footnote-reference', { filter: n => n.nodeName === 'A' && /^#footnote-\d+$/.test(n.getAttribute('href') || ''), replacement: (_text, n) => `[^${n.getAttribute('href').slice('#footnote-'.length)}]` });
  service.addRule('footnote-backlink', { filter: n => n.nodeName === 'A' && /^#footnote-ref-/.test(n.getAttribute('href') || ''), replacement: () => '' });
  service.addRule('footnote-definition', { filter: n => n.nodeName === 'LI' && /^footnote-\d+$/.test(n.id || ''), replacement: (content, n) => `\n\n[^${n.id.slice('footnote-'.length)}]: ${content.trim().replace(/\n/g, '\n    ')}\n\n` });
  service.addRule('structured-table', { filter: 'table', replacement: (_content, table) => {
    const rows = Array.from(table.getElementsByTagName('tr')).map(row => Array.from(row.children || row.childNodes).filter(cell => ['TD', 'TH'].includes(cell.nodeName)).map(cell => service.turndown(cell.innerHTML).replace(/\|/g, '\\|').replace(/\n+/g, '<br>')));
    if (!rows.length) return '';
    const columns = Math.max(...rows.map(r => r.length));
    const line = cells => '| ' + Array.from({ length: columns }, (_, i) => cells[i] || '').join(' | ') + ' |';
    const hasHeading = Array.from(table.getElementsByTagName('tr')[0].children || table.getElementsByTagName('tr')[0].childNodes).some(cell => cell.nodeName === 'TH');
    const header = hasHeading ? rows.shift() : Array(columns).fill('');
    return '\n\n' + [line(header), line(Array(columns).fill('---')), ...rows.map(line)].join('\n') + '\n\n';
  } });
  return service;
}

export function structureHtml(html, { signal, engine = 'mammoth' } = {}) {
  throwIfAborted(signal);
  const safe = cleanDocumentHtml(html);
  const { document } = parseHTML('<!doctype html><html><body>' + safe + '</body></html>');
  const markdown = markdownConverter(); const blocks = []; const duplicates = new Map();
  function block(node) {
    const text = textOf(node); if (!text && node.nodeName !== 'HR') return;
    const tag = node.nodeName.toLowerCase();
    const type = /^h[1-6]$/.test(tag) ? 'heading' : tag === 'table' ? 'table' : /^(ul|ol)$/.test(tag) ? 'list' : tag === 'li' && /^footnote-/.test(node.id) ? 'footnote' : tag === 'blockquote' ? 'quote' : tag === 'pre' ? 'code' : 'paragraph';
    const digest = createHash('sha256').update(type + '\0' + text).digest('hex').slice(0, 16), occurrence = duplicates.get(digest) || 0; duplicates.set(digest, occurrence + 1);
    const id = `block-${digest}-${occurrence}`; node.setAttribute('data-block-id', id);
    const content = markdown.turndown(node.outerHTML);
    blocks.push({ id, blockId: id, type, ...(type === 'heading' ? { level: Number(tag[1]) } : {}), text, markdown: content, html: node.outerHTML, page: null, source: { format: 'docx', blockId: id } });
  }
  for (const node of [...document.body.children]) {
    throwIfAborted(signal);
    if (node.nodeName === 'OL' && [...node.children].some(li => /^footnote-/.test(li.id || ''))) for (const li of node.children) block(li);
    else block(node);
  }
  const md = blocks.map(b => b.markdown).filter(Boolean).join('\n\n').trim();
  const text = blocks.map(b => b.text).filter(Boolean).join('\n\n');
  return { text, markdown: md, blocks, body: { status: text ? 'ready' : 'empty', format: 'markdown', engine, pageMapping: 'unavailable', markdown: md, html: document.body.innerHTML, blocks, characters: text.length }, html: document.body.innerHTML };
}

export async function parseDocx(bytes, { signal, onProgress } = {}) {
  throwIfAborted(signal); onProgress?.({ phase: 'body', state: 'running', message: '正在直接读取 Word 段落、标题、表格与脚注' });
  let images = 0;
  const converted = await mammoth.convertToHtml({ buffer: bytes }, {
    externalFileAccess: false,
    includeDefaultStyleMap: true,
    styleMap: ["p[style-name='标题 1'] => h1:fresh", "p[style-name='标题 2'] => h2:fresh", "p[style-name='标题 3'] => h3:fresh", "p[style-name='Heading 1'] => h1:fresh", "p[style-name='Heading 2'] => h2:fresh"],
    convertImage: mammoth.images.imgElement(async () => { images++; return { src: '' }; }),
  });
  throwIfAborted(signal);
  const result = structureHtml(converted.value, { signal });
  const warnings = converted.messages.filter(m => m.type === 'warning' || m.type === 'error').map(m => String(m.message)).slice(0, 30);
  if (images) warnings.push(`正文含 ${images} 处图片；图片内容请查看 PDF 预览`);
  if (!result.text) warnings.push('Word 中没有提取到可用正文，可能只有图片或包含不支持的对象');
  result.body.warnings = warnings; result.body.imageCount = images;
  onProgress?.({ phase: 'body', state: result.body.status, blocks: result.blocks.length, characters: result.text.length });
  return { ...result, warnings };
}
