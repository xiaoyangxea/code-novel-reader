import assert from 'node:assert/strict';
import { test } from 'node:test';
import iconv from 'iconv-lite';
import JSZip from 'jszip';
import core from '../dist/core.js';

const {
  parseCatalogHtml, parseChapterHtml, parseEpub, parsePlainText, paginate, renderBoss,
  likelyCatalogUrl, catalogPageUrls, chapterPageState, pageNavigationState, parseMediaWikiSearch, parseZonghengSearch
} = core;

const { normalizeNovelSource, parseSourceSearchHtml } = core;
const { assertSafeRemoteUrl, isBlockedNetworkAddress, readBodyLimited } = core;
const { isBrowserChallengeHtml } = core;
const { browserIsolationArguments } = core;
const { chapterPrefetchIndexes } = core;

test('keeps a bounded sliding window of chapters ahead of the reader', () => {
  assert.deepEqual(chapterPrefetchIndexes(9, 100, 3), [10, 11, 12]);
  assert.deepEqual(chapterPrefetchIndexes(10, 100, 3), [11, 12, 13]);
  assert.deepEqual(chapterPrefetchIndexes(98, 100, 3), [99]);
  assert.deepEqual(chapterPrefetchIndexes(9, 100, 0), []);
  assert.equal(chapterPrefetchIndexes(0, 100, 99).length, 10);
});

test('suppresses browser-owned translate and crash restore prompts', () => {
  assert.equal(browserIsolationArguments.includes('--disable-translate'), true);
  assert.equal(browserIsolationArguments.includes('--disable-features=TranslateUI'), true);
  assert.equal(browserIsolationArguments.includes('--hide-crash-restore-bubble'), true);
  assert.equal(browserIsolationArguments.includes('--disable-session-crashed-bubble'), true);
});

test('distinguishes real browser challenges from readable novel pages', () => {
  assert.equal(isBrowserChallengeHtml('<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/a.js"></script></html>'), true);
  assert.equal(isBrowserChallengeHtml(`<html><title>第十章</title><body><div id="content">${'正文内容。'.repeat(500)}</div><script src="/cdn-cgi/challenge-platform/a.js"></script></body></html>`), false);
  assert.equal(isBrowserChallengeHtml(`<html><title>第十章</title><body><div id="content">${'主角看到了验证码。'.repeat(300)}</div></body></html>`), false);
});

test('switches editor navigation between pages and chapters at page boundaries', () => {
  assert.deepEqual(pageNavigationState(0, 3), { hasPreviousPage: false, hasNextPage: true });
  assert.deepEqual(pageNavigationState(1, 3), { hasPreviousPage: true, hasNextPage: true });
  assert.deepEqual(pageNavigationState(2, 3), { hasPreviousPage: true, hasNextPage: false });
  assert.deepEqual(pageNavigationState(0, 1), { hasPreviousPage: false, hasNextPage: false });
});

test('parses a Mayi-style catalog', () => {
  const html = `
    <html><body>
      <div id="info"><h1>测试小说</h1><p>作 者：某作者</p></div>
      <div id="list"><dl>
        <dd><a href="100.html">第一章 开始</a></dd>
        <dd><a href="101.html">第二章 继续</a></dd>
        <dd><a href="102.html">第三章 结尾</a></dd>
      </dl></div>
    </body></html>`;
  const result = parseCatalogHtml(html, 'https://example.com/1_2/');
  assert.equal(result.title, '测试小说');
  assert.equal(result.author, '某作者');
  assert.equal(result.chapters.length, 3);
  assert.equal(result.chapters[1].url, 'https://example.com/1_2/101.html');
});

test('normalizes a Mayi catalog that puts latest chapters before the full catalog', () => {
  const html = `
    <html><body>
      <div id="info"><h1>乱序目录测试</h1></div>
      <div id="list"><dl>
        <dd><a href="104.html">第4章 最新四</a></dd>
        <dd><a href="105.html">第5章 最新五</a></dd>
        <dd><a href="101.html">第1章 开始</a></dd>
        <dd><a href="102.html">第2章 继续</a></dd>
        <dd><a href="103.html">第3章 转折</a></dd>
        <dd><a href="104.html">第4章 最新四</a></dd>
        <dd><a href="105.html">第5章 最新五</a></dd>
      </dl></div>
    </body></html>`;
  const result = parseCatalogHtml(html, 'https://www.mayiwsk.com/150_150607/');
  assert.deepEqual(result.chapters.map((chapter) => chapter.title), [
    '第1章 开始', '第2章 继续', '第3章 转折', '第4章 最新四', '第5章 最新五'
  ]);
});

test('extracts chapter body and navigation', () => {
  const paragraph = '这是用于验证正文识别的一段文字，包含足够多的中文内容。'.repeat(8);
  const html = `
    <html><head><title>第一章_测试小说</title></head><body>
      <h1>第一章 开始</h1>
      <div id="content"><p>${paragraph}</p><p>第二段正文。</p></div>
      <a href="./">目录</a><a href="99.html">上一章</a><a href="101.html">下一章</a>
    </body></html>`;
  const result = parseChapterHtml(html, 'https://example.com/1_2/100.html');
  assert.equal(result.title, '第一章 开始');
  assert.match(result.content, /第二段正文/);
  assert.equal(result.previousUrl, 'https://example.com/1_2/99.html');
  assert.equal(result.nextUrl, 'https://example.com/1_2/101.html');
  assert.equal(result.catalogUrl, 'https://example.com/1_2/');
});

test('removes hidden anti-scraping text and site boilerplate from chapter body', () => {
  const paragraph = '这是应当保留的章节正文，路明非正在继续眼前的对话。'.repeat(8);
  const html = `
    <html><head>
      <style>.anti-copy, .offscreen { display: none } .far-away { position:absolute;left:-9999px }</style>
    </head><body>
      <h1>第744章 干！</h1>
      <div id="content">
        <p>${paragraph}</p>
        <p class="anti-copy">这是来自另一部小说的随机干扰句子。</p>
        <span class="offscreen">这段隐藏文本不应出现。</span>
        <i class="far-away">这也是屏幕外的垃圾文字。</i>
        <span style="visibility: hidden">内联隐藏垃圾。</span>
        <p>最新网址：www.mayiwsk.com</p>
      </div>
    </body></html>`;
  const result = parseChapterHtml(html, 'https://www.mayiwsk.com/150_150607/59106813.html');
  assert.match(result.content, /应当保留的章节正文/);
  assert.doesNotMatch(result.content, /另一部小说|隐藏文本|屏幕外|内联隐藏|最新网址/);
});

test('detects GBK text chapters and paginates', () => {
  const source = `书籍简介\n\n第一章 开始\n${'第一章正文。'.repeat(90)}\n\n第二章 后续\n${'第二章正文。'.repeat(60)}`;
  const parsed = parsePlainText(iconv.encode(source, 'gb18030'), '测试.txt');
  assert.equal(parsed.title, '测试');
  assert.equal(parsed.chapters.length, 2);
  assert.equal(parsed.chapters[0].title, '第一章 开始');
  assert.ok(paginate(parsed.contents[0].content, 200).length > 1);
});

test('parses a minimal EPUB spine', async () => {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>`);
  zip.file('OEBPS/book.opf', `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>EPUB 测试</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`);
  zip.file('OEBPS/c1.xhtml', `<html><body><h1>第一章</h1><p>${'第一章的正文内容，用于测试解析。'.repeat(4)}</p></body></html>`);
  zip.file('OEBPS/c2.xhtml', `<html><body><h1>第二章</h1><p>${'第二章的正文内容，用于测试解析。'.repeat(4)}</p></body></html>`);
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const parsed = await parseEpub(bytes, 'fallback.epub');
  assert.equal(parsed.title, 'EPUB 测试');
  assert.equal(parsed.chapters.length, 2);
  assert.match(parsed.contents[1].content, /第二章的正文内容/);
});

test('rejects EPUB entries with a compression-bomb ratio before extraction', async () => {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container/>');
  zip.file('OEBPS/bomb.xhtml', 'A'.repeat(1_000_000));
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  await assert.rejects(parseEpub(bytes, 'bomb.epub'), /压缩比异常/);
});

test('boss view contains no reading text', () => {
  const hidden = renderBoss();
  assert.match(hidden, /ValidationPipeline/);
  assert.doesNotMatch(hidden, /小说|章节|阅读/);
});

test('uses explicit selectors for additional novel sites', () => {
  const body = '这是站点专用选择器下的章节正文，用来确认内容能够被稳定提取。'.repeat(10);
  const fixtures = [
    {
      url: 'https://www.69shuba.com/txt/1/2',
      html: `<h1>第一章</h1><div class="txtnav"><p>${body}</p></div><a href="3">下一章</a>`
    },
    {
      url: 'https://chapter.zongheng.com/chapter/123/456.html',
      html: `<div class="title_txtbox">第二章</div><div class="content-txt"><p>${body}</p></div><a href="457.html">下一章</a>`
    },
    {
      url: 'https://www.17k.com/chapter/123/456.html',
      html: `<div class="readAreaBox"><h1>第三章</h1><div class="p">${body}</div></div><a href="457.html">下一章</a>`
    },
    {
      url: 'https://www.jjwxc.net/onebook.php?novelid=12&chapterid=3',
      html: `<h2 class="noveltitle">第四章</h2><div id="noveltext">${body}</div><a href="?novelid=12&chapterid=4">下一章</a>`
    },
    {
      url: 'https://read.qidian.com/chapter/abc/def/',
      html: `<h1 class="j_chapterName">第五章</h1><div class="j_readContent"><p>${body}</p></div><a href="../next/">下一章</a>`
    },
    {
      url: 'https://zh.wikisource.org/wiki/%E6%B5%8B%E8%AF%95/%E7%AC%AC%E4%B8%80%E7%AB%A0',
      html: `<h1 id="firstHeading">第六章</h1><div id="mw-content-text"><div class="mw-parser-output"><p>${body}</p></div></div><a href="/wiki/test/2">下一章</a>`
    }
  ];
  for (const fixture of fixtures) {
    const result = parseChapterHtml(fixture.html, fixture.url);
    assert.ok(result.content.length > 100, fixture.url);
    assert.ok(result.nextUrl, fixture.url);
  }
});

test('parses newly supported public novel layouts', () => {
  const body = '这是公开章节的测试正文，用于验证不同网站结构下的内容提取结果。'.repeat(10);
  const fixtures = [
    ['https://www.qidiy.com/book/112510/123.html', `<h1 class="title">第一章</h1><div id="content">${body}</div>`],
    ['https://m.kudushu.org/html/1078405/12345/', `<h1 class="nr_title">第二章</h1><div id="novelcontent">${body}</div>`],
    ['https://www.sudugu.org/175/16778.html', `<div class="submenu"><h1>第三章</h1></div><div class="con">${body}</div>`],
    ['https://xszj.org/b/362604/c/123', `<article><h1>第四章</h1></article><div id="booktxt">${body}</div>`],
    ['https://cn.ttkan.co/novel/pagea/test_1.html', `<div class="title"><h1>第五章</h1></div><div class="content">${body}</div>`],
    ['https://www.shuhaige.net/431594/1.html', `<div class="bookname"><h1>第六章</h1></div><div id="content">${body}</div>`],
    ['https://m.biquge365.net/shu/563052/1.html', `<div id="neirong"><h1>第七章</h1><div id="txt">${body}</div></div>`]
  ];
  for (const [url, html] of fixtures) {
    const parsed = parseChapterHtml(html, url);
    assert.ok(parsed.content.length > 120, url);
  }
});

test('selects the largest Qidiy catalog and discovers only same-book pages', () => {
  const html = `
    <h1>目录测试</h1>
    <ul class="section-list"><li><a href="/book/112510/900.html">第900章 最新</a></li></ul>
    <ul class="section-list">
      <li><a href="/book/112510/1.html">第1章 开始</a></li>
      <li><a href="/book/112510/2.html">第2章 继续</a></li>
      <li><a href="/book/112510/3.html">第3章 后续</a></li>
    </ul>
    <select>
      <option value="/book/112510/">1</option>
      <option value="/book/112510_2/">2</option>
      <option value="/book/112510_20/">20</option>
      <option value="/book/112510_21/">21</option>
    </select>
    <a href="/book/112510_21/">下一页</a>
    <a href="/book/999999_2/">其他小说</a>`;
  const url = 'https://www.qidiy.com/book/112510_20/';
  const parsed = parseCatalogHtml(html, url);
  assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), ['第1章 开始', '第2章 继续', '第3章 后续']);
  assert.deepEqual(catalogPageUrls(html, url), [
    'https://www.qidiy.com/book/112510/',
    'https://www.qidiy.com/book/112510_2/',
    'https://www.qidiy.com/book/112510_21/'
  ]);
});

test('discovers paged catalogs for mobile and static sites', () => {
  assert.deepEqual(catalogPageUrls(
    '<select name="pageselect"><option value="/html/1078405/asc-1/">1</option><option value="/html/1078405/asc-2/">2</option></select>',
    'https://m.kudushu.org/book/1078405/'
  ), [
    'https://m.kudushu.org/html/1078405/asc-1/',
    'https://m.kudushu.org/html/1078405/asc-2/'
  ]);
  assert.deepEqual(catalogPageUrls(
    '<a class="gr" href="p-2.html#dir">下一页</a>',
    'https://www.sudugu.org/175/'
  ), ['https://www.sudugu.org/175/p-2.html']);
  assert.deepEqual(catalogPageUrls(
    '<select id="indexselect"><option value="/b/362604/cs/1">1</option><option value="/b/362604/cs/2">2</option></select>',
    'https://xszj.org/b/362604/cs/1'
  ), ['https://xszj.org/b/362604/cs/2']);
});

test('does not expose a remote chapter page as next chapter', () => {
  const body = '这是分页章节的第一段正文。'.repeat(20);
  const parsed = parseChapterHtml(`
    <h1 class="title">第10章 测试（第1/2页）</h1>
    <div id="content">${body}<p>（本章未完，请点击下一页继续阅读）</p></div>
    <a href="10/2.html">下一页</a><a href="11.html">下一章</a>
  `, 'https://www.qidiy.com/book/123/10.html');
  assert.equal(parsed.title, '第10章 测试');
  assert.equal(parsed.nextUrl, 'https://www.qidiy.com/book/123/11.html');
  assert.doesNotMatch(parsed.content, /本章未完/);
});

test('infers missing remote chapter page links from page counters', () => {
  assert.deepEqual(chapterPageState(
    '<h1 class="title">第10章 测试（第1/3页）</h1>',
    'https://www.qidiy.com/book/123/10.html'
  ), {
    current: 1,
    total: 3,
    nextPageUrl: 'https://www.qidiy.com/book/123/10/2.html'
  });
  assert.equal(chapterPageState(
    '<h1>第10章 测试（第2/3页）</h1>',
    'https://m.kudushu.org/html/1078405/12345_2/'
  ).nextPageUrl, 'https://m.kudushu.org/html/1078405/12345_3/');
});

test('infers site-specific catalog URLs', () => {
  assert.equal(
    likelyCatalogUrl('https://www.qidiy.com/book/112510/123.html'),
    'https://www.qidiy.com/book/112510/'
  );
  assert.equal(
    likelyCatalogUrl('https://m.kudushu.org/html/1078405/12345_2/'),
    'https://m.kudushu.org/book/1078405/'
  );
  assert.equal(
    likelyCatalogUrl('https://chapter.zongheng.com/chapter/123/456.html'),
    'https://book.zongheng.com/showchapter/123.html'
  );
  assert.equal(
    likelyCatalogUrl('https://book.zongheng.com/book/123.html'),
    'https://book.zongheng.com/showchapter/123.html'
  );
  assert.equal(
    likelyCatalogUrl('https://www.17k.com/chapter/123/456.html'),
    'https://www.17k.com/list/123.html'
  );
  assert.equal(
    likelyCatalogUrl('https://www.17k.com/book/123.html'),
    'https://www.17k.com/list/123.html'
  );
  assert.equal(
    likelyCatalogUrl('https://www.jjwxc.net/onebook.php?novelid=12&chapterid=3'),
    'https://www.jjwxc.net/onebook.php?novelid=12'
  );
});

test('parses Zongheng and Wikisource search APIs', () => {
  const zongheng = parseZonghengSearch(JSON.stringify({
    data: { datas: { list: [{ bookId: 123, name: '测试<font>小说</font>', authorName: '作者甲', chapterName: '第十章' }] } }
  }), { name: '纵横中文网', kind: 'zongheng', url: '' });
  assert.equal(zongheng[0].title, '测试小说');
  assert.equal(zongheng[0].url, 'https://book.zongheng.com/book/123.html');

  const wiki = parseMediaWikiSearch(JSON.stringify({
    query: { search: [{ title: '红楼梦/第一回', snippet: '<span>章节</span>简介' }] }
  }), { name: '维基文库', kind: 'mediawiki', url: '' });
  assert.equal(wiki[0].title, '红楼梦/第一回');
  assert.match(wiki[0].url, /wikisource\.org\/wiki\//);
  assert.equal(wiki[0].latestChapter, '章节简介');
});

test('imports a data-only source rule and parses its search results', () => {
  const source = normalizeNovelSource({
    version: 1,
    name: '测试书源',
    domains: ['books.example.com'],
    search: {
      url: 'https://books.example.com/search?q={keyword}',
      resultSelector: '.result',
      titleSelector: '.title',
      urlSelector: '.title',
      authorSelector: '.author'
    },
    catalog: { titleSelector: 'h1', chapterSelector: '#list a' },
    chapter: { titleSelector: 'h1', contentSelector: '#content' }
  });
  assert.match(source.id, /^custom-/);
  const results = parseSourceSearchHtml(`
    <div class="result"><a class="title" href="/book/1/">示例小说</a><span class="author">作者甲</span></div>
  `, 'https://books.example.com/search?q=test', source);
  assert.equal(results[0].title, '示例小说');
  assert.equal(results[0].author, '作者甲');
  assert.equal(results[0].url, 'https://books.example.com/book/1/');
  assert.equal(results[0].sourceId, source.id);
});

test('rejects executable or local-network source definitions', () => {
  assert.throws(() => normalizeNovelSource({
    version: 1,
    name: '危险书源',
    domains: ['example.com'],
    script: 'eval(1)',
    catalog: { titleSelector: 'h1', chapterSelector: 'a' },
    chapter: { titleSelector: 'h1', contentSelector: '#content' }
  }), /脚本/);
  assert.throws(() => normalizeNovelSource({
    version: 1,
    name: '内网书源',
    domains: ['example.com'],
    search: {
      url: 'http://127.0.0.1/search?q={keyword}',
      resultSelector: '.result',
      titleSelector: 'a',
      urlSelector: 'a'
    },
    catalog: { titleSelector: 'h1', chapterSelector: 'a' },
    chapter: { titleSelector: 'h1', contentSelector: '#content' }
  }), /本机或局域网/);
});

test('blocks non-public network destinations and encoded loopback URLs', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1', 'fe80::1']) {
    assert.equal(isBlockedNetworkAddress(address), true, address);
  }
  assert.throws(() => assertSafeRemoteUrl('http://2130706433/test'), /本机或局域网/);
  assert.throws(() => assertSafeRemoteUrl('http://[::1]/test'), /本机或局域网/);
  assert.equal(assertSafeRemoteUrl('https://example.com/book/1'), 'https://example.com/book/1');
});

test('stops reading a response while its decoded body exceeds the limit', async () => {
  const response = new Response('正文'.repeat(100));
  await assert.rejects(readBodyLimited(response, 64, '测试响应'), /超过 1 MB/);
});

test('keeps custom sources inside declared domains and rejects expensive selectors', () => {
  const source = normalizeNovelSource({
    version: 1,
    name: '域名约束',
    domains: ['books.example.com'],
    search: {
      url: 'https://books.example.com/search?q={keyword}',
      resultSelector: '.result', titleSelector: 'a', urlSelector: 'a'
    },
    catalog: { titleSelector: 'h1', chapterSelector: '#list a' },
    chapter: { titleSelector: 'h1', contentSelector: '#content' }
  });
  const results = parseSourceSearchHtml(`
    <div class="result"><a href="https://evil.example/book/1">外部结果</a></div>
    <div class="result"><a href="/book/2">正常结果</a></div>
  `, 'https://books.example.com/search', source);
  assert.deepEqual(results.map((item) => item.title), ['正常结果']);
  assert.throws(() => normalizeNovelSource({
    version: 1,
    name: '复杂选择器',
    domains: ['books.example.com'],
    catalog: { titleSelector: 'h1', chapterSelector: 'body:has(a)' },
    chapter: { titleSelector: 'h1', contentSelector: '#content' }
  }), /安全的 CSS 选择器/);
});

test('escapes remote titles and bidirectional controls in the TypeScript disguise', () => {
  const rendered = core.renderReader(
    { id: 'a'.repeat(20), title: `x'); throw new Error('bad`, kind: 'online', source: 'https://example.com', chapters: [{ title: '第一章', url: 'https://example.com/1' }], addedAt: 0 },
    { title: '第\u202e一章', content: '正文', url: 'https://example.com/1' },
    '正常正文\u202e/* */', 0, 0, 1, 72
  );
  assert.match(rendered, /name: "x'\); throw new Error\('bad"/);
  assert.doesNotMatch(rendered, /\u202e/);
  assert.doesNotMatch(rendered, /\/\* \*\//);
});
