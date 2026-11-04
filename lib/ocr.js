import { run, isAbort, throwIfAborted } from './process.js';

const clamp = n => Math.max(0, Math.min(1, n));
export function textQuality(text) {
  const content = String(text || '').replace(/\s/g, '');
  const meaningful = (content.match(/[\p{L}\p{N}]/gu) || []).length;
  const damaged = (content.match(/[\uFFFD\u0000-\u0008\u000b\u000e-\u001f\ue000-\uf8ff]/g) || []).length;
  if (!content) return { usable: false, reason: 'no-text', characters: 0 };
  if (damaged > Math.max(1, content.length * .08) || meaningful < Math.min(3, content.length) || meaningful / content.length < .25) return { usable: false, reason: 'unusable-text', characters: content.length };
  return { usable: true, reason: 'embedded-text', characters: content.length };
}
// OCR runs on the upright raster. Convert its word boxes back into the original PDF
// page coordinate space so highlights remain anchored when the viewer zooms.
export function originalRect(rect, rotation = 0) {
  const { x, y, width, height } = rect;
  const out = rotation === 90 ? { x: y, y: 1 - x - width, width: height, height: width } : rotation === 180 ? { x: 1 - x - width, y: 1 - y - height, width, height } : rotation === 270 ? { x: 1 - y - height, y: x, width: height, height: width } : { x, y, width, height };
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, clamp(v)]));
}
export function parseTsv(tsv, { page = 1, rotation = 0 } = {}) {
  let width = 1, height = 1; const words = [], lines = new Map(); let confidenceSum = 0, confidenceWeight = 0;
  for (const row of String(tsv).split('\n').slice(1)) {
    const c = row.replace(/\r$/, '').split('\t'); if (c.length < 12) continue;
    if (c[0] === '1') { width = Number(c[8]) || 1; height = Number(c[9]) || 1; }
    const text = c.slice(11).join('\t').trim(), confidence = Number(c[10]);
    if (c[0] !== '5' || !text || !Number.isFinite(confidence) || confidence < 0) continue;
    const rect = originalRect({ x: Number(c[6]) / width, y: Number(c[7]) / height, width: Number(c[8]) / width, height: Number(c[9]) / height }, rotation);
    if (!Object.values(rect).every(Number.isFinite)) continue;
    words.push({ page, text, ...rect, confidence, rotation });
    const key = c.slice(2, 5).join('-'); lines.set(key, [...(lines.get(key) || []), text]);
    confidenceSum += confidence * text.length; confidenceWeight += text.length;
  }
  const text = [...lines.values()].map(line => line.join(' ').replace(/([\u3400-\u9fff]) (?=[\u3400-\u9fff])/g, '$1')).join('\n');
  const confidence = confidenceWeight ? Math.round(confidenceSum / confidenceWeight * 10) / 10 : 0;
  return { words, text, confidence, quality: words.length === 0 ? 'empty' : confidence < 65 ? 'low' : 'good', dimensions: { width, height } };
}

export async function recognizePage(path, page, dir, { signal, onProgress, language, tools } = {}) {
  throwIfAborted(signal); onProgress?.({ phase: 'ocr', page, state: 'running', message: '正在本地识别扫描页并检查方向' });
  const prefix = `${dir}/page-${page}`, image = `${prefix}.png`, warnings = [];
  await run(tools.pdftoppm, ['-f', String(page), '-l', String(page), '-scale-to', '2600', '-png', '-singlefile', path, prefix], { signal });
  let rotation = 0, orientationConfidence = null, source = image;
  try {
    const orientation = await run(tools.tesseract, [image, 'stdout', '--psm', '0', '-l', 'osd'], { signal, timeout: 45_000 });
    const output = orientation.stdout + '\n' + orientation.stderr;
    const proposed = Number(/Rotate:\s*(\d+)/i.exec(output)?.[1]) || 0;
    orientationConfidence = Number(/Orientation confidence:\s*([\d.]+)/i.exec(output)?.[1]) || 0;
    if ([90, 180, 270].includes(proposed) && orientationConfidence >= 2) {
      const corrected = `${prefix}.upright.png`;
      await run(tools.magick, [image, '-rotate', String(proposed), corrected], { signal, timeout: 45_000 });
      source = corrected; rotation = proposed;
    } else if (proposed && orientationConfidence < 2) warnings.push('方向判断置信度不足，保留原方向识别');
  } catch (error) { if (isAbort(error)) throw error; warnings.push('未能自动校正方向，已按原方向识别'); }
  const { stdout } = await run(tools.tesseract, [source, 'stdout', '-l', language || 'eng', '--psm', '3', 'tsv'], { signal });
  const result = parseTsv(stdout, { page, rotation });
  if (result.quality === 'low') warnings.push('识别置信度较低，请对照原文核对，可单页重新识别');
  if (result.quality === 'empty') warnings.push('本页未识别到文字；可能为空白页、图表或图像质量不足');
  const status = { page, status: result.quality === 'empty' ? 'empty' : 'ready', quality: result.quality, confidence: result.confidence, language: language || 'eng', rotation, orientationConfidence, warnings, retryable: true };
  onProgress?.({ phase: 'ocr', page, state: status.status, quality: result.quality, confidence: result.confidence });
  return { ...result, status, warnings };
}
