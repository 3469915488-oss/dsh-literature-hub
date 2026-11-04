import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, symlink, stat, realpath, link } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { tmpdir } from 'node:os';
import { createStore } from '../lib/store.js';
import { htmlToText } from '../lib/import.js';

async function fixture(t) {
  const vaultPath = await mkdtemp(join(tmpdir(), 'dsh-hub-test-'));
  t.after(() => rm(vaultPath, { recursive: true, force: true }));
  const store = await createStore({ vaultPath });
  const source = '# Control theory\n\nFeedback connects observation and action.\n\n控制论研究反馈与学习。';
  const doc = await store.importFile({ base64: Buffer.from(source).toString('base64'), name: 'control.md', title: '控制论', tags: ['工程'] });
  return { vaultPath, store, doc, source };
}

test('imports original bytes, deduplicates SHA256 despite renamed upload, and persists UUID metadata', async t => {
  const { vaultPath, store, doc, source } = await fixture(t);
  assert.match(doc.id, /^[a-f0-9-]{36}$/);
  assert.equal(await readFile(doc.originalPath, 'utf8'), source);
  const again = await store.importFile({ base64: Buffer.from(source).toString('base64'), name: 'renamed.txt' });
  assert.equal(again.id, doc.id);
  assert.equal(again.duplicate, true);
  assert.equal((await store.status()).count, 1);
  const fresh = await createStore({ vaultPath });
  assert.equal((await fresh.get(doc.id)).hash, doc.hash);
});

test('optimistic revisions reject competing writes and leave successful note intact', async t => {
  const { store, doc } = await fixture(t);
  const results = await Promise.allSettled([
    store.saveNote({ id: doc.id, text: '第一份笔记', expectedRevision: 0 }),
    store.saveNote({ id: doc.id, text: '第二份笔记', expectedRevision: 0 }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const failed = results.find(r => r.status === 'rejected');
  assert.equal(failed.reason.status, 409);
  assert.equal((await store.get(doc.id)).notes.revision, 1);
});

test('parallel duplicate uploads commit a single original and metadata record', async t => {
  const { vaultPath, store } = await fixture(t);
  const input = { base64: Buffer.from('Concurrent import of one shared source.').toString('base64'), name: 'parallel.txt' };
  const results = await Promise.all(Array.from({ length: 4 }, () => store.importFile(input)));
  assert.equal(new Set(results.map(item => item.id)).size, 1);
  assert.equal(results.filter(item => item.duplicate).length, 3);
  assert.equal((await store.status()).count, 2);
  assert.equal((await readdir(join(vaultPath, '文献库', '未分类'))).length, 2);
});

test('Obsidian note edits advance revision and cannot be overwritten by stale editor', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  const saved = await store.saveNote({ id: doc.id, text: '初稿', expectedRevision: 0 });
  await writeFile(join(vaultPath, saved.notes.path), 'Obsidian 的人工修改');
  await assert.rejects(store.saveNote({ id: doc.id, text: '旧窗口覆盖', expectedRevision: 1 }), e => e.status === 409);
  const refreshed = await store.get(doc.id);
  assert.equal(refreshed.notes.text, 'Obsidian 的人工修改');
  assert.equal(refreshed.notes.revision, 2);
});

test('annotations survive restart with normalized geometry, and readable quotes are indexed', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  const items = [{ id: 'a1', type: 'highlight', page: 1, color: '#ffe071', rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }], anchor: { quote: '反馈闭环', start: 1, end: 5 }, note: '检验实际行动的结果' }];
  await store.saveAnnotations({ id: doc.id, annotations: items, expectedRevision: 0 });
  const fresh = await createStore({ vaultPath });
  const saved = await fresh.get(doc.id);
  assert.equal(saved.annotations.revision, 1);
  assert.deepEqual(saved.annotations.items[0].rects, items[0].rects);
  assert.equal(saved.annotations.items[0].anchor.quote, '反馈闭环');
  assert.ok((await fresh.search({ q: '反馈闭环' })).some(hit => hit.kind === 'annotation' && hit.id === doc.id));
});

test('vault Markdown search indexes external new files, modifications, and deleted files', async t => {
  const { vaultPath, store } = await fixture(t);
  const path = join(vaultPath, '研究日志.md');
  await writeFile(path, '# 研究日志\n\nquantumfeedback uniquequery');
  assert.ok((await store.search({ q: 'uniquequery' })).some(hit => hit.path === '研究日志.md'));
  await writeFile(path, '# 研究日志\n\nupdatedquery only');
  assert.equal((await store.search({ q: 'uniquequery' })).length, 0);
  assert.ok((await store.search({ q: 'updatedquery' })).length > 0);
  await rm(path);
  assert.equal((await store.search({ q: 'updatedquery' })).length, 0);
});

test('document trash hides originals and managed notes and restores the same document after restart', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  const path = 'in-place.md', original = join(vaultPath, path);
  const source = '# 在库资料\n\nDocument trash fixture marker.';
  await writeFile(original, source);
  const registered = await store.register({ path });
  await store.saveAnnotations({ id: registered.id, annotations: [{ id: 'keep', anchor: { quote: '保留批注' }, note: '恢复原位置' }], expectedRevision: 0 });
  const current = await store.saveSession(registered.id, { sessionId: 'session-trash', messages: [{ id: 'first', role: 'user', text: '保留伴读记录' }] });
  const note = join(vaultPath, current.notes.path), noteBefore = await readFile(note);
  assert.ok((await store.search({ q: 'fixture marker' })).some(hit => hit.id === registered.id));
  const removed = await store.deleteDocument({ id: registered.id, expectedRevision: current.metadataRevision, expectedHash: current.hash, expectedNotesRevision: current.notes.revision, expectedAnnotationsRevision: current.annotations.revision });
  assert.equal(removed.originalPath, path);
  await assert.rejects(readFile(original), { code: 'ENOENT' });
  await assert.rejects(readFile(note), { code: 'ENOENT' });
  await assert.rejects(store.get(registered.id), { code: 'not-found' });
  assert.deepEqual(await store.search({ q: 'fixture marker' }), []);
  assert.deepEqual(await store.search({ q: '保留伴读记录' }), []);
  assert.ok((await store.list()).some(item => item.id === doc.id));

  const fresh = await createStore({ vaultPath });
  assert.deepEqual((await fresh.listDeletedDocuments()).documents, [removed]);
  await writeFile(note, '外部新文件');
  await assert.rejects(fresh.restoreDocument({ id: registered.id }), { code: 'destination-exists' });
  assert.equal(await readFile(note, 'utf8'), '外部新文件');
  await assert.rejects(readFile(original), { code: 'ENOENT' });
  await rm(note);
  const restored = await fresh.restoreDocument({ id: registered.id });
  assert.equal(restored.id, registered.id);
  assert.equal(restored.annotations.items[0].id, 'keep');
  assert.equal(restored.sessions[0].sessionId, 'session-trash');
  assert.equal(await readFile(original, 'utf8'), source);
  assert.deepEqual(await readFile(note), noteBefore);
  assert.deepEqual((await fresh.listDeletedDocuments()).documents, []);
  assert.ok((await fresh.search({ q: 'fixture marker' })).some(hit => hit.id === registered.id));
});

test('document deletion rejects stale original and note versions without removing either file', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  const saved = await store.saveNote({ id: doc.id, text: '初稿', expectedRevision: 0 });
  const note = join(vaultPath, saved.notes.path);
  await writeFile(note, 'Obsidian 新修改');
  const args = { id: doc.id, expectedRevision: saved.metadataRevision, expectedHash: saved.hash, expectedNotesRevision: saved.notes.revision };
  await assert.rejects(store.deleteDocument(args), { code: 'revision-conflict' });
  assert.equal(await readFile(note, 'utf8'), 'Obsidian 新修改');
  assert.equal((await store.listDeletedDocuments()).documents.length, 0);
  const fresh = await store.get(doc.id);
  await writeFile(doc.originalPath, '新版本原件');
  await assert.rejects(store.deleteDocument({ ...args, expectedNotesRevision: fresh.notes.revision }), { code: 'revision-conflict' });
  assert.equal(await readFile(doc.originalPath, 'utf8'), '新版本原件');
  assert.equal((await store.listDeletedDocuments()).documents.length, 0);
});

test('startup completes an interrupted document move into the trash', async t => {
  const { vaultPath, store, doc, source } = await fixture(t);
  const data = '文献库/_data', trash = `${data}/trash/${doc.id}`;
  await mkdir(join(vaultPath, trash), { recursive: true });
  const mappings = [['original', doc.path, 'original.md'], ['record', `${data}/${doc.id}.json`, 'record.json']];
  const files = [];
  for (const [key, from, name] of mappings) {
    const to = `${trash}/${name}`, temp = `${trash}/.${key}.tmp`;
    const bytes = await readFile(join(vaultPath, from));
    const hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(vaultPath, temp), bytes);
    await link(join(vaultPath, temp), join(vaultPath, to));
    files.push({ key, from, to, temp, hash, nextHash: hash });
  }
  const entry = { id: doc.id, title: doc.title, originalPath: doc.path, deletedAt: new Date().toISOString(), files: files.map(({ key, hash }) => ({ key, hash })) };
  await writeFile(join(vaultPath, data, 'pending-trash.json'), JSON.stringify({ action: 'delete', entry, files, committed: true }));
  store.close();
  const fresh = await createStore({ vaultPath });
  await assert.rejects(readFile(doc.originalPath), { code: 'ENOENT' });
  assert.deepEqual((await fresh.listDeletedDocuments()).documents.map(item => item.id), [doc.id]);
  await fresh.restoreDocument({ id: doc.id });
  assert.equal(await readFile(doc.originalPath, 'utf8'), source);
});

test('generated Markdown keeps external edits and places refreshed projection beside it', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  await store.saveAnnotations({ id: doc.id, annotations: [{ text: 'first', note: 'original' }], expectedRevision: 0 });
  const dir = join(vaultPath, '文献库', '_data', 'annotations');
  const name = (await readdir(dir))[0];
  await writeFile(join(dir, name), '# 自行编辑的批注\n人工补充');
  await store.saveAnnotations({ id: doc.id, annotations: [{ text: 'second', note: 'new' }], expectedRevision: 1 });
  assert.equal(await readFile(join(dir, name), 'utf8'), '# 自行编辑的批注\n人工补充');
  const updated = name.replace(/\.md$/, '.generated.md');
  assert.match(await readFile(join(dir, updated), 'utf8'), /second/);
});

test('native session events merge and update messages by stable id, with Markdown persistence', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  await store.saveSession(doc.id, { sessionId: 'session-1', messages: [{ id: 'user-1', role: 'user', text: '解释反馈' }] });
  await store.saveSession(doc.id, { sessionId: 'session-1', messages: [{ id: 'assistant-1', role: 'assistant', text: '反馈是' }] });
  await store.saveSession(doc.id, { sessionId: 'session-1', messages: [{ id: 'assistant-1', role: 'assistant', text: '反馈是根据结果修正行动。' }] });
  const sessions = (await store.get(doc.id)).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].messages.length, 2);
  assert.match(sessions[0].messages[1].text, /修正行动/);
  const md = await readFile(join(vaultPath, sessions[0].path), 'utf8');
  assert.match(md, /解释反馈/);
  assert.match(md, /反馈是根据结果修正行动/);
});

test('study uses revision conflicts and persists tasks/cards', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  await store.saveStudy(doc.id, { tasks: [{ id: 't1', text: '读第二章', done: false }], cards: [{ front: '反馈是什么', back: '根据结果修正行动' }] }, 0);
  const fresh = await createStore({ vaultPath });
  const saved = await fresh.get(doc.id);
  assert.equal(saved.study.tasks.length, 1);
  assert.equal(saved.study.cards.length, 1);
  await assert.rejects(fresh.saveStudy({ id: doc.id, study: {}, expectedRevision: 0 }), e => e.status === 409);
});

test('migration copies originals, verifies hash through import, and remains idempotent', async t => {
  const { vaultPath, store } = await fixture(t);
  const old = join(vaultPath, 'old'); await mkdir(old);
  await writeFile(join(old, 'paper.md'), '# 旧文献\n\n原文保留');
  await writeFile(join(old, 'library.js'), 'throw new Error("must never execute")');
  const first = await store.migrate({ roots: [old] });
  assert.equal(first.imported, 1);
  assert.equal(first.errors.length, 0);
  assert.equal(await readFile(join(old, 'paper.md'), 'utf8'), '# 旧文献\n\n原文保留');
  const second = await store.migrate({ roots: [old] });
  assert.equal(second.imported, 0);
  assert.equal(second.duplicates, 1);
});

test('HTML extraction removes executable and hidden content and resolves text entities', () => {
  const text = htmlToText('<html><script>steal()</script><style>bad</style><article><h1>A &amp; B</h1><p>正文&#x4e2d;文</p></article></html>');
  assert.equal(text, 'A & B\n\n正文中文');
  assert.doesNotMatch(text, /steal|bad|<script>/);
});

test('blank query browses vault and supports md type alias and tags', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  await writeFile(join(vaultPath, '独立知识笔记.md'), '# 独立知识笔记\n\n可浏览的正文');
  assert.ok((await store.search({ q: '', scope: 'vault' })).some(hit => hit.path === '独立知识笔记.md'));
  const filtered = await store.search({ q: '', scope: 'library', type: 'md', tag: '工程' });
  assert.ok(filtered.length);
  assert.ok(filtered.every(hit => hit.id === doc.id));
});

test('parse failure preserves visible original and warning, and retry failure keeps it', async t => {
  const { store } = await fixture(t);
  const bytes = Buffer.from('%PDF-1.4\ncorrupt-but-preserved');
  const result = await store.importFile({ base64: bytes.toString('base64'), name: 'broken.pdf' });
  assert.equal(result.parseStatus, 'failed');
  assert.ok(result.warnings[0].includes('原件已保留'));
  assert.deepEqual(await readFile(result.originalPath), bytes);
  await assert.rejects(store.reparse(result.id), e => e.status === 422);
  assert.deepEqual(await readFile(result.originalPath), bytes);
  assert.ok((await store.list()).some(item => item.id === result.id));
});

test('citation metadata and titles persist with uploaded documents', async t => {
  const { store } = await fixture(t);
  const metadata = { title: 'Feedback systems', authors: ['A. Researcher'], year: 2026, doi: '10.1234/example' };
  const doc = await store.importFile({ base64: Buffer.from('A cited document.').toString('base64'), name: 'upload.md', metadata });
  assert.equal(doc.title, metadata.title);
  assert.deepEqual((await store.get(doc.id)).metadata, metadata);
  assert.deepEqual((await store.list()).find(item => item.id === doc.id).metadata, metadata);
});

test('global legacy learning archives are copied and indexed without deleting source', async t => {
  const { vaultPath, store } = await fixture(t);
  const old = join(vaultPath, 'old-study');
  await mkdir(join(old, 'profiles', 'course-1'), { recursive: true });
  const path = join(old, 'profiles', 'course-1', 'tasks.json');
  const content = JSON.stringify({ tasks: [{ text: '旧复习任务XYZ' }] });
  await writeFile(path, content);
  const result = await store.migrate({ roots: [], studyRoot: old });
  assert.equal(result.studyArchives.length, 1);
  assert.equal(await readFile(path, 'utf8'), content);
  assert.equal(await readFile(join(vaultPath, result.studyArchives[0].path), 'utf8'), content);
  assert.ok((await store.search({ q: '旧复习任务XYZ' })).length);
});

test('metadata edits preserve original names and handwritten Markdown while updating searchable tags', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  const note = '---\ntitle: 旧标题\ntags:\n  - 旧标签\ncustom: keep-me\n---\n\n# 手写标题\n\n人工正文必须逐字保留。\n';
  await store.saveNote({ id: doc.id, text: note, expectedRevision: 0 });
  const edited = await store.updateMetadata({ id: doc.id, title: '系统学习', tags: ['复习', '#工程', '复习'], expectedRevision: 0 });
  assert.equal(edited.metadataRevision, 1);
  assert.equal(edited.title, '系统学习');
  assert.equal(edited.metadata.title, '系统学习');
  assert.deepEqual(edited.tags, ['复习', '工程']);
  assert.equal(edited.originalPath, doc.originalPath);
  assert.match(edited.notes.text, /custom: keep-me/);
  assert.match(edited.notes.text, /title: "系统学习"/);
  assert.match(edited.notes.text, /tags: \["复习","工程"\]/);
  assert.equal(edited.notes.text.split('---\n')[2], '\n# 手写标题\n\n人工正文必须逐字保留。\n');
  assert.ok((await store.search({ q: '', scope: 'library', tag: '复习' })).some(hit => hit.id === doc.id));
  assert.equal((await store.list()).find(item => item.id === doc.id).metadataRevision, 1);
  const fresh = await createStore({ vaultPath });
  assert.equal((await fresh.get(doc.id)).metadataRevision, 1);
  await assert.rejects(fresh.updateMetadata({ id: doc.id, title: '过期窗口', expectedRevision: 0 }), error => error.status === 409);
  await assert.rejects(fresh.saveNote({ id: doc.id, text: '旧笔记窗口', expectedRevision: 1 }), error => error.status === 409);
});

test('metadata edits do not make externally edited generated bodies eligible for overwrite', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  await store.saveAnnotations({ id: doc.id, annotations: [{ text: 'old quote' }], expectedRevision: 0 });
  const dir = join(vaultPath, '文献库', '_data', 'annotations');
  const file = join(dir, (await readdir(dir))[0]);
  await writeFile(file, (await readFile(file, 'utf8')) + '\n手工注解保留\n');
  await store.updateMetadata({ id: doc.id, title: '标题改动', expectedRevision: 0 });
  await store.saveAnnotations({ id: doc.id, annotations: [{ text: 'new quote' }], expectedRevision: 1 });
  assert.match(await readFile(file, 'utf8'), /手工注解保留/);
  assert.match(await readFile(file, 'utf8'), /title: "标题改动"/);
  assert.ok((await readdir(dir)).some(name => name.endsWith('.generated.md')));
});

test('real vault folders load lazily through fifty levels and current-folder queries exclude descendants', async t => {
  const { vaultPath, store } = await fixture(t);
  let path = '';
  for (let level = 0; level < 50; level++) path = (await store.folder({ action: 'create', path, name: '层' + level })).path;
  await writeFile(join(vaultPath, path, '深层.md'), '# 深层\n\ndeepcurrentquery');
  await writeFile(join(vaultPath, '当前.md'), '# 当前\n\ndeepcurrentquery');
  assert.ok((await store.folders({ path: '' })).folders.some(folder => folder.path === '层0' && folder.hasChildren));
  const selected = await store.files({ path });
  assert.equal(selected.documents.length, 1);
  assert.equal(selected.documents[0].name, '深层.md');
  assert.equal((await store.search({ q: 'deepcurrentquery', path: '' })).length, 1);
  assert.equal((await store.search({ q: 'deepcurrentquery', path })).length, 1);
  assert.equal((await store.search({ q: 'deepcurrentquery', path: '层0' })).length, 0);
});

test('existing Markdown registers in place, preserves equal-content identities, and follows external edits', async t => {
  const { vaultPath, store } = await fixture(t);
  await mkdir(join(vaultPath, '领域'));
  await writeFile(join(vaultPath, '领域', '原生.md'), '# 原生\n\nvaultcanonical');
  await writeFile(join(vaultPath, '领域', '副本.md'), '# 原生\n\nvaultcanonical');
  const before = await readdir(join(vaultPath, '文献库', '未分类'));
  const one = await store.register({ path: '领域/原生.md' });
  const again = await store.register({ path: '领域/原生.md' });
  const equal = await store.register({ path: '领域/副本.md' });
  assert.equal(one.id, again.id);
  assert.notEqual(one.id, equal.id);
  assert.equal(one.originalPath, await realpath(join(vaultPath, '领域', '原生.md')));
  assert.deepEqual(await readdir(join(vaultPath, '文献库', '未分类')), before);
  assert.equal(one.notes.path, null);
  await writeFile(one.originalPath, '# 原生\n\nchangedcanonical');
  const changed = await store.get(one.id);
  assert.match(changed.text, /changedcanonical/);
  assert.equal(changed.fileRevision, 2);
  assert.ok((await store.search({ q: 'changedcanonical', path: '领域' })).some(hit => hit.id === one.id));
});

test('folder operations reject escapes, outside symlinks, cycles, and overwrites', async t => {
  const { vaultPath, store } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(vaultPath, '外部'));
  await store.folder({ action: 'create', path: '', name: '甲' });
  await store.folder({ action: 'create', path: '甲', name: '子' });
  await store.folder({ action: 'create', path: '', name: '乙' });
  await assert.rejects(store.folder({ action: 'create', path: '../', name: '逃逸' }), error => error.status === 403);
  await assert.rejects(store.folder({ action: 'create', path: '外部', name: '逃逸' }), error => error.status === 403);
  await assert.rejects(store.folder({ action: 'move', path: '甲', destination: '甲/子' }), error => error.code === 'folder-cycle');
  await assert.rejects(store.folder({ action: 'rename', path: '甲', name: '乙' }), error => error.code === 'destination-exists');
  await assert.rejects(store.folder({ action: 'create', path: '', name: '_data' }), error => error.status === 400);
  assert.deepEqual(await readdir(outside), []);
});

test('notes are lazy, named once, move with their document, and keep all associated identifiers', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  assert.equal(doc.notes.path, null);
  const noted = await store.saveNote({ id: doc.id, text: '长期保留', expectedRevision: 0 });
  assert.equal(dirname(noted.notes.path), dirname(noted.path));
  assert.match(basename(noted.notes.path), /^control笔记\d{4}-\d{2}-\d{2}\.md$/);
  await store.saveSession({ id: doc.id, sessionId: 'persist-session', messages: [{ id: 'm1', role: 'user', text: '保存会话' }] });
  await store.saveStudy({ id: doc.id, study: { tasks: [{ id: 't1', text: '保存学习' }] }, expectedRevision: 0 });
  await store.folder({ action: 'create', path: '', name: '目标' });
  const moved = await store.moveDocument({ id: doc.id, destination: '目标', name: '新文件名.md' });
  assert.equal(moved.id, doc.id);
  assert.equal(moved.notes.createdDate, noted.notes.createdDate);
  assert.equal(moved.notes.path, '目标/新文件名笔记' + noted.notes.createdDate + '.md');
  assert.equal(moved.notes.text, '长期保留');
  assert.equal(moved.sessions[0].sessionId, 'persist-session');
  assert.equal(moved.study.tasks[0].id, 't1');
  assert.equal(await readFile(join(vaultPath, moved.notes.path), 'utf8'), '长期保留');
  await assert.rejects(stat(doc.originalPath), { code: 'ENOENT' });
  const renamed = await store.folder({ action: 'rename', path: '目标', name: '领域' });
  assert.equal(renamed.path, '领域');
  const current = await store.get(doc.id);
  assert.equal(current.path, '领域/新文件名.md');
  assert.equal(current.notes.path, '领域/新文件名笔记' + noted.notes.createdDate + '.md');
});

test('same-name notes and document move destinations are never overwritten', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const conflict = join(dirname(doc.originalPath), 'control笔记' + date + '.md');
  await writeFile(conflict, '独立人工文件');
  await assert.rejects(store.saveNote({ id: doc.id, text: '插件笔记', expectedRevision: 0 }), error => error.code === 'note-name-conflict');
  assert.equal(await readFile(conflict, 'utf8'), '独立人工文件');
  assert.equal((await store.get(doc.id)).notes.path, null);
  await mkdir(join(vaultPath, '目标'));
  await writeFile(join(vaultPath, '目标', 'control.md'), '目标文档');
  await assert.rejects(store.moveDocument({ id: doc.id, destination: '目标' }), error => error.code === 'destination-exists');
  assert.equal(await readFile(join(vaultPath, '目标', 'control.md'), 'utf8'), '目标文档');
});

test('inline notes and editable Markdown share stable blocks and reject stale annotation writes', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  const annotated = await store.saveAnnotations({ id: doc.id, annotations: [{ id: 'a1', type: 'highlight', anchor: { quote: '选中文本' }, note: '初始旁注' }], expectedRevision: 0 });
  const block = annotated.notes.blocks[0];
  assert.equal(block.annotationId, 'a1');
  assert.equal(annotated.annotations.items[0].noteId, block.id);
  const edited = await store.saveNote({ id: doc.id, freeText: '# 随记\n\n自行编辑', blocks: [{ ...block, text: '编辑后的旁注' }], expectedRevision: annotated.notes.revision });
  assert.equal(edited.annotations.items[0].note, '编辑后的旁注');
  assert.equal(edited.notes.blocks[0].id, block.id);
  await assert.rejects(store.saveAnnotations({ id: doc.id, annotations: annotated.annotations.items, expectedRevision: annotated.annotations.revision }), error => error.status === 409);
  const path = join(vaultPath, edited.notes.path);
  await writeFile(path, (await readFile(path, 'utf8')).replace('编辑后的旁注', 'Obsidian旁注'));
  const external = await store.get(doc.id);
  assert.equal(external.notes.blocks[0].text, 'Obsidian旁注');
  assert.equal(external.annotations.items[0].note, 'Obsidian旁注');
  assert.match(external.notes.freeText, /自行编辑/);
  await assert.rejects(store.saveAnnotations({ id: doc.id, annotations: [], expectedRevision: external.annotations.revision, expectedNotesRevision: edited.notes.revision }), error => error.code === 'revision-conflict');
  const panelEdit = await store.saveAnnotations({ id: doc.id, annotations: external.annotations.items.map(mark => ({ ...mark, note: '在批注栏编辑' })), expectedRevision: external.annotations.revision, expectedNotesRevision: external.notes.revision });
  assert.equal(panelEdit.notes.blocks[0].text, '在批注栏编辑');
  const standalone = await store.saveNote({ id: doc.id, expectedRevision: panelEdit.notes.revision, content: [...panelEdit.notes.content, { kind: 'quote', id: 'standalone', quote: '独立引文', text: '独立笔记' }] });
  const removed = await store.saveAnnotations({ id: doc.id, annotations: [], expectedRevision: standalone.annotations.revision, expectedNotesRevision: standalone.notes.revision });
  assert.deepEqual(removed.notes.blocks.map(note => note.id), ['standalone']);
  assert.match(removed.notes.text, /独立笔记/);
  assert.doesNotMatch(removed.notes.text, /在批注栏编辑/);
  assert.equal((await store.register({ path: removed.notes.path })).id, doc.id);
});

test('legacy layout migration journals verified copies, resumes after commit, and preserves UUID and geometry', async t => {
  const vaultPath = await mkdtemp(join(tmpdir(), 'dsh-hub-v1-'));
  t.after(() => rm(vaultPath, { recursive: true, force: true }));
  const id = randomUUID(), root = join(vaultPath, '文献库');
  for (const dir of ['_data', '附件', '正文', '笔记', '批注', '对话', '学习']) await mkdir(join(root, dir), { recursive: true });
  const source = Buffer.from('%PDF-1.4 legacy preserved original'), preview = Buffer.from('%PDF-1.4 legacy preview'), note = '# 旧笔记\n\n人工记录';
  const digest = value => createHash('sha256').update(value).digest('hex');
  const originalPath = '附件/' + id + '.pdf', pdfPath = '附件/' + id + '.preview.pdf', notePath = '笔记/旧名称.md';
  await writeFile(join(root, originalPath), source); await writeFile(join(root, pdfPath), preview); await writeFile(join(root, notePath), note);
  await writeFile(join(vaultPath, '独立文件.md'), '# 外部内容\n保持不动');
  const record = { id, title: '旧文献', type: 'pdf', source: { type: 'file' }, hash: digest(source), originalPath, pdfPath, notePath, textPath: '正文/旧名称.md', annotationsPath: '批注/旧名称.md', studyPath: '学习/旧名称.md', text: '旧正文', pages: [{ page: 1, text: '旧正文' }], notes: { revision: 7, hash: digest(note) }, annotations: { revision: 4, items: [{ id: 'legacy-a', page: 1, rects: [{ x: .1, y: .2, width: .2, height: .02 }], anchor: { quote: '旧引文' }, note: '旧旁注' }] }, study: { revision: 3, cards: [{ id: 'card1', front: '问题' }] }, sessions: [{ sessionId: 'native-session', messages: [{ id: 'm1', text: '旧对话' }] }], createdAt: '2026-01-03T00:00:00.000Z' };
  await writeFile(join(root, '_data', id + '.json'), JSON.stringify(record));
  const store = await createStore({ vaultPath });
  const report = await store.migrateLayout();
  assert.deepEqual(report.errors, []); assert.equal(report.migrated, 1);
  const migrated = await store.get(id);
  assert.equal(migrated.id, id); assert.equal(migrated.path, '文献库/未分类/旧文献.pdf');
  assert.equal(migrated.notes.path, '文献库/未分类/旧文献笔记2026-01-03.md');
  assert.equal(migrated.notes.revision, 7); assert.match(migrated.notes.text, /人工记录/);
  assert.equal(migrated.notes.blocks[0].text, '旧旁注');
  assert.deepEqual(migrated.annotations.items[0].rects, record.annotations.items[0].rects);
  assert.equal(migrated.sessions[0].sessionId, 'native-session'); assert.equal(migrated.study.revision, 3);
  assert.deepEqual(await readFile(migrated.originalPath), source); assert.deepEqual(await readFile(migrated.pdfPath), preview);
  assert.equal(await readFile(join(vaultPath, '独立文件.md'), 'utf8'), '# 外部内容\n保持不动');
  const journalPath = join(root, '_data', 'layout-migration.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.documents[id].state = 'committed';
  for (const file of journal.documents[id].files) file.state = 'verified';
  await writeFile(journalPath, JSON.stringify(journal));
  const resumed = await store.migrateLayout(); assert.deepEqual(resumed.errors, []); assert.equal(resumed.resumed, 1);
  assert.equal((await store.migrateLayout()).migrated, 0);
  const fresh = await createStore({ vaultPath }); assert.equal((await fresh.get(id)).notes.blocks[0].id, migrated.notes.blocks[0].id);
});

test('local source revisions mark previous annotations stale, and closing stops future work', async t => {
  const { store, doc } = await fixture(t);
  await store.saveAnnotations({ id: doc.id, annotations: [{ id: 'a1', anchor: { quote: 'Feedback' }, rects: [{ x: .1, y: .2, width: .3, height: .04 }] }], expectedRevision: 0 });
  await writeFile(doc.originalPath, '# 修改后的原件\n\n不同正文');
  const revised = await store.get(doc.id);
  assert.equal(revised.fileRevision, 2); assert.equal(revised.annotations.items[0].stale, true);
  store.close();
  await assert.rejects(store.search({ q: '' }), error => error.code === 'store-closed');
  await assert.rejects(store.importFile({ base64: 'eA==', name: 'new.txt' }), error => error.code === 'store-closed');
});

test('failed Word reparse retains its failure status and the previous preview stays readable', async t => {
  const { vaultPath, store } = await fixture(t);
  const zip = new JSZip(); zip.file('not-a-word-document.txt', '');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const doc = await store.importFile({ name: 'broken.docx', base64: bytes.toString('base64') });
  assert.equal(doc.parseStatus, 'failed');
  const reparsed = await store.reparse(doc.id);
  assert.equal(reparsed.parseStatus, 'failed');
  assert.deepEqual(await readFile(reparsed.originalPath), bytes);
  // Seed a preserved old preview to verify failed regeneration never deletes it.
  const recordPath = join(vaultPath, '文献库', '_data', doc.id + '.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  const oldPath = '文献库/_data/previews/' + doc.id + '.old.pdf';
  await writeFile(join(vaultPath, oldPath), '%PDF-1.4 old preview');
  Object.assign(record, { pdfPath: oldPath, previewRevision: 1, previewHistory: [{ revision: 1, path: oldPath, pageCount: 12, createdAt: doc.createdAt }], pageCount: 12 });
  await writeFile(recordPath, JSON.stringify(record));
  const failed = await store.reparse(doc.id);
  assert.equal(failed.parseStatus, 'failed');
  assert.equal(failed.previewRevision, 1);
  assert.equal(await readFile(await store.filePath(doc.id, 'pdf', 1), 'utf8'), '%PDF-1.4 old preview');
  assert.equal((await store.saveProgress({ id: doc.id, page: 8 })).progress.page, 8);
});

test('preview versions retain old PDF coordinates and expose historical files after repagination', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  const recordPath = join(vaultPath, '文献库', '_data', doc.id + '.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  const oldPath = '文献库/_data/previews/' + doc.id + '.r1.pdf';
  const newPath = '文献库/_data/previews/' + doc.id + '.r2.pdf';
  await writeFile(join(vaultPath, oldPath), '%PDF-1.4 old-page-layout');
  await writeFile(join(vaultPath, newPath), '%PDF-1.4 new-page-layout');
  Object.assign(record, { pdfPath: oldPath, previewRevision: 1, previewHistory: [{ revision: 1, path: oldPath, pageCount: 2 }] });
  await writeFile(recordPath, JSON.stringify(record));
  const annotated = await store.saveAnnotations({ id: doc.id, annotations: [{ id: 'rect', rects: [{ x: .1, y: .2, width: .3, height: .02 }] }, { id: 'text', anchor: { quote: 'Feedback' } }], expectedRevision: 0 });
  assert.equal(annotated.annotations.items[0].previewRevision, 1);
  const updated = JSON.parse(await readFile(recordPath, 'utf8'));
  Object.assign(updated, { pdfPath: newPath, previewRevision: 2, previewHistory: [...updated.previewHistory, { revision: 2, path: newPath, pageCount: 3 }] });
  await writeFile(recordPath, JSON.stringify(updated));
  const changed = await store.get(doc.id);
  assert.equal(changed.hash, doc.hash);
  assert.equal(changed.annotations.items.find(annotation => annotation.id === 'rect').stale, true);
  assert.equal(changed.annotations.items.find(annotation => annotation.id === 'text').stale, false);
  assert.equal(await readFile(await store.filePath(doc.id, 'pdf', { revision: 1 }), 'utf8'), '%PDF-1.4 old-page-layout');
  assert.equal(await readFile(await store.filePath(doc.id, 'pdf', 2), 'utf8'), '%PDF-1.4 new-page-layout');
  await assert.rejects(store.filePath(doc.id, 'pdf', 99), error => error.status === 404);
});

test('one ordered note preserves frontmatter, editable references, audio, and Obsidian revisions', async t => {
  const { vaultPath, store: first, doc } = await fixture(t);
  const frontmatter = '---\ntitle: 手写标题\ncustom:\n  source: 保留\n---\n';
  await first.saveNote({ id: doc.id, text: frontmatter + '# 方法\n\n1. 第一段\n   1. 子项\n', expectedRevision: 0 });
  const marked = await first.saveAnnotations({ id: doc.id, annotations: [{ id: 'mark', type: 'highlight', page: 1, anchor: { quote: 'Feedback', start: 18, end: 26 } }], expectedRevision: 0 });
  const quote = marked.notes.content.find(node => node.kind === 'quote');
  assert.equal(quote.text, '');
  assert.equal(quote.id, marked.annotations.items[0].noteId);
  const assetPath = `文献库/_data/recordings/${doc.id}/voice.webm`;
  const store = await createStore({ vaultPath, resolveAudioAsset: ({ id, assetId }) => id === doc.id && assetId === 'voice' ? { path: assetPath, title: '口述复习' } : null });
  await assert.rejects(store.saveNote({ id: doc.id, expectedRevision: marked.notes.revision, content: [{ kind: 'audio', id: 'foreign-note', assetId: 'foreign-voice' }] }), error => error.code === 'audio-not-found');
  const saved = await store.saveNote({ id: doc.id, expectedRevision: marked.notes.revision, content: [
    { kind: 'markdown', markdown: '# 方法\n\n1. 第一段\n   1. 子项\n' },
    { ...quote, quote: '编辑后的引文', text: '**引文笔记**', anchor: { quote: '错误来源' } },
    { kind: 'markdown', markdown: '\n## 说明\n\n录音前后都能写字。\n' },
    { kind: 'audio', id: 'voice-note', assetId: 'voice' },
    { kind: 'markdown', markdown: '\n## 后续\n\n待复习。\n' },
  ] });
  const { notes } = saved;
  assert.equal(notes.frontmatter, frontmatter);
  assert.deepEqual(notes.content.map(node => node.kind), ['markdown', 'quote', 'markdown', 'audio', 'markdown']);
  assert.equal(notes.content[1].anchor.quote, 'Feedback');
  assert.equal(notes.content[1].quote, '编辑后的引文');
  assert.match(notes.text, /!\[口述复习\]\(<\.\.\/_data\/recordings\/[^/]+\/voice\.webm>\)/);
  assert.ok(notes.text.startsWith(frontmatter));
  assert.ok(notes.text.indexOf('## 说明') < notes.text.indexOf('dlh-audio:'));
  assert.ok(notes.text.indexOf('## 后续') > notes.text.indexOf('dlh-audio:'));
  const hits = await store.search({ q: '引文笔记', path: doc.folder });
  assert.ok(hits.some(hit => hit.kind === 'note' && hit.noteId === quote.id && hit.linkedDocumentId === doc.id));
  assert.ok(hits.every(hit => hit.kind !== 'annotation'));
  assert.deepEqual((await store.files({ path: doc.folder })).documents.map(entry => entry.id), [doc.id]);
  await writeFile(join(vaultPath, notes.path), notes.text.replace('> 编辑后的引文', '> Obsidian 引文').replace('**引文笔记**', 'Obsidian 新笔记'));
  await assert.rejects(store.saveNote({ id: doc.id, expectedRevision: notes.revision, content: notes.content }), error => error.code === 'revision-conflict');
  const external = await store.get(doc.id);
  assert.equal(external.notes.content[1].quote, 'Obsidian 引文');
  assert.equal(external.notes.content[1].anchor.quote, 'Feedback');
  assert.equal(external.annotations.items[0].note, 'Obsidian 新笔记');
  await assert.rejects(store.saveNote({ id: doc.id, expectedRevision: external.notes.revision, freeText: '旧编辑器覆盖' }), error => error.code === 'note-format-conflict');
  const legacy = await store.saveNote({ id: doc.id, expectedRevision: external.notes.revision, blocks: external.notes.blocks.map(block => ({ ...block, text: '旧接口修改引文笔记' })) });
  assert.deepEqual(legacy.notes.content.map(node => node.kind), ['markdown', 'quote', 'markdown', 'audio', 'markdown']);
  assert.equal(legacy.notes.content[1].text, '旧接口修改引文笔记');
});

test('removing and restoring a linked reference also removes and restores its source mark', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  const annotated = await store.saveAnnotations({ id: doc.id, annotations: [{ id: 'mark', type: 'underline', anchor: { quote: 'Feedback' } }, { id: 'other', type: 'highlight', anchor: { quote: 'closed loop' } }], expectedRevision: 0 });
  const content = [{ kind: 'markdown', markdown: '保留自由段落' }, ...annotated.notes.content.filter(note => note.kind === 'quote' && note.annotationId === 'other')];
  const change = { id: doc.id, content, expectedRevision: annotated.notes.revision };
  await assert.rejects(store.saveNote({ ...change, expectedAnnotationsRevision: 0 }), error => error.code === 'revision-conflict');
  const removed = await store.saveNote({ ...change, expectedAnnotationsRevision: annotated.annotations.revision });
  assert.deepEqual(removed.annotations.items.map(mark => mark.id), ['other']);
  assert.deepEqual(removed.notes.blocks.map(note => note.annotationId), ['other']);
  const mirror = join(vaultPath, '文献库', '_data', 'annotations', `${doc.id}.md`);
  assert.doesNotMatch(await readFile(mirror, 'utf8'), /annotation:mark/);
  const fresh = await createStore({ vaultPath });
  const loaded = await fresh.get(doc.id);
  const restore = { id: doc.id, expectedRevision: loaded.notes.revision, expectedAnnotationsRevision: loaded.annotations.revision, restoreAnnotations: [annotated.annotations.items[0]] };
  await assert.rejects(fresh.saveNote({ ...restore, content }), error => error.code === 'annotation-restore-conflict');
  const restored = await fresh.saveNote({ ...restore, content: [...loaded.notes.content, annotated.notes.content.find(note => note.annotationId === 'mark')] });
  assert.deepEqual(restored.annotations.items.map(mark => mark.id), ['other', 'mark']);
  assert.deepEqual(restored.notes.blocks.map(note => note.annotationId), ['other', 'mark']);
  assert.equal(restored.annotations.items[1].anchor.quote, 'Feedback');
});

test('rename changes original and note together while retaining identity, citations, and original bytes', async t => {
  const { vaultPath, store, doc, source } = await fixture(t);
  const marked = await store.saveAnnotations({ id: doc.id, annotations: [{ id: 'mark', anchor: { quote: 'Feedback' }, note: '保留' }], expectedRevision: 0 });
  const conflict = join(dirname(doc.originalPath), `冲突笔记${marked.notes.createdDate}.md`);
  await writeFile(conflict, '独立文件');
  await assert.rejects(store.renameDocument({ id: doc.id, name: '冲突', expectedRevision: 0 }), error => error.code === 'note-name-conflict');
  assert.equal(await readFile(conflict, 'utf8'), '独立文件');
  await assert.rejects(stat(join(dirname(doc.originalPath), '冲突.md')), { code: 'ENOENT' });
  const renamed = await store.renameDocument({ id: doc.id, name: '方法.反馈', expectedRevision: 0 });
  assert.equal(renamed.id, doc.id);
  assert.equal(renamed.hash, doc.hash);
  assert.equal(renamed.title, '方法.反馈');
  assert.equal(renamed.metadata.title, doc.title);
  assert.equal(renamed.name, '方法.反馈.md');
  assert.equal(basename(renamed.notes.path), `方法.反馈笔记${marked.notes.createdDate}.md`);
  assert.equal(await readFile(renamed.originalPath, 'utf8'), source);
  assert.equal(renamed.notes.blocks[0].id, marked.notes.blocks[0].id);
  assert.ok(renamed.notes.text.includes(encodeURIComponent(renamed.name)));
  await assert.rejects(stat(doc.originalPath), { code: 'ENOENT' });
  await assert.rejects(stat(join(vaultPath, marked.notes.path)), { code: 'ENOENT' });
  await assert.rejects(store.renameDocument({ id: doc.id, name: '版本过期', expectedRevision: 0 }), error => error.code === 'revision-conflict');
  assert.ok((await store.search({ q: '方法.反馈', path: doc.folder })).some(hit => hit.id === doc.id && hit.kind === 'document'));
});

test('an interrupted rename rolls back only its own staged links on next startup', async t => {
  const { vaultPath, doc, source } = await fixture(t);
  const to = `${doc.folder}/未完成.md`, temp = `${doc.folder}/.fixture-rename.tmp`;
  await writeFile(join(vaultPath, temp), source);
  await link(join(vaultPath, temp), join(vaultPath, to));
  const journal = join(vaultPath, '文献库', '_data', 'pending-rename.json');
  await writeFile(journal, JSON.stringify({ id: doc.id, next: to, revision: 1, files: [{ from: doc.path, to, temp, hash: doc.hash, nextHash: doc.hash }] }));
  const recovered = await createStore({ vaultPath });
  assert.equal((await recovered.get(doc.id)).path, doc.path);
  assert.equal(await readFile(doc.originalPath, 'utf8'), source);
  for (const path of [join(vaultPath, to), join(vaultPath, temp), journal]) await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('custom labels match complete tags and can be edited without modifying vault Markdown', async t => {
  const { vaultPath, store } = await fixture(t);
  const body = '---\ntags:\n  - 生物信息\n  - 自定义\n---\n\n标签原文保持';
  await writeFile(join(vaultPath, '标签.md'), body);
  assert.equal((await store.search({ path: '', tag: '生物' })).length, 0);
  assert.equal((await store.search({ path: '', tag: '生物信息' })).length, 1);
  const registered = await store.register({ path: '标签.md' });
  assert.deepEqual(registered.tags, ['生物信息', '自定义']);
  const updated = await store.updateMetadata({ id: registered.id, tags: ['#自定义', '实验'], expectedRevision: 0 });
  assert.deepEqual(updated.tags, ['自定义', '实验']);
  assert.equal((await store.search({ path: '', tag: '生物信息' })).length, 0);
  assert.ok((await store.search({ path: '', tag: '#实验' })).some(hit => hit.id === registered.id));
  assert.equal(await readFile(registered.originalPath, 'utf8'), body);
});

test('old and new drawings project into the same note with page, position, labels, and frontmatter intact', async t => {
  const { vaultPath, store, doc } = await fixture(t);
  const frontmatter = '---\r\ntitle: 手写笔记题名\r\ncustom: 原始属性\r\n---\r\n';
  await store.saveNote({ id: doc.id, text: frontmatter + '自己写的正文', expectedRevision: 0 });
  const path = join(vaultPath, '文献库', '_data', doc.id + '.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  const points = [{ x: .1, y: .2 }, { x: .2, y: .25 }];
  record.annotations.items.push({ id: 'old-draw', type: 'draw', page: 2, points, tags: ['原始图示'] });
  await writeFile(path, JSON.stringify(record));
  const existing = await store.get(doc.id);
  const old = existing.notes.blocks.find(node => node.annotationId === 'old-draw');
  assert.equal(old.quote, '第 2 页 · 勾画');
  assert.deepEqual(old.anchor.points, points);
  assert.equal(existing.notes.frontmatter, frontmatter);
  const saved = await store.saveAnnotations({ id: doc.id, expectedRevision: existing.annotations.revision, annotations: [...existing.annotations.items, { id: 'new-draw', type: 'draw', page: 3, points, tags: ['#研究图示', '研究图示'] }] });
  assert.equal(saved.notes.blocks[0].id, old.id);
  assert.equal(saved.notes.blocks[1].quote, '第 3 页 · 勾画');
  assert.deepEqual(saved.notes.blocks[1].anchor.points, points);
  assert.deepEqual(saved.annotations.items[1].tags, ['研究图示']);
  assert.ok((await store.search({ tag: '研究图示', path: doc.folder })).some(hit => hit.kind === 'note' && hit.noteId === saved.notes.blocks[1].id));
  assert.equal((await store.search({ tag: '研究', path: doc.folder })).length, 0);
  const tagged = await store.updateMetadata({ id: doc.id, tags: ['课程材料'], expectedRevision: 0 });
  assert.match(tagged.notes.frontmatter, /^---\r\ntitle: 手写笔记题名\r\ncustom: 原始属性\r\ntags: \["课程材料"\]\r\n---\r\n$/);
  assert.equal(tagged.notes.blocks[1].id, saved.notes.blocks[1].id);
});
