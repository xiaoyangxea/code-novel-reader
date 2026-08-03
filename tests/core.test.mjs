import assert from 'node:assert/strict';
import { test } from 'node:test';
import iconv from 'iconv-lite';
import JSZip from 'jszip';
import core from '../dist/core.js';

const {
  parseCatalogHtml, parseChapterHtml, parseEpub, parsePlainText, paginate, renderBoss,
  likelyCatalogUrl, pageNavigationState, parseMediaWikiSearch, parseZonghengSearch
} = core;

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

test('infers site-specific catalog URLs', () => {
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
