import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import core from '../dist/core.js';

const profile = await mkdtemp(path.join(tmpdir(), 'code-novel-matrix-browser-'));
const options = { timeoutMs: 12000, browserTimeoutMs: 15000, browserRendering: true,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
  proxy: await core.detectLocalProxy(), browserDataDirectory: profile };
const selected = process.argv.find((arg) => arg.startsWith('--keyword='))?.slice(10);
const cases = [
  ['诡秘之主', 'https://www.qidian.com/book/1010868264/catalog/'],
  ['凡人修仙传', 'https://m.readnovel.com/chapterlist/22305390000123802'],
  ['活着', 'http://m.miaokanw.com/huozhe/']
].filter(([keyword]) => !selected || keyword === selected);
const report = { checkedAt: new Date().toISOString(), samples: [] };
const output = path.resolve('.vscode-test', selected ? 'search-browser-sample-selected.json' : 'search-browser-samples.json');
await mkdir(path.dirname(output), { recursive: true });
const blockedHosts = new Set();
try {
  for (const [keyword, url] of cases) {
    const item = { keyword, url, automaticBrowserUsed: false };
    report.samples.push(item);
    console.log(JSON.stringify({ event: 'start', keyword, url }));
    if (blockedHosts.has(new URL(url).hostname)) { item.skipped = '同站点已要求验证'; continue; }
    const onProgress = (message) => { item.automaticBrowserUsed = true; console.log(JSON.stringify({ keyword, progress: message })); };
    try {
      const automatic = await core.loadCatalogPreview(url, { ...options, onProgress });
      item.automaticChapterCount = automatic.chapters.length;
      item.automaticTitle = automatic.title;
    } catch (error) { item.automaticError = core.sourceFailureLabel(error.message); }
    if (!item.automaticChapterCount && !item.automaticBrowserUsed) {
      console.log(JSON.stringify({ keyword, event: 'force-browser', reason: '普通解析返回空目录，自动回退未触发' }));
      try {
        const html = await core.renderHtmlWithBrowser(url, { ...options,
          onProgress: (message) => console.log(JSON.stringify({ keyword, progress: message })) });
        const catalog = core.parseCatalogHtml(html, url);
        item.forcedBrowserChapterCount = catalog.chapters.length;
        item.forcedBrowserTitle = catalog.title;
      } catch (error) {
        item.forcedBrowserError = core.sourceFailureLabel(error.message);
        if (/验证/.test(error.message)) blockedHosts.add(new URL(url).hostname);
      }
    }
    await writeFile(output, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(item));
  }
} finally {
  // Only remove the exact directory this run created, never a user profile.
  const resolved = await realpath(profile);
  const tempRoot = await realpath(tmpdir());
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('code-novel-matrix-browser-')) throw new Error('Unsafe temporary cleanup target');
  try {
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    report.temporaryProfileRemoved = true;
  } catch (error) { report.temporaryProfileRemoved = false; report.cleanupError = error.message; }
  await writeFile(output, JSON.stringify(report, null, 2), 'utf8');
}
console.log(JSON.stringify({ event: 'complete', report: output }));
