import { SearchResult } from './model';
import { canonicalBookTitle } from './book-metadata';
import { assertSafeRemoteUrl } from './net';

export function searchTerms(keyword: string): string[] {
  return keyword.normalize('NFKC').replace(/[《》"'“”]/g, '').trim().split(/\s+/).filter(Boolean);
}

export function siteSearchQuery(keyword: string): string {
  const terms = searchTerms(keyword);
  // Chinese book-name + author queries: send the title to native search forms,
  // then match all terms against the returned title/author fields.
  return terms.length > 1 && /\p{Script=Han}/u.test(terms[0]!) ? terms[0]! : keyword;
}

export function isAuthorIndex(result: SearchResult): boolean {
  if (result.kind === 'author-index' || /的全部作品|的作品列表|最新小说作品|全部小说作品|作品最新章节(?:列表|目录)|作者.{1,40}(?:最新小说大全|全部作品)/.test(result.title)) return true;
  try { return /\/(?:author|authors|writer|zuozhe)(?:\/|\?|$)|\/person\/\d+\/works/i.test(new URL(result.url).pathname); }
  catch { return false; }
}

export function isLikelyBookCandidate(result: SearchResult): boolean {
  if (result.kind === 'book' || isAuthorIndex(result)) return true;
  try {
    const url = new URL(result.url);
    return /\/(?:books?|novel|ebooks?|shu|read|reader|ibook|yuedu|chapterlist|catalog|xs)(?:[-/]|$)|^\/\d+(?:[_/]\d*)?(?:\/|\.html?$)/i.test(url.pathname)
      || /小说|书籍|章节|全本|全集|在线阅读|全文阅读|目录/.test(result.title);
  } catch { return false; }
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').replace(/[\s《》"'“”]/g, '').toLowerCase();
}

export function matchesSearchKeyword(result: SearchResult, keyword: string): boolean {
  const terms = searchTerms(keyword);
  const text = normalizeSearchText(`${result.title} ${result.author ?? ''} ${isLikelyBookCandidate(result) ? result.summary ?? '' : ''}`);
  return terms.length > 0 && terms.every((term) => text.includes(normalizeSearchText(term)));
}

export function isSearchNoise(result: SearchResult): boolean {
  if (/^(?:玄幻|仙侠|武侠|都市|历史|军事|科幻|言情|网游|其他|其它|全部|热门|最新)小说$/.test(result.title.trim())
    || /(?:民事|刑事|行政|一审|二审).*(?:判决书|裁定书)$/.test(result.title.trim())) return true;
  try {
    const url = new URL(assertSafeRemoteUrl(result.url));
    return !['http:', 'https:'].includes(url.protocol)
      || /\/(?:fenlei|sort|category|class|genre|rank|top|search|ask|question|bqd|bookquery)(?:\/|\.|$)|\/list\d+\/\d+(?:\/|$)/i.test(url.pathname)
      || /(?:^|\.)(?:baike\.baidu\.com|zhidao\.baidu\.com|wikipedia\.org|wiktionary\.org|huijiwiki\.com|bilibili\.com|youtube\.com|zhihu\.com|bgm\.tv|bk\.taobao\.com|book\.douban\.com|scribd\.com|weibo\.com|douyin\.com|xiaohongshu\.com|mp\.weixin\.qq\.com|archive\.org|openlibrary\.org|books\.google\.com|github\.com)$/i.test(url.hostname)
      || /(?:如何评价|按什么顺序|看完这篇|作品顺序|写作顺序|访谈|人物介绍|百科)/.test(result.title);
  } catch { return true; }
}

export function relevantSearchResults(results: SearchResult[], keyword: string): SearchResult[] {
  return results.filter((result) => !isSearchNoise(result) && !isAuthorIndex(result) && matchesSearchKeyword(result, keyword));
}

export function searchRank(result: SearchResult, keyword: string): number {
  const terms = searchTerms(keyword);
  const title = canonicalBookTitle(result.title);
  const author = normalizeSearchText(result.author ?? '');
  const titleTerms = terms.filter((term) => !author.includes(normalizeSearchText(term)));
  const query = canonicalBookTitle(titleTerms.join(' '));
  if (!query) return 1; // Author-only search: keep works, not author profiles.
  if (title === query) return 0;
  if (title.startsWith(query) && /^[ivx\d一二三四五六七八九十]/i.test(title.slice(query.length))) return 3;
  if (/(?:同人|重生|穿越|开局|人在|归来|聊天群)/.test(result.title) || /[:：]/.test(result.title)) return 4;
  if (title.startsWith(query)) return 2;
  return 4;
}

export function searchMatchLabel(result: SearchResult, keyword: string): string {
  const rank = searchRank(result, keyword);
  return rank === 0 ? '同名匹配，请核对作者' : rank === 1 ? '作者作品' : rank === 3 ? '系列或续作' : '相关作品';
}

export function rankedSearchCandidates(results: SearchResult[], keyword: string, limit = 8): SearchResult[] {
  const ranked = groupSearchResults(relevantSearchResults(results, keyword), keyword).flat();
  const candidates: SearchResult[] = [];
  for (let rank = 0; rank <= 4; rank += 1) {
    const tier = ranked.filter((item) => searchRank(item, keyword) === rank);
    const hosts = new Set<string>();
    const first = tier.filter((result) => {
      const host = new URL(result.url).hostname.replace(/^www\./i, '');
      if (hosts.has(host)) return false;
      hosts.add(host); return true;
    });
    candidates.push(...first, ...tier.filter((item) => !first.includes(item)));
  }
  return candidates.slice(0, limit);
}

export function filterSearchProviders<T extends { name: string }>(providers: T[], names?: string[]): T[] {
  return names === undefined ? providers : providers.filter((provider) => names.includes(provider.name));
}

export function sourceFailureLabel(error: string): string {
  if (/HTTP 429|请求频率|限流/.test(error)) return `来源限流：${error}`;
  if (/试读|截断|付费|订阅|购买/.test(error)) return `内容受限：${error}`;
  if (/CERT|certificate|证书/i.test(error)) return `证书校验失败（请检查代理或站点证书）：${error}`;
  if (/验证|challenge|captcha|Cloudflare/i.test(error)) return `需要验证：${error}`;
  if (/ECONN|UND_ERR_SOCKET|CONNECT_TIMEOUT|超时|DNS|代理/i.test(error)) return `网络或代理连接失败：${error}`;
  if (/匹配|结构|解析|未识别/i.test(error)) return `解析未通过：${error}`;
  return `请求失败：${error}`;
}

export function groupSearchResults(results: SearchResult[], keyword: string): SearchResult[][] {
  const groups = new Map<string, SearchResult[]>();
  const normalize = (value: string) => value.normalize('NFKC').replace(/[\s《》]/g, '').toLowerCase();
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    const key = `${canonicalBookTitle(result.title)}:${normalize(result.author ?? '')}`;
    const group = groups.get(key) ?? [];
    group.push(result);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    return searchRank(a[0]!, keyword) - searchRank(b[0]!, keyword);
  });
}
