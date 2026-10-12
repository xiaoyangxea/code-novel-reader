import * as cheerio from 'cheerio/slim';
import { renderHtmlWithBrowser } from './browser';
import { FetchOptions, fetchHtml, assertSafeRemoteUrl } from './net';
import { SearchResult } from './model';

export function parseWebSearchHtml(html: string, baseUrl: string, engine: 'bing' | 'duckduckgo'): SearchResult[] {
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    return $(engine === 'bing' ? '.b_algo h2 a' : '.result__a').toArray().flatMap((node) => {
      try {
        const link = new URL($(node).attr('href') ?? '', baseUrl);
        let raw = link.searchParams.get('uddg') ?? link.toString();
        const tracking = link.searchParams.get('u');
        if (/^(?:cn\.|www\.)?bing\.com$/i.test(link.hostname) && tracking?.startsWith('a1')) raw = Buffer.from(tracking.slice(2), 'base64').toString('utf8');
        const target = assertSafeRemoteUrl(raw);
        if (/(?:^|\.)(?:bing|duckduckgo)\.com$/i.test(new URL(target).hostname) || seen.has(target)) return [];
        seen.add(target);
        const title = $(node).text().trim();
        if (!title) return [];
        return [{ title, url: target, provider: engine === 'bing' ? '全网 · Bing' : '全网 · DuckDuckGo', catalogStatus: 'unverified' as const }];
      } catch { return []; }
    }).slice(0, 20);
}

export async function publicWebSearch(keyword: string, options: FetchOptions): Promise<SearchResult[]> {
  const page = Math.min(Math.max(options.searchPage ?? 1, 1), 3);
  const query = page === 1 ? `${keyword} 小说 目录` : page === 2 ? `"${keyword}" 在线阅读` : `${keyword} 小说 全部章节`;
  const targets = [
    { id: 'bing' as const, url: `https://cn.bing.com/search?q=${encodeURIComponent(query)}&first=1`, name: '全网 · Bing' },
    { id: 'duckduckgo' as const, url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, name: '全网 · DuckDuckGo' }
  ];
  const batches = await Promise.all(targets.map(async (target) => {
    try {
      if (options.shouldContinue?.() === false) return [];
      let results: SearchResult[] = [];
      let lastError: unknown;
      try { results = parseWebSearchHtml(await fetchHtml(target.url, { ...options, maxBytes: 2_000_000 }), target.url, target.id); }
      catch (error) { lastError = error; }
      if (!results.length && options.browserRendering !== false && options.shouldContinue?.() !== false) {
        results = parseWebSearchHtml(await renderHtmlWithBrowser(target.url, options), target.url, target.id);
      }
      if (!results.length) throw lastError ?? new Error('未识别搜索结果，可能需要验证或搜索结构发生变化。');
      options.onSearchBatch?.(results, target.name);
      return results;
    } catch (error) {
      options.onSearchBatch?.([], target.name, error instanceof Error ? error.message : String(error));
      return [];
    }
  }));
  const results = batches.flat();
  if (!results.length && options.shouldContinue?.() !== false) throw new Error('全网搜索暂未取得结果，请查看来源状态或尝试 Brave API。');
  return results.filter((result, index) => results.findIndex((item) => item.url === result.url) === index);
}
