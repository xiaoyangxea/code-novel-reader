import assert from 'node:assert/strict';
import { test } from 'node:test';
import core from '../dist/core.js';

const book = (title, url = 'https://novel.example/book/1/', author, summary) => ({ title, url, author, summary, provider: 'test' });
const chapterBody = '这是测试用的原创正文，角色正在整理眼前的线索。'.repeat(20);

test('generic descending catalogs are reversed without rearranging ascending, prologue or volume-local numbering', () => {
  const parse = (titles) => core.parseCatalogHtml(`<h1>测试书</h1><div id="list">${titles.map((title, i) => `<a href="${i}.html">${title}</a>`).join('')}</div>`, 'https://novel.example/book/1/').chapters.map((item) => item.title);
  assert.deepEqual(parse(['第3章 结尾', '第2章 发展', '第1章 开始']), ['第1章 开始', '第2章 发展', '第3章 结尾']);
  assert.deepEqual(parse(['第2章 后续', '第1章 开始']), ['第1章 开始', '第2章 后续']);
  assert.deepEqual(parse(['序言', '第1章 开始', '第2章 后续']), ['序言', '第1章 开始', '第2章 后续']);
  assert.deepEqual(parse(['第2章 卷一', '第1章 卷一', '第2章 卷二', '第1章 卷二']), ['第2章 卷一', '第1章 卷一', '第2章 卷二', '第1章 卷二']);
});

test('a clearly labeled complete catalog takes precedence over the latest-chapter prefix even without ordinal titles', () => {
  const html = '<h1>测试书</h1><div class="listmain"><dl><dt>最新章节</dt><dd><a href="4.html">附记</a></dd><dt>正文卷</dt><dd><a href="1.html">序言</a></dd><dd><a href="2.html">科学边界</a></dd><dd><a href="3.html">尾声</a></dd><dd><a href="4.html">附记</a></dd></dl></div>';
  const catalog = core.parseCatalogHtml(html, 'https://novel.example/book/1/');
  assert.deepEqual(catalog.chapters.map((item) => item.title), ['序言', '科学边界', '尾声', '附记']);
});

test('a book description, self-link or recommendations for other books are not chapter catalogs', () => {
  const html = '<h1>测试书</h1><div id="list"><a href="./">测试书</a><a href="/book/2/">推荐小说</a><a href="/book/3/">另一部小说</a></div>';
  assert.deepEqual(core.parseCatalogHtml(html, 'https://novel.example/book/1/').chapters, []);
});

test('QQ book URLs infer a catalog and sort it from chapter one', () => {
  assert.equal(core.likelyCatalogUrl('https://book.qq.com/book-read/695233/89'), 'https://book.qq.com/book-chapter/695233');
  const html = '<h1>三体全集</h1><p>作者：刘慈欣 著</p><div id="list"><a href="/book-read/695233/3">第3章 三</a><a href="/book-read/695233/2">第2章 二</a><a href="/book-read/695233/1">第1章 一</a></div>';
  const catalog = core.parseCatalogHtml(html, 'https://book.qq.com/book-chapter/695233');
  assert.equal(catalog.chapters[0].title, '第1章 一');
  assert.equal(catalog.author, '刘慈欣');
});

test('old saved online catalogs are normalized without changing the original book object or local books', () => {
  const chapters = [3, 2, 1].map((number) => ({ title: `第${number}章`, url: `https://book.qq.com/book-read/1/${number}` }));
  const original = { id: 'test', source: 'https://book.qq.com/book-chapter/1', kind: 'online', title: '测试', author: '作者：刘慈欣 著', chapters };
  const updated = core.normalizeSavedCatalog(original);
  assert.notEqual(updated, original);
  assert.deepEqual(updated.chapters.map((item) => item.title), ['第1章', '第2章', '第3章']);
  assert.equal(updated.author, '刘慈欣');
  assert.equal(original.chapters[0].title, '第3章');
  const local = { ...original, kind: 'txt' };
  assert.equal(core.normalizeSavedCatalog(local), local);
});

test('Windows browser cleanup is scoped to the owned PID tree, never a browser executable name', () => {
  assert.deepEqual(core.ownedBrowserTerminationArguments(1234), ['/PID', '1234', '/T', '/F']);
  for (const pid of [0, -1, 1.5, NaN]) assert.throws(() => core.ownedBrowserTerminationArguments(pid));
});

test('author extraction accepts Chinese and Latin bylines but not biographies, upload notices or footer text', () => {
  for (const [raw, expected] of [['作 者：忘语', '忘语'], ['吴承恩 更新：2026-10-11', '吴承恩'], ['刘慈欣 著', '刘慈欣'], ['某作者', '某作者'], ['作者甲', '作者甲'], ['George R. R. Martin', 'George R. R. Martin']]) assert.equal(core.cleanAuthor(raw), expected);
  for (const raw of ['江南本人获得荣誉，主角路明非正在入学。', '自行上传，本站未进行人工编辑。若有侵犯您的知识产权请通知', '，TA的作品包括：《测试书》', '类别：科幻', '12345']) assert.equal(core.cleanAuthor(raw), undefined);
  const html = '<h1>测试书</h1><meta property="og:novel:author" content="江南"><p>本网站作者资料仅供参考，版权归作者。</p><div class="author">这是人物简介。</div>';
  assert.equal(core.parseCatalogHtml(html, 'https://novel.example/book/1/').author, '江南');
  assert.equal(core.parseCatalogHtml('<h1>测试</h1><p>内容由作者自行上传，本站未整理。</p>', 'https://novel.example/').author, undefined);
});

test('restricted or masked chapters and old cached QQ excerpts are not accepted as complete text', () => {
  const excerpt = { title: '第89章', url: 'https://book.qq.com/book-read/695233/89', content: '这是原创的测试摘要。'.repeat(15) + '...' };
  assert.equal(core.isSuspectedCachedExcerpt(excerpt), true);
  assert.throws(() => core.parseChapterHtml(`<h1>第89章</h1><div id="article">${excerpt.content}</div>`, excerpt.url), core.RestrictedChapterError);
  assert.throws(() => core.parseChapterHtml(`<h1>第一章</h1><div class="chapter-content isMask">${chapterBody}</div><div class="chapter-content_mask"></div>`, 'https://novel.example/1.html'), core.RestrictedChapterError);
  const full = core.parseChapterHtml(`<h1>第一章</h1><div id="content">${chapterBody}<p>角色说：“这次需要购买新的书架。”</p></div>`, 'https://novel.example/1.html');
  assert.ok(full.content.length > 200);
});

test('chapter title page markers are normalized while a short normal chapter remains readable', () => {
  const parsed = core.parseChapterHtml(`<h1>第1章 开始（1 / 3）</h1><div id="content">${chapterBody}</div>`, 'https://www.sudugu.cc/1/2.html');
  assert.equal(parsed.title, '第1章 开始');
  assert.doesNotThrow(() => core.parseChapterHtml(`<h1>序言</h1><div id="content">${'这是正常的原创序言。'.repeat(15)}</div>`, 'https://book.qq.com/book-read/695233/1'));
});

test('combined queries quote separate terms and native sources search the title, not the literal full phrase', () => {
  assert.equal(core.webSearchQuery('三体 刘慈欣'), '"三体" "刘慈欣" 小说 目录');
  assert.equal(core.siteSearchQuery('三体 刘慈欣'), '三体');
  assert.equal(core.siteSearchQuery('刘慈欣'), '刘慈欣');
  assert.equal(core.siteSearchQuery('The Three Body Problem'), 'The Three Body Problem');
  const html = '<div class="c-container" mu="https://novel.example/book/1/"><h3><a href="https://www.baidu.com/link?url=opaque">三体全集目录</a></h3><div class="c-abstract">作者：刘慈欣。书籍简介。</div></div>';
  const parsed = core.parseWebSearchHtml(html, 'https://www.baidu.com/s', 'baidu', '三体 刘慈欣');
  assert.equal(parsed[0].author, '刘慈欣');
});

test('exact titles precede sequels and derivatives, while probe budgets diversify within the same match tier', () => {
  const sequel = book('斗罗大陆V重生唐三', 'https://b.example/book/2/', '唐家三少');
  const fan = book('斗罗大陆：开局穿越', 'https://c.example/book/3/', '另一个作者');
  const originals = [book('斗罗大陆', 'https://a.example/book/1/', '唐家三少'), book('斗罗大陆全文阅读', 'https://a.example/catalog/1/', '唐家三少'), book('斗罗大陆', 'https://d.example/book/1/', '唐家三少')];
  const candidates = core.rankedSearchCandidates([sequel, fan, ...originals], '斗罗大陆');
  assert.deepEqual(candidates.slice(0, 3), [originals[0], originals[2], originals[1]]);
  assert.equal(core.searchMatchLabel(sequel, '斗罗大陆'), '系列或续作');
  assert.equal(core.searchMatchLabel(fan, '斗罗大陆'), '相关作品');
});

test('author indexes expand into same-origin book candidates, not profiles or private-network links', () => {
  const index = { ...book('唐家三少的全部作品', 'https://novel.example/author/tang/'), kind: 'author-index' };
  const html = '<h1>唐家三少</h1><nav><a href="/list1/1/">玄幻</a></nav><ul class="search-list"><li><a href="/book/1/">斗罗大陆</a></li><li><a href="/book/2/">神印王座</a></li><li><a href="http://127.0.0.1/book/3/">坏链接</a></li><li><a href="https://elsewhere.example/book/4/">其他网站</a></li></ul>';
  const parsed = core.parseAuthorIndexBooks(html, index.url, index, '唐家三少');
  assert.deepEqual(parsed.map((item) => item.title), ['斗罗大陆', '神印王座']);
  assert.ok(parsed.every((item) => item.author === '唐家三少' && item.kind === 'book'));
  assert.ok(parsed.every((item) => item.authorInferred));
  assert.deepEqual(core.relevantSearchResults([index], '唐家三少'), []);
  assert.deepEqual(core.relevantSearchResults([book('唐家三少小说写作顺序', 'https://bk.taobao.com/article/1')], '唐家三少'), []);
});

test('summary matching cannot turn a social post, encyclopedia or download page into a novel result', () => {
  const html = '<div class="c-container" mu="https://weibo.com/2/detail/123"><h3><a href="https://www.baidu.com/link?url=x">微博正</a></h3><div class="c-abstract">三体 刘慈欣 阅读体验</div></div>';
  assert.deepEqual(core.parseWebSearchHtml(html, 'https://www.baidu.com/s', 'baidu', '三体 刘慈欣'), []);
});
