import assert from 'node:assert/strict';
import { test } from 'node:test';
import core from '../dist/core.js';

const { ChapterService, BackgroundTaskCancelled, filterSearchProviders, groupSearchResults,
  downloadIndexes, safeExportName, searchNextPageUrl, parseSearchHtml } = core;

const book = { id: '0123456789abcdef0123', title: '测试', kind: 'online', source: 'https://example.com/',
  chapters: Array.from({ length: 6 }, (_, i) => ({ title: `第${i + 1}章`, url: `https://example.com/${i}.html` })) };

function service(loader) {
  const cached = new Map();
  let present = true;
  const cache = { getBook: () => present ? book : undefined,
    readCachedChapter: async (_, url) => cached.get(url),
    cacheChapter: async (_, chapter) => { cached.set(chapter.url, chapter); } };
  return { chapters: new ChapterService(cache, () => ({ timeoutMs: 1000, userAgent: 'test' }), () => undefined, loader),
    cached, remove: () => { present = false; } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('old cached QQ excerpts are reloaded, and a rejected restricted chapter cannot overwrite the cache', async () => {
  const url = 'https://book.qq.com/book-read/695233/89';
  const qqBook = { ...book, chapters: [{ title: '第89章', url }] };
  let cached = { title: '第89章', url, content: '这是测试摘要。'.repeat(20) + '...' };
  let requested = 0;
  let writes = 0;
  const chapters = new ChapterService({ getBook: () => qqBook, readCachedChapter: async () => cached,
    cacheChapter: async (_, value) => { writes++; cached = value; } },
    () => ({ timeoutMs: 1000, userAgent: 'test' }), () => undefined, async () => {
      requested++; throw new core.RestrictedChapterError();
    });
  await assert.rejects(chapters.get(qqBook, 0), core.RestrictedChapterError);
  assert.equal(requested, 1);
  assert.equal(writes, 0);
});

test('foreground chapters are promoted ahead of pending downloads, without duplicate loads', async () => {
  let release;
  const order = [];
  const { chapters } = service(async (url) => {
    order.push(url);
    if (url === book.chapters[0].url) await new Promise((resolve) => { release = resolve; });
    return { title: 'chapter', content: 'body', url };
  });
  const first = chapters.get(book, 0, 20);
  await tick();
  const download = chapters.get(book, 1, 20);
  const prefetch = chapters.get(book, 2, 10);
  const reading = chapters.get(book, 1, 0);
  await tick(); release();
  await Promise.all([first, download, prefetch, reading]);
  assert.deepEqual(order, [0, 1, 2].map((i) => book.chapters[i].url));
});

test('resuming a download reuses cached chapters', async () => {
  let requests = 0;
  const { chapters } = service(async (url) => { requests++; return { title: 't', content: 'c', url }; });
  await chapters.get(book, 1, 20);
  await chapters.get(book, 1, 20);
  assert.equal(requests, 1);
});

test('removed books cannot have an in-flight download recreate their cache', async () => {
  let release;
  const { chapters, cached } = service(async (url) => {
    await new Promise((resolve) => { release = resolve; }); return { title: 't', content: 'c', url };
  });
  const pending = chapters.get(book, 0, 20);
  await tick();
  const cancelled = chapters.cancelBook(book.id);
  release();
  await Promise.all([pending, cancelled]);
  assert.equal(cached.size, 0);
  await assert.rejects(chapters.get(book, 1, 20), BackgroundTaskCancelled);
});

test('paused queued background work does not request another chapter', async () => {
  let release;
  let enabled = true;
  const requested = [];
  const { chapters } = service(async (url) => {
    requested.push(url);
    await new Promise((resolve) => { release = resolve; }); return { title: 't', content: 'c', url };
  });
  const running = chapters.get(book, 0, 20);
  await tick();
  const queued = chapters.get(book, 1, 20, false, undefined, () => enabled);
  const rejected = assert.rejects(queued, BackgroundTaskCancelled);
  await tick(); enabled = false; release();
  await Promise.all([running, rejected]);
  assert.equal(requested.length, 1);
});

test('a download can reuse a queued prefetch even after the reader changes chapters', async () => {
  let release;
  let prefetchAllowed = true;
  const requested = [];
  const { chapters } = service(async (url) => {
    requested.push(url);
    if (url === book.chapters[0].url) await new Promise((resolve) => { release = resolve; });
    return { title: 't', content: 'c', url };
  });
  const first = chapters.get(book, 0, 0);
  await tick();
  const prefetch = chapters.get(book, 1, 10, false, undefined, () => prefetchAllowed);
  const download = chapters.get(book, 1, 20);
  await tick(); prefetchAllowed = false; release();
  await Promise.all([first, prefetch, download]);
  assert.deepEqual(requested, [book.chapters[0].url, book.chapters[1].url]);
});

test('search source filtering keeps explicit legacy providers and respects an empty source selection', () => {
  const providers = [{ name: '内置' }, { name: '自定义入口' }];
  assert.deepEqual(filterSearchProviders(providers, ['内置', '自定义入口']), providers);
  assert.deepEqual(filterSearchProviders(providers, []), []);
});

test('results group multiple sites but preserve distinct authors and deduplicate URLs', () => {
  const a = { title: '《测试书》', author: '甲', url: 'https://a.example/', provider: 'a' };
  const b = { title: '测试书', author: '甲', url: 'https://b.example/', provider: 'b' };
  const c = { ...b, author: '乙', url: 'https://c.example/' };
  assert.deepEqual(groupSearchResults([a, b, a, c], '测试书').map((g) => g.length), [2, 1]);
});

test('search pagination cannot escape the origin or loop to the same URL', () => {
  assert.equal(searchNextPageUrl('<a href="?page=2">下一页</a>', 'https://example.com/search'), 'https://example.com/search?page=2');
  assert.equal(searchNextPageUrl('<a rel="next" href="https://evil.example/">next</a>', 'https://example.com/search'), undefined);
  assert.equal(searchNextPageUrl('<a href="/search">下一页</a>', 'https://example.com/search'), undefined);
});

test('search can return an exact-match book catalog rather than a result list', () => {
  const html = '<div id="info"><h1>测试书</h1></div><div id="list"><a href="1.html">第1章 开始</a><a href="2.html">第2章 后续</a></div>';
  const results = parseSearchHtml(html, 'https://example.com/book/1/', '测试源');
  assert.equal(results[0].title, '测试书');
  assert.equal(results[0].chapterCount, 2);
});

test('download ranges are bounded and exported filenames cannot create directories', () => {
  assert.deepEqual(downloadIndexes('2-4', 10), [1, 2, 3]);
  assert.deepEqual(downloadIndexes('3', 10), [2]);
  for (const value of ['0-4', '4-2', '1-100', '-1', '1;2']) assert.throws(() => downloadIndexes(value, 10));
  assert.equal(safeExportName('../测试\\书'), '.._测试_书');
  assert.equal(safeExportName('CON'), 'novel_CON');
});

test('search form encoding supports Chinese GBK without accepting credential fields', () => {
  assert.equal(core.encodeSearchForm({ searchkey: '中文' }, 'gbk'), 'searchkey=%D6%D0%CE%C4');
  assert.equal(core.encodeSearchForm({ q: 'a b&x=1' }), 'q=a%20b%26x%3D1');
  assert.throws(() => core.encodeSearchForm({ password: 'secret' }), /凭据/);
  const source = { version: 1, name: '测试', domains: ['example.com'],
    search: { url: 'https://example.com/search', method: 'POST', form: { searchkey: '{keyword}' },
      charset: 'gbk', resultSelector: 'li', titleSelector: 'a', urlSelector: 'a' },
    catalog: { titleSelector: 'h1', chapterSelector: '#list a' },
    chapter: { titleSelector: 'h1', contentSelector: '#content' } };
  assert.equal(core.normalizeNovelSource(source).search.method, 'POST');
  assert.throws(() => core.normalizeNovelSource({ ...source, search: { ...source.search, method: 'DELETE' } }), /GET 或 POST/);
  assert.throws(() => core.normalizeNovelSource({ ...source, search: { ...source.search, form: { token: 'abc', q: '{keyword}' } } }), /凭据/);
});
