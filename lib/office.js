import { readFile, writeFile, mkdir, mkdtemp, rm, access, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, isAbort, throwIfAborted } from './process.js';

const CJK_FONTS = ['宋体', 'SimSun', '新宋体', 'NSimSun', '仿宋', 'FangSong', '楷体', 'KaiTi', '黑体', 'SimHei', '微软雅黑', 'Microsoft YaHei', '华文宋体', 'STSong', 'zh-CN'];
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
async function exists(path) { try { await access(path); return true; } catch { return false; } }
export async function fontEnvironment(dir, { soffice = '/opt/homebrew/bin/soffice', signal } = {}) {
  throwIfAborted(signal);
  const executable = await realpath(soffice).catch(() => soffice);
  const appResources = executable.includes('.app/Contents/') ? executable.split('.app/Contents/')[0] + '.app/Contents/Resources' : null;
  const candidates = [process.env.DSH_FONT_DIR, join(homedir(), 'Library/Fonts'), '/Library/Fonts', '/System/Library/Fonts', '/System/Library/AssetsV2/com_apple_MobileAsset_Font8', '/usr/share/fonts', '/usr/local/share/fonts', join(homedir(), '.local/share/fonts'), appResources && join(appResources, 'fonts/truetype')].filter(Boolean);
  const dirs = []; for (const path of candidates) if (await exists(path)) dirs.push(path);
  const fontCache = join(dir, 'font-cache'); await mkdir(fontCache, { recursive: true });
  const config = join(dir, 'fonts.conf');
  const fallback = process.env.DSH_CJK_FONT || 'Noto Sans CJK SC';
  const aliases = CJK_FONTS.map(f => `<alias binding="strong"><family>${xml(f)}</family><prefer><family>${xml(fallback)}</family><family>Songti SC</family><family>PingFang SC</family></prefer></alias>`).join('\n');
  await writeFile(config, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>${dirs.map(d => `<dir>${xml(d)}</dir>`).join('')}<cachedir>${xml(fontCache)}</cachedir>${aliases}<alias><family>sans-serif</family><prefer><family>${xml(fallback)}</family><family>Liberation Sans</family></prefer></alias><alias><family>serif</family><prefer><family>Songti SC</family><family>${xml(fallback)}</family><family>Liberation Serif</family></prefer></alias></fontconfig>`, { mode: 0o600 });
  const profile = join(dir, 'lo-profile'); await mkdir(join(profile, 'user'), { recursive: true });
  const pairs = CJK_FONTS.map((f, i) => `<node oor:name="CJK${i}" oor:op="replace"><prop oor:name="ReplaceFont"><value>${xml(f)}</value></prop><prop oor:name="SubstituteFont"><value>${xml(fallback)}</value></prop><prop oor:name="Always"><value>true</value></prop><prop oor:name="OnScreenOnly"><value>false</value></prop></node>`).join('');
  await writeFile(join(profile, 'user/registrymodifications.xcu'), `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Font/Substitution"><prop oor:name="Replacement" oor:op="fuse"><value>true</value></prop><node oor:name="FontPairs">${pairs}</node></item></oor:items>`, { mode: 0o600 });
  const env = { FONTCONFIG_FILE: config, FONTCONFIG_PATH: dir, SAL_FONTPATH: dirs.join(process.platform === 'win32' ? ';' : ':'), SAL_USE_VCLPLUGIN: 'svp' };
  // The cache is private to this conversion, so stale inherited caches cannot hide CJK fonts.
  await run(process.env.DSH_FCCACHE || '/opt/homebrew/bin/fc-cache', ['-f', ...dirs], { signal, env, timeout: 90_000, maxBuffer: 1024 * 1024 }).catch(error => { if (isAbort(error)) throw error; });
  return { profile, env, dirs, fallback, config };
}

export async function inspectPreview(pdfPath, { sourceText = '', signal } = {}) {
  const warnings = []; let pageCount = null, fonts = [];
  const metadata = await run(process.env.DSH_PDFINFO || '/opt/homebrew/bin/pdfinfo', [pdfPath], { signal }).catch(error => { if (isAbort(error)) throw error; warnings.push('PDF页数未能核验'); return { stdout: '' }; });
  pageCount = Number(/^Pages:\s+(\d+)/m.exec(metadata.stdout)?.[1]) || null;
  const result = await run(process.env.DSH_PDFFONTS || '/opt/homebrew/bin/pdffonts', [pdfPath], { signal }).catch(error => { if (isAbort(error)) throw error; warnings.push('PDF字体未能核验'); return { stdout: '' }; });
  fonts = result.stdout.split('\n').slice(2).filter(Boolean).map(line => ({ name: line.trim().split(/\s+/)[0], embedded: /\s+yes\s+(?:yes|no)\s+(?:yes|no)\s+\d+\s+\d+\s*$/.test(line) }));
  const cjkSource = (sourceText.match(/[\u3400-\u9fff]/g) || []).length > 10;
  const cjkFont = fonts.some(f => /CJK|Song|Sung|SimSun|SimHei|Heiti|PingFang|Kai|Fang|YaHei|Ming|SourceHan|GB[0-9]|STSong|DroidSansFallback/i.test(f.name));
  if (cjkSource && !cjkFont) warnings.push('中文字体嵌入未通过核验；PDF可能缺字，请使用正文视图并重新生成预览');
  return { status: cjkSource && !cjkFont ? 'font-warning' : warnings.length ? 'partial' : 'ready', engine: 'libreoffice', pageCount, quality: cjkSource && !cjkFont ? 'unverified-cjk' : 'font-checked', fonts, warnings };
}

export async function convertOffice(originalPath, pdfOutputPath, { signal, onProgress, sourceText = '', soffice = process.env.DSH_SOFFICE || '/opt/homebrew/bin/soffice' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-office-'));
  try {
    throwIfAborted(signal); onProgress?.({ phase: 'preview', state: 'running', message: '正在配置本地中文字体并生成PDF预览' });
    const font = await fontEnvironment(dir, { soffice, signal });
    await run(soffice, [`-env:UserInstallation=${pathToFileURL(font.profile).href}`, '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', ['.ppt', '.pptx'].includes(extname(originalPath).toLowerCase()) ? 'pdf:impress_pdf_Export' : 'pdf:writer_pdf_Export', '--outdir', dir, originalPath], { signal, env: font.env, timeout: 240_000 });
    const converted = join(dir, basename(originalPath, extname(originalPath)) + '.pdf');
    const bytes = await readFile(converted); if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('转换器未生成有效PDF');
    const preview = await inspectPreview(converted, { signal, sourceText });
    await mkdir(dirname(pdfOutputPath), { recursive: true }); await writeFile(pdfOutputPath, bytes);
    onProgress?.({ phase: 'preview', state: preview.status, pageCount: preview.pageCount });
    return { pdfPath: pdfOutputPath, preview: { ...preview, fontFallback: font.fallback, fontDirectories: font.dirs } };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
