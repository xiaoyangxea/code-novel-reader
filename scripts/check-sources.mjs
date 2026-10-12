import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import core from '../dist/core.js';

// Read-only live diagnostics. Cookies/cache only use this disposable profile.
const browser = process.argv.includes('--browser');
const direct = process.argv.includes('--direct');
const selected = process.argv.find((arg) => arg.startsWith('--source='))?.slice(9);
const proxy = direct ? undefined : await core.detectLocalProxy();
const profile = await mkdtemp(path.join(tmpdir(), 'code-novel-source-check-'));
try {
  const targets = [
    ['速读谷', 'https://www.sudugu.cc/modules/article/search.php'],
    ['得奇小说网', 'https://www.deqixs.com/tag/?key=龙族'],
    ['快书网', 'https://www.kuaishu5.com/search/?searchkey=龙族'],
    ['天天看小说', 'https://cn.ttkan.co/novel/search?q=龙族'],
    ['手机小说', 'https://www.shoujix.com/modules/article/search.php']
  ];
  const options = { timeoutMs: 15000, userAgent: 'Mozilla/5.0', browserRendering: browser,
    browserTimeoutMs: 25000, browserDataDirectory: profile, proxy };
  for (const [name, url] of targets) {
    if (selected && name !== selected) continue;
    const result = { name, checkedOn: new Date().toISOString(), mode: browser ? 'browser' : 'http', proxy: Boolean(proxy) };
    try {
      let effectiveUrl = url;
      const html = name === '速读谷'
        ? await core.fetchHtml(url, { ...options, method: 'POST', form: { searchkey: '龙族', action: 'login', searchtype: 'all' } })
        : name === '手机小说'
        ? await core.fetchHtml(url, { ...options, method: 'POST', form: { searchkey: '诡秘之主' }, charset: 'gbk', onFinalUrl: (value) => { effectiveUrl = value; } })
        : browser ? await core.renderHtmlWithBrowser(url, options) : await core.fetchHtml(url, options);
      const books = core.parseSearchHtml(html, effectiveUrl, name);
      result.searchCount = books.length;
      if (!books.length) throw new Error('未识别搜索结果');
      const catalogUrl = core.likelyCatalogUrl(books[0].url) ?? books[0].url;
      const catalog = await core.loadCatalogPreview(catalogUrl, options);
      result.chapterCount = catalog.chapters.length;
      const chapter = await core.loadChapter(catalog.chapters[0].url, options);
      result.bodyCharacters = chapter.content.length;
      result.status = 'verified';
    } catch (error) { result.status = 'unverified'; result.error = core.sourceFailureLabel(error.message); }
    console.log(JSON.stringify(result));
  }
} finally { await rm(profile, { recursive: true, force: true }); }
