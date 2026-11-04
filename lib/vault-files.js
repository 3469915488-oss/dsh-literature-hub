import { readdir, realpath, stat, lstat, mkdir, rename, rmdir } from 'node:fs/promises';
import { resolve, relative, join, sep, basename, dirname, isAbsolute } from 'node:path';
import { fault } from './import.js';

export const hiddenEntry = name => name.startsWith('.') || ['node_modules', '_data'].includes(name);
export const slash = path => path.split(sep).join('/');
export const supportedFile = name => /\.(pdf|docx?|odt|rtf|pptx?|md|markdown|html?|txt)$/i.test(name);

export function createVaultFiles(vault) {
  const contains = path => path === vault || path.startsWith(vault + sep);
  function relativePath(value = '') {
    if (typeof value !== 'string' || value.includes('\0') || isAbsolute(value)) throw fault('仓库位置无效', 403, 'unsafe-path');
    const target = resolve(vault, value);
    if (!contains(target)) throw fault('文件超出当前仓库', 403, 'unsafe-path');
    return slash(relative(vault, target));
  }
  async function path(value = '', { required = true, user = false } = {}) {
    const rel = relativePath(value);
    if (user && rel.split('/').filter(Boolean).some(hiddenEntry)) throw fault('不能操作内部数据目录', 403, 'internal-path');
    const target = resolve(vault, rel);
    let ancestor = target;
    for (;;) {
      try {
        const actual = await realpath(ancestor);
        if (!contains(actual)) throw fault('文件链接超出当前仓库', 403, 'unsafe-path');
        if (ancestor === target) return actual;
        if (required) throw Object.assign(fault('文件或目录不存在', 404, 'not-found'), { path: rel });
        return target;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (ancestor === vault) throw error;
        ancestor = dirname(ancestor);
      }
    }
  }
  function name(value) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\\/\0]/.test(value) || ['.', '..'].includes(value) || hiddenEntry(value)) throw fault('文件夹或文件名无效', 400, 'invalid-name');
    if (Buffer.byteLength(value) > 240) throw fault('名称过长', 400, 'invalid-name');
    return value;
  }
  async function directory(value = '', options = {}) {
    const target = await path(value, { ...options, user: true });
    if (!(await stat(target)).isDirectory()) throw fault('目标不是文件夹', 400, 'not-directory');
    return target;
  }
  async function entries(value = '') {
    const target = await directory(value);
    const rel = slash(relative(vault, target));
    const list = (await readdir(target, { withFileTypes: true })).filter(entry => !hiddenEntry(entry.name));
    return { path: rel, parent: rel ? slash(relative(vault, dirname(target))) : null, entries: list };
  }
  async function folders(value = '') {
    const result = await entries(value);
    const folders = [];
    for (const entry of result.entries.filter(entry => entry.isDirectory())) {
      const rel = slash(join(result.path, entry.name));
      const children = await readdir(await directory(rel), { withFileTypes: true });
      folders.push({ name: entry.name, path: rel, hasChildren: children.some(child => child.isDirectory() && !hiddenEntry(child.name)) });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return { path: result.path, parent: result.parent, folders };
  }
  async function mutate({ action, path: source = '', name: newName, destination } = {}) {
    if (action === 'create') {
      const parent = await directory(source), child = name(newName), target = join(parent, child);
      try { await mkdir(target); }
      catch (error) { if (error.code === 'EEXIST') throw fault('同名文件或文件夹已存在', 409, 'destination-exists'); throw error; }
      return { path: slash(relative(vault, target)), parent: slash(relative(vault, parent)), name: child };
    }
    if (!['rename', 'move'].includes(action)) throw fault('文件夹操作无效');
    const oldRel = relativePath(source);
    if (!oldRel || oldRel === '文献库' || oldRel.startsWith('文献库/_data/')) throw fault('不能移动仓库根目录或插件数据目录', 403, 'protected-directory');
    const original = await directory(oldRel);
    if ((await lstat(resolve(vault, oldRel))).isSymbolicLink()) throw fault('不能移动符号链接目录', 403, 'unsafe-path');
    const parent = action === 'rename' ? dirname(original) : await directory(destination ?? '');
    const target = join(parent, action === 'rename' ? name(newName) : newName === undefined ? basename(original) : name(newName));
    if (target === original) return { path: oldRel, previousPath: oldRel, parent: slash(relative(vault, parent)), name: basename(target) };
    if (target.startsWith(original + sep)) throw fault('不能将文件夹移入自身或子目录', 409, 'folder-cycle');
    // Reserve the destination exclusively. rename only replaces our empty reservation.
    try { await mkdir(target); }
    catch (error) { if (error.code === 'EEXIST') throw fault('目标位置已有同名文件或文件夹', 409, 'destination-exists'); throw error; }
    try { await rename(original, target); }
    catch (error) { await rmdir(target).catch(() => {}); throw error; }
    return { path: slash(relative(vault, target)), previousPath: oldRel, parent: slash(relative(vault, parent)), name: basename(target) };
  }
  return { path, relativePath, name, directory, entries, folders, mutate };
}
