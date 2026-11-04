import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { run, isAbort, throwIfAborted } from './process.js';
import { parseDocx } from './docx.js';
import { convertOffice } from './office.js';
import { textQuality, recognizePage } from './ocr.js';
export { run, cancelProcessing, activeProcessCount } from './process.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 100 * 1024 * 1024;
const tools = {
  pdftotext: process.env.DSH_PDFTOTEXT || '/opt/homebrew/bin/pdftotext',
  pdftoppm: process.env.DSH_PDFTOPPM || '/opt/homebrew/bin/pdftoppm',
  tesseract: process.env.DSH_TESSERACT || '/opt/homebrew/bin/tesseract',
  soffice: process.env.DSH_SOFFICE || '/opt/homebrew/bin/soffice',
  pdfinfo: process.env.DSH_PDFINFO || '/opt/homebrew/bin/pdfinfo',
  pdffonts: process.env.DSH_PDFFONTS || '/opt/homebrew/bin/pdffonts',
  magick: process.env.DSH_MAGICK || '/opt/homebrew/bin/magick',
};

export function fault(message, status = 400, code = 'invalid-input') {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}

export async function capabilities() {
  const result = {};
  for (const [name, path] of Object.entries(tools)) {
    try { await access(path); result[name] = true; } catch { result[name] = false; }
  }
  return result;
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()] || m;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
}

export function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|object|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function privateAddress(address) {
  if (address.includes(':')) return /^(::|fc|fd|fe[89ab])/i.test(address) || address.toLowerCase().startsWith('::ffff:');
  const p = address.split('.').map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

async function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fault('网址无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw fault('仅支持无账号信息的 HTTP 或 HTTPS 网址');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.local)$/i.test(host)) throw fault('网页导入不访问本机或局域网地址');
  const records = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!records.length || records.some(r => privateAddress(r.address))) throw fault('网页导入不访问私有网络地址');
  return url;
}

export async function downloadUrl(value, { signal } = {}) {
  throwIfAborted(signal);
  let url = await validateUrl(value);
  for (let redirect = 0; redirect <= 5; redirect++) {
    const response = await fetch(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000), headers: { 'User-Agent': 'DSH-Literature-Hub/1.0' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw fault('网页重定向缺少目标地址', 502);
      await response.body?.cancel();
      url = await validateUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw fault(`下载失败：HTTP ${response.status}`, 502, 'download-failed');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw fault('文件超过 100 MB', 413);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw fault('文件超过 100 MB', 413);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const contentType = response.headers.get('content-type') || '';
    const isPdf = bytes.subarray(0, 5).toString() === '%PDF-';
    const stem = decodeURIComponent(basename(url.pathname) || '网页');
    const extension = isPdf ? '.pdf' : /html/i.test(contentType) ? '.html' : '.txt';
    const name = stem.toLowerCase().endsWith(extension) ? stem : stem + extension;
    return { bytes, name, source: url.href, contentType };
  }
  throw fault('网页重定向次数过多', 502);
}

export async function readInput(input) {
  let bytes;
  throwIfAborted(input.signal);
  if (typeof input.path === 'string' && input.path.trim()) bytes = await readFile(input.path, { signal: input.signal });
  else if (typeof input.base64 === 'string' && input.base64) {
    const raw = input.base64.replace(/^data:[^;,]+;base64,/, '');
    if (raw.length > MAX_BYTES * 1.4 || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw fault('文件编码无效或超过 100 MB');
    bytes = Buffer.from(raw, 'base64');
  } else throw fault('请选择本地文件或提供文件内容');
  if (!bytes.length) throw fault('文件为空');
  if (bytes.length > MAX_BYTES) throw fault('文件超过 100 MB', 413);
  return { bytes, name: basename(input.name || input.path || '文档.txt'), source: input.path || 'upload' };
}

function plainBlocks(text, { page = null, format = 'text' } = {}) {
  const duplicates = new Map();
  return String(text).split(/\n\s*\n/).map(value => value.trim()).filter(Boolean).map(value => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(value), type = heading ? 'heading' : 'paragraph';
    const digest = createHash('sha256').update(`${page ?? 'body'}\0${type}\0${value}`).digest('hex').slice(0, 16), count = duplicates.get(digest) || 0; duplicates.set(digest, count + 1);
    const id = `block-${digest}-${count}`;
    return { id, blockId: id, type, ...(heading ? { level: heading[1].length } : {}), text: heading ? heading[2] : value, markdown: value, page, source: { format, ...(page ? { page } : {}), blockId: id } };
  });
}

export async function parsePdf(path, { onProgress, signal, page: requestedPage, forceOcr = false, ocr: enableOcr = true, language: requestedLanguage } = {}) {
  throwIfAborted(signal);
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pdf-'));
  try {
    const warnings = [];
    const info = await run(tools.pdfinfo, [path], { signal }).catch(error => { if (isAbort(error)) throw error; return { stdout: '' }; });
    let pageCount = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]) || null;
    const selected = requestedPage === undefined ? null : Number(requestedPage);
    if (selected !== null && (!Number.isInteger(selected) || selected < 1 || (pageCount && selected > pageCount))) throw fault('重试页码超出文档范围');
    const out = join(dir, 'text.txt');
    const args = ['-layout', '-enc', 'UTF-8', ...(selected ? ['-f', String(selected), '-l', String(selected)] : []), path, out];
    await run(tools.pdftotext, args, { signal });
    const full = await readFile(out, { encoding: 'utf8', signal });
    const texts = full.split('\f'); if (!texts.at(-1)?.trim()) texts.pop();
    if (!texts.length) texts.push('');
    pageCount ||= texts.length;
    const pages = texts.map((text, i) => ({ page: selected || i + 1, text: text.trim() }));
    if (!selected) while (pages.length < pageCount) pages.push({ page: pages.length + 1, text: '' });
    const ocr = { used: false, words: [], errors: [], pages: [], local: true };
    let language;
    for (const current of pages) {
      throwIfAborted(signal);
      const quality = textQuality(current.text), mustOcr = enableOcr && (forceOcr || !quality.usable);
      if (!mustOcr) {
        current.textStatus = quality.usable ? 'embedded' : 'unavailable';
        ocr.pages.push({ page: current.page, status: quality.usable ? 'not-needed' : 'skipped', reason: quality.reason, quality: quality.usable ? 'embedded' : 'unavailable', retryable: true });
        continue;
      }
      if (!language) {
        const available = await run(tools.tesseract, ['--list-langs'], { signal }).catch(error => { if (isAbort(error)) throw error; return { stdout: '' }; });
        const langs = new Set(available.stdout.split(/\s+/));
        language = requestedLanguage && requestedLanguage.split('+').every(l => langs.has(l)) ? requestedLanguage : langs.has('chi_sim') ? 'chi_sim+eng' : 'eng';
        if (!langs.has('chi_sim')) warnings.push('本地缺少简体中文 OCR 语言包，本次仅识别英文；中文结果请核对');
      }
      onProgress?.({ phase: 'ocr', page: current.page, total: pageCount, state: 'running' });
      try {
        const recognized = await recognizePage(path, current.page, dir, { signal, onProgress, language, tools });
        // A low-confidence retry must not discard a usable embedded text layer.
        if (!quality.usable || (recognized.text && recognized.quality === 'good')) { current.text = recognized.text; current.ocr = true; current.textStatus = recognized.quality === 'empty' ? 'empty' : recognized.quality === 'low' ? 'low-confidence' : 'ocr'; ocr.words.push(...recognized.words); }
        else current.textStatus = 'embedded';
        ocr.used = true; ocr.pages.push({ ...recognized.status, reason: forceOcr ? 'manual-retry' : quality.reason });
        warnings.push(...recognized.warnings.map(w => `第 ${current.page} 页：${w}`));
      } catch (error) {
        if (isAbort(error)) throw error;
        ocr.errors.push({ page: current.page, message: error.message });
        ocr.pages.push({ page: current.page, status: 'failed', quality: 'failed', reason: quality.reason, error: error.message, retryable: true });
        current.textStatus = quality.usable ? 'embedded' : 'failed';
      }
    }
    const text = pages.map(p => p.text).join('\n\n'), blocks = pages.flatMap(p => plainBlocks(p.text, { page: p.page, format: 'pdf' }));
    const markdown = pages.map(p => `## 第 ${p.page} 页\n\n${p.text}`).join('\n\n');
    const status = !text.trim() ? 'empty' : ocr.errors.length || ocr.pages.some(p => p.quality === 'low') ? 'partial' : 'ready';
    return { pages, pageCount, text, markdown, blocks, body: { status, format: 'markdown', engine: ocr.used ? 'tesseract+pdftotext' : 'pdftotext', pageMapping: 'exact', markdown, blocks, characters: text.length }, ocr, warnings: [...new Set([...warnings, ...ocr.errors.map(e => `第 ${e.page} 页 OCR 失败：${e.message}`)])], ...(selected ? { partial: true, requestedPage: selected } : {}) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function parseDocument({ bytes, name, originalPath, pdfOutputPath, onProgress, signal, page, forceOcr, ocr: enableOcr, language }) {
  throwIfAborted(signal);
  const ext = extname(name).toLowerCase(), options = { onProgress, signal, page, forceOcr, ocr: enableOcr, language };
  if (bytes.subarray(0, 5).toString() === '%PDF-' || ext === '.pdf') {
    await mkdir(dirname(pdfOutputPath), { recursive: true }); await writeFile(pdfOutputPath, bytes);
    const parsed = await parsePdf(pdfOutputPath, options);
    return { type: 'pdf', pdfPath: pdfOutputPath, ...parsed, preview: { status: 'ready', engine: 'original', pageCount: parsed.pageCount, quality: 'original', warnings: [] } };
  }
  if (ext === '.docx') {
    let direct, directError;
    try { direct = await parseDocx(bytes, options); } catch (error) { if (isAbort(error)) throw error; directError = error; }
    let converted, pdf, preview;
    try {
      converted = await convertOffice(originalPath, pdfOutputPath, { ...options, sourceText: direct?.text || '' });
      preview = converted.preview;
      pdf = await parsePdf(pdfOutputPath, { ...options, ocr: !direct?.text });
    } catch (error) { if (isAbort(error)) throw error; preview = { status: 'failed', engine: 'libreoffice', quality: 'unavailable', warnings: [error.message], error: error.message }; }
    const bodyResult = direct?.text ? direct : pdf?.text ? { ...pdf, body: { ...pdf.body, fallback: true } } : direct || { text: '', markdown: '', blocks: [], body: { status: 'failed', engine: 'mammoth', format: 'markdown', pageMapping: 'unavailable', markdown: '', blocks: [], error: directError?.message || 'Word正文为空' }, warnings: [] };
    const warnings = [...new Set([...(bodyResult.warnings || []), ...(preview.warnings || []), ...(directError ? [`Word结构化正文未完成：${directError.message}`] : [])])];
    return { type: 'document', pdfPath: converted?.pdfPath || null, text: bodyResult.text, markdown: bodyResult.markdown, blocks: bodyResult.blocks, body: bodyResult.body, pages: pdf?.pages || [], pageCount: pdf?.pageCount || preview.pageCount || null, preview, ocr: pdf?.ocr || { used: false, words: [], errors: [], pages: [], local: true }, warnings, parseStatus: bodyResult.text ? 'ready' : 'failed', ...(page ? { partial: true, requestedPage: page } : {}) };
  }
  if (['.doc', '.odt', '.rtf', '.ppt', '.pptx'].includes(ext)) {
    const converted = await convertOffice(originalPath, pdfOutputPath, options);
    return { type: 'document', ...converted, ...(await parsePdf(pdfOutputPath, options)) };
  }
  if (!['.md', '.markdown', '.txt', '.html', '.htm', '.csv', '.json', '.log', ''].includes(ext)) throw fault(`暂不支持 ${ext} 文件，请先转换为 PDF、Word、Markdown 或文本`, 415);
  const raw = bytes.toString('utf8'), html = ['.html', '.htm'].includes(ext), markdown = ['.md', '.markdown'].includes(ext);
  const text = html ? htmlToText(raw) : raw;
  if (text.includes('\u0000')) throw fault('文件不是可读取的文本', 415);
  const blocks = plainBlocks(text, { format: html ? 'web' : markdown ? 'markdown' : 'text' });
  return { type: html ? 'web' : markdown ? 'markdown' : 'text', pdfPath: null, text, markdown: text, blocks, body: { status: text.trim() ? 'ready' : 'empty', format: 'markdown', engine: 'text', pageMapping: 'unavailable', markdown: text, blocks, characters: text.length }, preview: { status: 'not-needed', engine: 'text', quality: 'not-applicable', warnings: [] }, pages: [], pageCount: null, ocr: { used: false, words: [], errors: [], pages: [], local: true }, warnings: [] };
}
