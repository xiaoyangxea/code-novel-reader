import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const built = await esbuild.build({ stdin: { contents: `
  export { ReaderController, ReaderDocumentProvider } from './src/reader';
  export { DownloadManager } from './src/download';
  export { saveBoss } from './src/boss';
  export { configureBoss } from './src/boss';
  export { ui, window, Uri } from './tests/vscode-mock.mjs';
  export { renderReaderLayout } from './src/renderer';
  export { readingTemplates } from './src/reading-templates';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'vscode-test-double', setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: path.resolve('tests/vscode-mock.mjs') })); } }] });
const compiled = new Module(path.resolve('tests/test-runtime.cjs'));
compiled.filename = path.resolve('tests/test-runtime.cjs');
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(built.outputFiles[0].text, compiled.filename);
const { ReaderController, ReaderDocumentProvider, DownloadManager, saveBoss, configureBoss, ui, window, Uri, renderReaderLayout, readingTemplates } = compiled.exports;
const book = { id: '0123456789abcdef0123', title: '测试书', kind: 'online', source: 'https://example.com/', catalogComplete: true,
  chapters: Array.from({ length: 4 }, (_, i) => ({ title: `第${i + 1}章`, url: `https://example.com/${i}.html` })) };

function context(saved = new Map()) {
  return { globalStorageUri: Uri.file(tmpdir()), globalState: {
    get: (key, fallback) => saved.has(key) ? structuredClone(saved.get(key)) : fallback,
    update: async (key, value) => { saved.set(key, structuredClone(value)); }
  } };
}
const until = async (predicate) => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 10)); }
  assert.fail('background task did not reach expected state');
};

test('boss mode shows the saved snapshot, keeps chapter prefetch running, and restores the reading page', async () => {
  ui.configuration = {};
  const ctx = context(new Map([['codeNovel.bossContent', 'const work = 42;']]));
  const provider = new ReaderDocumentProvider();
  const requested = [];
  const chapters = { allowBook() {}, get: async (_, index) => {
    requested.push(index); return { title: `第${index + 1}章`, content: '正文'.repeat(1500), url: book.chapters[index].url };
  } };
  const repository = { getProgress: () => ({ chapterIndex: 0, pageIndex: 1, updatedAt: 0 }),
    saveProgress: async () => undefined, saveBook: async () => undefined };
  const reader = new ReaderController(repository, provider, {}, ctx, chapters);
  await reader.openBook(book);
  const original = provider.provideTextDocumentContent();
  reader.toggleBoss();
  assert.equal(provider.provideTextDocumentContent(), 'const work = 42;');
  await until(() => requested.length === 4);
  assert.deepEqual(requested, [0, 1, 2, 3]);
  reader.toggleBoss();
  assert.equal(provider.provideTextDocumentContent(), original);
  await reader.dispose();
});

test('opening an old reversed catalog preserves the current chapter by URL after correcting its order', async () => {
  ui.configuration = { prefetchNextChapter: false };
  const reversed = { ...book, source: 'https://book.qq.com/book-chapter/1',
    chapters: [3, 2, 1].map((i) => ({ title: `第${i}章`, url: `https://book.qq.com/book-read/1/${i}` })) };
  const saved = { chapterIndex: 0, pageIndex: 0, updatedAt: 123 };
  const stored = [];
  const repository = { getProgress: () => ({ ...saved }), saveProgress: async (_, progress) => stored.push({ ...progress }), saveBook: async () => undefined };
  let requested;
  const chapters = { allowBook() {}, get: async (current, index) => {
    requested = current.chapters[index].url; return { title: current.chapters[index].title, content: '原创测试内容。'.repeat(40), url: requested };
  } };
  const reader = new ReaderController(repository, new ReaderDocumentProvider(), {}, context(), chapters);
  await reader.openBook(reversed);
  assert.equal(requested, 'https://book.qq.com/book-read/1/3');
  assert.equal(stored[0].chapterIndex, 2);
  assert.equal(reversed.chapters[0].title, '第3章');
  await reader.dispose();
});

test('custom boss snapshots are saved as text and oversized content is rejected', async () => {
  const ctx = context();
  window.activeTextEditor = { document: { uri: Uri.parse('untitled:work.ts'), getText: () => 'function work() {\n  return 1;\n}' } };
  await saveBoss(ctx, { refreshBossContent() {} });
  assert.equal(ctx.globalState.get('codeNovel.bossContent'), 'function work() {\n  return 1;\n}');
  window.activeTextEditor.document.getText = () => 'x'.repeat(256001);
  await assert.rejects(saveBoss(ctx, { refreshBossContent() {} }), /256 KB/);
});

test('a late chapter response cannot overwrite a different book opened meanwhile', async () => {
  ui.configuration = { prefetchNextChapter: false };
  let release;
  const secondBook = { ...book, id: '1123456789abcdef0123', title: '第二本' };
  const chapters = { allowBook() {}, get: async (current, index) => {
    if (current.id === book.id) await new Promise((resolve) => { release = resolve; });
    return { title: current.title, content: current.title, url: current.chapters[index].url };
  } };
  const provider = new ReaderDocumentProvider();
  const repository = { getProgress: () => ({ chapterIndex: 0, pageIndex: 0, updatedAt: 0 }),
    saveProgress: async () => undefined, saveBook: async () => undefined };
  const reader = new ReaderController(repository, provider, {}, context(), chapters);
  const first = reader.openBook(book);
  await until(() => Boolean(release));
  await reader.openBook(secondBook);
  const expected = provider.provideTextDocumentContent();
  release(); await first;
  assert.equal(reader.getActiveBook().id, secondBook.id);
  assert.equal(provider.provideTextDocumentContent(), expected);
  await reader.dispose();
});

test('whole-book download persists pause state, resumes, reuses cache and exports ordered TXT', async () => {
  const saved = new Map();
  const ctx = context(saved);
  const cached = new Map();
  let fail = true;
  const requested = [];
  const repository = { getBook: () => book, readCachedChapter: async (_, url) => cached.get(url) };
  const chapters = { allowBook() {}, get: async (_, index) => {
    const ref = book.chapters[index];
    if (cached.has(ref.url)) return cached.get(ref.url);
    requested.push(index);
    if (index === 1 && fail) throw new Error('需要验证');
    const content = { ...ref, content: `正文${index + 1}` }; cached.set(ref.url, content); return content;
  } };
  const manager = new DownloadManager(ctx, repository, chapters, async () => undefined);
  ui.choices = [{ value: 'all' }];
  await manager.manage(book);
  await until(() => manager.states[book.id]?.status === 'paused' && !manager.running);
  assert.equal(manager.states[book.id].completed, 1);
  assert.match(manager.states[book.id].failures[book.chapters[1].url], /验证/);
  fail = false;
  ui.choices = [{ value: 'resume' }];
  await manager.manage(book);
  await until(() => manager.states[book.id]?.status === 'completed');
  assert.deepEqual(requested, [0, 1, 1, 2, 3]);
  assert.equal(saved.get('codeNovel.downloads.v1')[book.id].completed, 4);
  const directory = await mkdtemp(path.join(tmpdir(), 'code-novel-export-test-'));
  try {
    ui.saveTarget = Uri.file(path.join(directory, 'test.txt'));
    ui.choices = [{ value: 'export' }];
    await manager.manage(book);
    const text = await readFile(ui.saveTarget.fsPath, 'utf8');
    assert.ok(text.indexOf('第1章') < text.indexOf('第4章'));
    assert.match(text, /正文4/);
    assert.doesNotMatch(text, /本章未缓存/);
  } finally { manager.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('download restart leaves unfinished work paused until explicitly resumed', async () => {
  const state = { urls: book.chapters.map((r) => r.url), status: 'running', completed: 2, failures: {} };
  const manager = new DownloadManager(context(new Map([['codeNovel.downloads.v1', { [book.id]: state }]])), {}, {}, async () => undefined);
  assert.equal(manager.states[book.id].status, 'paused');
  manager.dispose();
});

test('reader template switching preserves paging, cache calls, progress and boss mode and restores after restart', async () => {
  ui.configuration = { prefetchNextChapter: false };
  ui.editorDocument = undefined;
  const saved = new Map();
  const ctx = context(saved);
  let progress = { chapterIndex: 0, pageIndex: 0, updatedAt: 0 };
  let requests = 0;
  const repository = { getProgress: () => ({ ...progress }),
    saveProgress: async (_, value) => { progress = { ...value }; }, saveBook: async () => undefined,
    deleteCachedChapter: async () => undefined };
  const chapters = { allowBook() {}, get: async (_, index) => {
    requests++;
    return { title: book.chapters[index].title, url: book.chapters[index].url, content: '原创测试正文。'.repeat(900) };
  } };
  const provider = new ReaderDocumentProvider();
  const reader = new ReaderController(repository, provider, {}, ctx, chapters);
  await reader.openBook(book);
  await reader.nextPage();
  ui.choices = [{ id: 'events' }];
  await reader.switchReadingTemplate();
  const expected = provider.provideTextDocumentContent();
  assert.match(expected, /export class EventBus/);
  assert.match(expected, /page 2\//);
  assert.equal(requests, 1);
  await reader.reloadChapter();
  assert.equal(provider.provideTextDocumentContent(), expected, 'refresh keeps the same chapter template');
  assert.equal(requests, 2);
  await reader.nextPage();
  assert.match(provider.provideTextDocumentContent(), /export class EventBus/);
  reader.toggleBoss();
  const hidden = provider.provideTextDocumentContent();
  ui.choices = [{ id: 'cache' }];
  await reader.switchReadingTemplate();
  assert.equal(provider.provideTextDocumentContent(), hidden);
  reader.toggleBoss();
  assert.match(provider.provideTextDocumentContent(), /export class MemoryCache/);
  await reader.dispose();
  const restoredProvider = new ReaderDocumentProvider();
  const restored = new ReaderController(repository, restoredProvider, {}, ctx, chapters);
  await restored.openBook(book);
  assert.match(restoredProvider.provideTextDocumentContent(), /export class MemoryCache/);
  assert.match(restoredProvider.provideTextDocumentContent(), /page 3\//);
  await restored.nextChapter();
  assert.doesNotMatch(restoredProvider.provideTextDocumentContent(), /export class MemoryCache/);
  await restored.previousChapter();
  assert.match(restoredProvider.provideTextDocumentContent(), /export class MemoryCache/);
  restored.forgetBook(book.id);
  await restored.dispose();
  assert.equal(saved.get('codeNovel.readingTemplates.v1').books.length, 0);
});

test('fixed mode command changes the setting, hidden markers take effect, and cancelling selection is inert', async () => {
  ui.configuration = { prefetchNextChapter: false, readingTemplateMode: 'fixed', readingTemplate: 'metrics', hideReadingMarkers: true };
  const provider = new ReaderDocumentProvider();
  const reader = new ReaderController({ getProgress: () => ({ chapterIndex: 0, pageIndex: 0, updatedAt: 0 }),
    saveProgress: async () => undefined, saveBook: async () => undefined }, provider, {}, context(),
    { allowBook() {}, get: async (_, index) => ({ ...book.chapters[index], content: '原创测试正文。'.repeat(100) }) });
  await reader.openBook(book);
  assert.match(provider.provideTextDocumentContent(), /export class PerformanceTracker/);
  assert.doesNotMatch(provider.provideTextDocumentContent(), /测试书|第1章|navigation:/);
  ui.choices = [{ id: 'plugins' }];
  await reader.switchReadingTemplate();
  assert.equal(ui.configuration.readingTemplate, 'plugins');
  await reader.nextChapter();
  assert.match(provider.provideTextDocumentContent(), /export class PluginHost/);
  const expected = provider.provideTextDocumentContent();
  ui.choices = [undefined];
  await reader.switchReadingTemplate();
  assert.equal(provider.provideTextDocumentContent(), expected);
  ui.choices = [{ id: '' }];
  await reader.switchReadingTemplate();
  assert.notEqual(ui.configuration.readingTemplate, 'plugins');
  await reader.dispose();
});

test('every template reveals the exact first novel line after opening and paging, not a code comment', async () => {
  ui.configuration = { prefetchNextChapter: false, readingTemplateMode: 'fixed' };
  ui.reveals = [];
  const provider = new ReaderDocumentProvider();
  const chapter = { ...book.chapters[0], content: '原创定位正文。'.repeat(900) };
  ui.editorDocument = { getText: () => provider.provideTextDocumentContent(),
    get lineCount() { return provider.provideTextDocumentContent().split('\n').length; } };
  const reader = new ReaderController({ getProgress: () => ({ chapterIndex: 0, pageIndex: 0, updatedAt: 0 }),
    saveProgress: async () => undefined, saveBook: async () => undefined }, provider, {}, context(),
    { allowBook() {}, get: async () => chapter });
  try {
    await reader.openBook(book);
    for (const template of readingTemplates) {
      ui.configuration.readingTemplate = template.id;
      const previous = ui.reveals.length;
      reader.refreshReadingTemplate();
      await until(() => ui.reveals.length > previous);
      const line = ui.reveals.at(-1).start.line;
      assert.match(provider.provideTextDocumentContent().split('\n')[line], /\/\/ 原创定位正文/);
      const layout = renderReaderLayout(book, chapter, '', 0, 0, 1, 72, { templateId: template.id });
      assert.equal(line, layout.bodyLine);
    }
    const previous = ui.reveals.length;
    await reader.nextPage();
    await until(() => ui.reveals.length > previous);
    assert.match(provider.provideTextDocumentContent().split('\n')[ui.reveals.at(-1).start.line], /^  \/\/ /);
  } finally { await reader.dispose(); ui.editorDocument = undefined; }
});

test('local TXT and EPUB chapters use the same template controls without invoking online loading', async () => {
  for (const kind of ['txt', 'epub']) {
    ui.configuration = { prefetchNextChapter: false, readingTemplateMode: 'book' };
    const localBook = { ...book, id: `local-${kind}`, title: '本地测试书', kind,
      source: `C:/test.${kind}`, chapters: [{ title: '第一章', url: `C:/test.${kind}#0` }] };
    const parsed = { title: localBook.title, chapters: localBook.chapters,
      contents: [{ ...localBook.chapters[0], content: '原创本地文本。'.repeat(500) }] };
    const provider = new ReaderDocumentProvider();
    const reader = new ReaderController({ getProgress: () => ({ chapterIndex: 0, pageIndex: 0, updatedAt: 0 }),
      saveProgress: async () => undefined, saveBook: async () => undefined }, provider, {}, context(),
      { allowBook() {}, get: async () => assert.fail('local reading must not load online chapters') });
    await reader.openBook(localBook, parsed);
    ui.choices = [{ id: 'batch' }];
    await reader.switchReadingTemplate();
    await reader.nextPage();
    assert.match(provider.provideTextDocumentContent(), /export class BatchQueue/);
    assert.match(provider.provideTextDocumentContent(), /原创本地文本/);
    await reader.dispose();
  }
});

test('default boss templates rotate independently, stay stable while hidden and preserve reading and prefetch', async () => {
  ui.configuration = {};
  ui.reveals = [];
  const saved = new Map();
  const ctx = context(saved);
  const provider = new ReaderDocumentProvider();
  const requested = [];
  const progress = { chapterIndex: 0, pageIndex: 1, updatedAt: 0 };
  const repository = { getProgress: () => ({ ...progress }),
    saveProgress: async (_, value) => Object.assign(progress, value), saveBook: async () => undefined };
  const chapters = { allowBook() {}, get: async (_, index) => {
    requested.push(index);
    return { ...book.chapters[index], content: '不得泄漏的测试正文。'.repeat(600) };
  } };
  ui.editorDocument = { getText: () => provider.provideTextDocumentContent(),
    get lineCount() { return provider.provideTextDocumentContent().split('\n').length; } };
  const reader = new ReaderController(repository, provider, {}, ctx, chapters);
  try {
    await reader.openBook(book);
    const original = provider.provideTextDocumentContent();
    const variants = [];
    let previous = '';
    for (let index = 0; index < 16; index++) {
      reader.toggleBoss();
      const code = provider.provideTextDocumentContent();
      assert.notEqual(code, previous);
      assert.doesNotMatch(code, /不得泄漏|测试书|第1章|trace:|navigation:/);
      variants.push(code);
      const reveals = ui.reveals.length;
      reader.refreshReadingTemplate();
      assert.equal(provider.provideTextDocumentContent(), code, 'settings refresh does not reshuffle hidden code');
      await until(() => ui.reveals.length > reveals);
      assert.equal(ui.reveals.at(-1).start.line, 0, 'boss mode reveals the code header');
      reader.toggleBoss();
      assert.equal(provider.provideTextDocumentContent(), original);
      previous = code;
    }
    assert.equal(new Set(variants).size, 16);
    reader.toggleBoss();
    assert.notEqual(provider.provideTextDocumentContent(), previous, 'cycle boundary does not immediately repeat');
    await until(() => requested.length === 4);
    assert.deepEqual(requested, [0, 1, 2, 3]);
    assert.equal(progress.pageIndex, 1);
    assert.equal(progress.chapterIndex, 0);
    await reader.dispose();
    const hidden = provider.provideTextDocumentContent();
    const restored = new ReaderController(repository, new ReaderDocumentProvider(), {}, ctx, chapters);
    assert.equal(restored.getBossContent(), hidden, 'default preview restores the latest boss template');
    assert.deepEqual(saved.get('codeNovel.bossTemplates.v1').books, [], 'boss state contains no book or chapter data');
    await restored.dispose();
  } finally { await reader.dispose(); ui.editorDocument = undefined; }
});

test('custom boss snapshots including empty text win over random templates, and reset uses a long default template', async () => {
  ui.configuration = { prefetchNextChapter: false };
  const saved = new Map([['codeNovel.bossContent', '']]);
  const ctx = context(saved);
  const provider = new ReaderDocumentProvider();
  const reader = new ReaderController({ getProgress: () => ({ chapterIndex: 0, pageIndex: 0, updatedAt: 0 }),
    saveProgress: async () => undefined, saveBook: async () => undefined }, provider, {}, ctx,
    { allowBook() {}, get: async () => ({ ...book.chapters[0], content: '不得泄漏的测试正文。' }) });
  await reader.openBook(book);
  reader.toggleBoss();
  assert.equal(provider.provideTextDocumentContent(), '');
  assert.equal(saved.has('codeNovel.bossTemplates.v1'), false);
  await ctx.globalState.update('codeNovel.bossContent', 'const custom = 17;');
  reader.refreshBossContent();
  assert.equal(provider.provideTextDocumentContent(), 'const custom = 17;');
  reader.toggleBoss(); reader.toggleBoss();
  assert.equal(provider.provideTextDocumentContent(), 'const custom = 17;');
  assert.equal(saved.has('codeNovel.bossTemplates.v1'), false);
  ui.choices = [{ value: 'reset' }];
  await configureBoss(ctx, reader);
  const code = provider.provideTextDocumentContent();
  assert.ok(code.trimEnd().split('\n').length >= 115);
  assert.doesNotMatch(code, /不得泄漏|测试书|const custom/);
  assert.equal(reader.getBossContent(), code);
  await reader.dispose();
  assert.ok(saved.get('codeNovel.bossTemplates.v1'));
});
