import * as cheerio from 'cheerio/slim';
import { renderHtmlWithBrowser } from './browser';
import { FetchOptions, fetchHtml, assertSafeRemoteUrl } from './net';
import { SearchResult } from './model';

export async function publicWebSearch(keyword: string, options: FetchOptions): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${keyword} 小说 目录`)}`;
  const parse = (html: string) => {
    const $ = cheerio.load(html);
    return $('.result__a').toArray().flatMap((node) => {
      try {
        const link = new URL($(node).attr('href') ?? '', url);
        const target = assertSafeRemoteUrl(link.searchParams.get('uddg') ?? link.toString());
        if (new URL(target).hostname.endsWith('duckduckgo.com')) return [];
        return [{ title: $(node).text().trim(), url: target, provider: '公开网页搜索', catalogStatus: 'unverified' as const }];
      } catch { return []; }
    }).slice(0, 20);
  };
  let results: SearchResult[] = [];
  try { results = parse(await fetchHtml(url, { ...options, maxBytes: 2_000_000 })); } catch { /* Try browser next. */ }
  if (!results.length && options.browserRendering !== false) results = parse(await renderHtmlWithBrowser(url, options));
  if (!results.length) throw new Error('公开搜索未返回可识别结果，可能遇到验证或结构变化；可改用网络发现或导入 URL。');
  return results;
}
