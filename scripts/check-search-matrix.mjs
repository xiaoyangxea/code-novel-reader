import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import core from '../dist/core.js';

// Live read-only regression: public searches, catalog previews and one chapter.
// Persist metadata/counts only, not novel text, cookies or proxy credentials.
const cases = [
  ['三体', '刘慈欣', '出版'], ['诡秘之主', '爱潜水的乌贼', '网文'],
  ['斗破苍穹', '天蚕土豆', '网文'], ['凡人修仙传', '忘语', '网文'],
  ['遮天', '辰东', '网文'], ['完美世界', '辰东', '网文'],
  ['庆余年', '猫腻', '网文'], ['雪中悍刀行', '烽火戏诸侯', '网文'],
  ['斗罗大陆', '唐家三少', '网文'], ['一念永恒', '耳根', '网文'],
  ['龙族', '江南', '出版'], ['全职高手', '蝴蝶蓝', '网文'],
  ['红楼梦', '曹雪芹', '经典'], ['西游记', '吴承恩', '经典'],
  ['活着', '余华', '出版'], ['围城', '钱钟书', '出版'],
  ['路明非，成为艾尔登之王吧！', undefined, '长书名'],
  ['刘慈欣', '刘慈欣', '作者'], ['唐家三少', '唐家三少', '作者'],
  ['诡秘', '爱潜水的乌贼', '部分书名'],
  ['三体 刘慈欣', '刘慈欣', '书名加作者'],
  ['不存在的测试小说_CNR_20261012_91827', undefined, '负例']
];
const selected = process.argv.find((arg) => arg.startsWith('--keyword='))?.slice(10);
const outputName = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9);
if (outputName && !/^[\w.-]+\.json$/.test(outputName)) throw new Error('Invalid report filename');
const maxProbes = Math.min(Math.max(Number(process.argv.find((arg) => arg.startsWith('--probes='))?.slice(9) ?? 4), 1), 8);
const queries = selected ? cases.filter(([keyword]) => keyword === selected) : cases;
if (!queries.length || !Number.isInteger(maxProbes)) throw new Error('Invalid test selection');
const proxy = await core.detectLocalProxy();
const options = { timeoutMs: 12000, proxy, browserRendering: false,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36' };
const providers = ['蚂蚁文学', '苦读书', '速读谷', '纵横中文网', '维基文库'];
let report = { startedAt: new Date().toISOString(), browserRendering: false, proxyDetected: Boolean(proxy),
  maxProbes, requestTimeoutMs: options.timeoutMs, queries: [] };
const output = path.resolve('.vscode-test', outputName ?? (selected ? 'search-matrix-selected.json' : 'search-matrix-latest.json'));
await mkdir(path.dirname(output), { recursive: true });
if (process.argv.includes('--resume')) report = JSON.parse(await readFile(output, 'utf8'));
const rateLimited = new Set(report.queries.flatMap((item) => item.sources.filter((source) => /HTTP 429/.test(source.error ?? '')).map((source) => source.provider)));
const engineHosts = { '全网 · Bing': 'bing.com', '全网 · DuckDuckGo': 'duckduckgo.com', '全网 · 百度': 'baidu.com' };
const persist = async () => writeFile(output, JSON.stringify(report, null, 2), 'utf8');
const brief = (item) => ({ title: item.title.slice(0, 160), author: item.author?.slice(0, 160), url: item.url, provider: item.provider });
for (const [keyword, expectedAuthor, category] of queries) {
  if (report.queries.some((item) => item.keyword === keyword)) continue;
  const started = Date.now();
  const sources = [];
  const record = { keyword, expectedAuthor, category, sources, candidates: [], probes: [] };
  for (const provider of rateLimited) sources.push({ provider, count: 0, skipped: 'HTTP 429 后停止后续测试请求' });
  console.log(JSON.stringify({ event: 'start', keyword, index: report.queries.length + 1, total: queries.length }));
  const searchOptions = { ...options, allowsUrl: (url) => {
    const hostname = new URL(url).hostname;
    return ![...rateLimited].some((provider) => engineHosts[provider]
      && (hostname === engineHosts[provider] || hostname.endsWith(`.${engineHosts[provider]}`)));
  }, onSearchBatch: (items, provider, error) => {
    if (rateLimited.has(provider)) return;
    sources.push({ provider, count: items.length, error: error?.slice(0, 600) });
    if (/HTTP 429/.test(error ?? '')) rateLimited.add(provider);
  } };
  const [web, sites] = await Promise.all([
    core.publicWebSearch(keyword, searchOptions).catch((error) => {
      record.webError = error.message; return [];
    }),
    core.searchBooks(keyword, [], searchOptions, providers.filter((provider) => !rateLimited.has(provider))).catch((error) => {
      record.siteError = error.message; return { results: [] };
    })
  ]);
  const candidates = core.rankedSearchCandidates([...sites.results, ...web], keyword, 200);
  record.candidateCount = candidates.length;
  record.candidates = candidates.map(brief);
  console.log(JSON.stringify({ event: 'search', keyword, count: candidates.length,
    top: candidates.slice(0, 3).map((item) => item.title) }));
  // Two probe workers maximum, matching the UI's low-concurrency approach.
  let cursor = 0;
  let foundOriginal = false;
  const shortlist = candidates.slice(0, maxProbes);
  const probe = async () => {
    while (!foundOriginal && cursor < shortlist.length && category !== '负例') {
      const item = shortlist[cursor++];
      const result = { ...brief(item), status: 'unverified' };
      record.probes.push(result);
      try {
        const catalogUrl = core.likelyCatalogUrl(item.url) ?? item.url;
        const catalog = await core.loadCatalogPreview(catalogUrl, { ...options, timeoutMs: 7000 });
        result.catalogTitle = catalog.title.slice(0, 160);
        result.catalogAuthor = catalog.author?.slice(0, 160);
        result.chapterCount = catalog.chapters.length;
        if (catalog.chapters.length < 2) throw new Error('目录不足两章');
        if (!core.matchesSearchKeyword({ ...item, title: catalog.title, author: catalog.author }, keyword)) throw new Error('目录标题或作者与搜索词不匹配');
        result.catalogMatched = true;
        result.authorIdentity = !expectedAuthor ? 'not_required' : !catalog.author ? 'unknown'
          : catalog.author.includes(expectedAuthor) ? 'matched' : 'different';
        result.exactTitleMatched = category === '作者' || core.canonicalBookTitle(catalog.title)
          === core.canonicalBookTitle(category === '部分书名' ? '诡秘之主' : core.siteSearchQuery(keyword));
        if (result.authorIdentity === 'different') {
          result.status = 'other_work'; continue;
        }
        const chapter = await core.loadChapter(catalog.chapters[0].url, { ...options, timeoutMs: 10000 });
        if (/(?:本章|章节|正文).{0,24}(?:订阅后|购买后|登录后|付费后)|请(?:先)?(?:登录|登陆)(?:后)?(?:阅读|查看)/.test(chapter.content)) throw new Error('返回了访问限制提示而非完整正文');
        result.chapterTitle = chapter.title.slice(0, 160);
        result.bodyCharacters = chapter.content.length;
        result.hasNextChapter = Boolean(chapter.nextUrl);
        result.hasPreviousChapter = Boolean(chapter.previousUrl);
        result.status = 'readable';
        if (result.exactTitleMatched && (result.authorIdentity === 'matched' || result.authorIdentity === 'not_required')) foundOriginal = true;
      } catch (error) { result.error = core.sourceFailureLabel(error.message).slice(0, 600); }
    }
  };
  await Promise.all([probe(), probe()]);
  record.catalogMatched = record.probes.some((item) => item.catalogMatched);
  record.readable = record.probes.some((item) => item.status === 'readable');
  record.originalConfirmed = record.probes.some((item) => item.status === 'readable' && item.exactTitleMatched
    && (item.authorIdentity === 'matched' || item.authorIdentity === 'not_required'));
  record.elapsedMs = Date.now() - started;
  report.queries.push(record);
  await persist();
  console.log(JSON.stringify({ event: 'result', keyword, category, candidates: record.candidateCount,
    catalog: record.catalogMatched, readable: record.readable, originalConfirmed: record.originalConfirmed,
    readableTitles: record.probes.filter((item) => item.status === 'readable').map((item) => item.catalogTitle),
    elapsedMs: record.elapsedMs }));
}
report.completedAt = new Date().toISOString();
report.rateLimitedSources = [...rateLimited];
report.summary = { queries: report.queries.length,
  withCandidates: report.queries.filter((item) => item.candidateCount > 0).length,
  withCatalog: report.queries.filter((item) => item.catalogMatched).length,
  readable: report.queries.filter((item) => item.readable).length,
  originalConfirmed: report.queries.filter((item) => item.originalConfirmed).length,
  negativeControlPassed: report.queries.filter((item) => item.category === '负例').every((item) => item.candidateCount === 0) };
await persist();
console.log(JSON.stringify({ event: 'complete', ...report.summary, report: output }));
