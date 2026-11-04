import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { parseDocx, structureHtml, cleanDocumentHtml } from '../lib/docx.js';
import { parseDocument, parsePdf, run, activeProcessCount } from '../lib/import.js';
import { originalRect, parseTsv, textQuality } from '../lib/ocr.js';

async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'hub-parser-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function present(path) { try { await access(path); return true; } catch { return false; } }
async function docxFixture() {
  const zip = new JSZip();
  const rootRel = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const officeRel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>`);
  zip.file('_rels/.rels', `<Relationships xmlns="${rootRel}"><Relationship Id="rId1" Type="${officeRel}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="${rootRel}"><Relationship Id="styles" Type="${officeRel}/styles" Target="styles.xml"/><Relationship Id="numbering" Type="${officeRel}/numbering" Target="numbering.xml"/><Relationship Id="footnotes" Type="${officeRel}/footnotes" Target="footnotes.xml"/><Relationship Id="unsafe" Type="${officeRel}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>`);
  zip.file('word/styles.xml', `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>`);
  zip.file('word/numbering.xml', `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  zip.file('word/footnotes.xml', `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>脚注证据</w:t></w:r></w:p></w:footnote></w:footnotes>`);
  const p = text => `<w:p><w:r><w:rPr><w:rFonts w:ascii="SimSun" w:eastAsia="宋体"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${officeRel}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>中文研究课题</w:t></w:r></w:p>${p('中文正文保留原始语义，反馈连接观察与行动。')}${p('重复段落')}${p('重复段落')}<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>学习目标</w:t></w:r></w:p><w:tbl><w:tr><w:tc>${p('概念')}</w:tc><w:tc>${p('证据')}</w:tc></w:tr><w:tr><w:tc>${p('反馈')}</w:tc><w:tc>${p('观察结果')}</w:tc></w:tr></w:tbl><w:p><w:r><w:t>引用脚注</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:hyperlink r:id="unsafe"><w:r><w:t>危险链接</w:t></w:r></w:hyperlink></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function pdf(objects) {
  let source = Buffer.from('%PDF-1.4\n'); const offsets = [0];
  objects.forEach((object, i) => { offsets.push(source.length); source = Buffer.concat([source, Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from('\nendobj\n')]); });
  const start = source.length;
  return Buffer.concat([source, Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`)]);
}
function stream(data, extra = '') { const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data); return Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${extra} >>\nstream\n`), bytes, Buffer.from('\nendstream')]); }
function mixedPdf() {
  const glyphs = { S:['01111','10000','10000','01110','00001','00001','11110'], C:['01111','10000','10000','10000','10000','10000','01111'], A:['01110','10001','10001','11111','10001','10001','10001'], N:['10001','11001','11001','10101','10011','10011','10001'], P:['11110','10001','10001','11110','10000','10000','10000'], G:['01111','10000','10000','10111','10001','10001','01111'], E:['11111','10000','10000','11110','10000','10000','11111'], F:['11111','10000','10000','11110','10000','10000','10000'], D:['11110','10001','10001','10001','10001','10001','11110'], B:['11110','10001','10001','11110','10001','10001','11110'], K:['10001','10010','10100','11000','10100','10010','10001'] };
  const width = 1200, height = 300, pixels = Buffer.alloc(width * height, 255), scale = 7;
  let x = 50; for (const char of 'SCAN PAGE FEEDBACK') { const rows = glyphs[char]; if (rows) for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) if (rows[row][col] === '1') for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) pixels[(100 + row * scale + dy) * width + x + col * scale + dx] = 0; x += (char === ' ' ? 4 : 7) * scale; }
  const raster = deflateSync(pixels);
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', stream('BT /F1 18 Tf 50 700 Td (Short title) Tj ET'), '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 7 0 R >> >> /Contents 8 0 R >>', stream(raster, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`), stream('q 550 0 0 138 30 350 cm /Im1 Do Q')]);
}

test('direct OOXML preserves Chinese headings, lists, tables and footnotes with stable paragraph anchors', async () => {
  const bytes = await docxFixture(), a = await parseDocx(bytes), b = await parseDocx(bytes);
  assert.match(a.text, /中文正文保留原始语义/);
  for (const type of ['heading', 'paragraph', 'list', 'table', 'footnote']) assert.ok(a.blocks.some(block => block.type === type), type);
  assert.match(a.markdown, /# 中文研究课题/); assert.match(a.markdown, /\| 反馈 \| 观察结果 \|/); assert.match(a.markdown, /\[\^1\]: 脚注证据/);
  assert.doesNotMatch(a.body.html, /javascript:|onclick=/i);
  assert.equal(a.body.pageMapping, 'unavailable'); assert.ok(a.blocks.every(block => block.page === null));
  assert.equal(new Set(a.blocks.map(block => block.id)).size, a.blocks.length);
  assert.deepEqual(a.blocks.map(block => block.id), b.blocks.map(block => block.id));
});

test('document HTML removes active content and external resource loads while retaining safe evidence links', () => {
  const html = cleanDocumentHtml('<h2 onclick="bad()">标题</h2><script>alert(1)</script><iframe src="https://bad.test"></iframe><p><a href="javascript:bad()">恶意</a><a href="https://example.com/paper">证据</a><img src="https://bad.test/tracker" onerror="bad()"></p>');
  assert.doesNotMatch(html, /script|iframe|onclick|onerror|javascript:|bad\.test/); assert.match(html, /https:\/\/example\.com\/paper/);
  assert.match(structureHtml(html).text, /证据/);
  assert.equal(textQuality('短标题').usable, true, 'short valid text must not trigger OCR');
  assert.equal(textQuality('\ufffd\ufffd\ufffd\ufffd').usable, false);
});

test('local Word preview embeds Chinese glyph fonts independently of the canonical OOXML body', async t => {
  if (!await present('/opt/homebrew/bin/soffice') || !await present(process.env.NOTO_CJK_FONT||'')) return t.skip('local converter or CJK fixture font is unavailable');
  const dir = await temp(t), bytes = await docxFixture(), originalPath = join(dir, '中文样例.docx'), pdfOutputPath = join(dir, 'preview.pdf'); await writeFile(originalPath, bytes);
  const result = await parseDocument({ bytes, name: '中文样例.docx', originalPath, pdfOutputPath });
  assert.equal(result.body.engine, 'mammoth'); assert.equal(result.body.status, 'ready'); assert.equal(result.body.pageMapping, 'unavailable');
  assert.equal(result.preview.status, 'ready'); assert.ok(result.preview.fonts.some(font => /NotoSansCJK|Songti|PingFang/.test(font.name) && font.embedded));
  assert.ok(result.pages.length >= 1); assert.equal(result.ocr.used, false); assert.ok(result.blocks.every(block => block.page === null));
  assert.equal((await readFile(originalPath)).equals(bytes), true, 'conversion cannot edit the original');
});

test('mixed PDF OCR skips usable short text and single-page retries preserve original page numbers', async t => {
  if (!await present('/opt/homebrew/bin/pdftotext') || !await present('/opt/homebrew/bin/tesseract')) return t.skip('local PDF/OCR tools are unavailable');
  const dir = await temp(t), path = join(dir, 'mixed.pdf'); await writeFile(path, mixedPdf()); const events = [];
  const result = await parsePdf(path, { onProgress: event => events.push(event) });
  assert.equal(result.pages.length, 2); assert.match(result.pages[0].text, /Short title/); assert.equal(result.pages[0].ocr, undefined);
  assert.equal(result.ocr.used, true); assert.ok(result.ocr.words.length > 0); assert.ok(result.ocr.words.every(word => word.page === 2 && [word.x, word.y, word.width, word.height].every(n => n >= 0 && n <= 1)));
  assert.ok(events.some(event => event.phase === 'ocr' && event.page === 2)); assert.equal(events.some(event => event.phase === 'ocr' && event.page === 1), false);
  const retry = await parsePdf(path, { page: 2, forceOcr: true }); assert.equal(retry.partial, true); assert.equal(retry.pageCount, 2); assert.equal(retry.pages.length, 1); assert.equal(retry.pages[0].page, 2);
});

test('OCR rotation maps upright boxes back to the original page and reports confidence', () => {
  const rect = { x: .2, y: .3, width: .1, height: .2 };
  const rotated = originalRect(rect, 90); assert.ok(Math.abs(rotated.x - .3) < 1e-9); assert.ok(Math.abs(rotated.y - .7) < 1e-9); assert.equal(rotated.width, .2); assert.equal(rotated.height, .1);
  const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n1\t1\t0\t0\t0\t0\t0\t0\t1000\t500\t-1\t\n5\t1\t1\t1\t1\t1\t200\t150\t100\t100\t40\t证据\n';
  const result = parseTsv(tsv, { page: 4, rotation: 90 }); assert.equal(result.quality, 'low'); assert.equal(result.confidence, 40); assert.equal(result.words[0].page, 4); assert.ok(Math.abs(result.words[0].y - .7) < 1e-9);
});

test('AbortSignal stops converters and their helpers before temporary work is removed', async t => {
  if (process.platform === 'win32') return t.skip('POSIX process-group test');
  const dir = await temp(t), pidFile = join(dir, 'pid'), lateFile = join(dir, 'late');
  const helper = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(lateFile)},'late'),600);setInterval(()=>{},1000)`;
  const parent = `const cp=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(cp.pid));setInterval(()=>{},1000)`;
  const controller = new AbortController(), running = run(process.execPath, ['-e', parent], { signal: controller.signal });
  const rejected = assert.rejects(running, error => error.name === 'AbortError' && error.code === 'ABORT_ERR');
  for (let i = 0; i < 100 && !await present(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await present(pidFile), true); controller.abort('test cancellation'); await rejected;
  assert.equal(activeProcessCount(), 0); await new Promise(resolve => setTimeout(resolve, 700)); assert.equal(await present(lateFile), false);
});
