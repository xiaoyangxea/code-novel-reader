import * as cheerio from 'cheerio/slim';
import { renderHtmlWithBrowser } from './browser';
import { FetchOptions, fetchHtml, assertSafeRemoteUrl, RateLimitedError } from './net';
import { SearchResult } from './model';
import { isAuthorIndex, isLikelyBookCandidate, isSearchNoise, matchesSearchKeyword, searchTerms } from './search-utils';
import { cleanAuthor } from './book-metadata';
import { expandAuthorIndexes } from './search-expansion';

type WebEngine = 'bing' | 'duckduckgo' | 'baidu';
const engines = {
  bing: { selector: '.b_algo h2 a', name: '全网 · Bing' },
  duckduckgo: { selector: '.result__a', name: '全网 · DuckDuckGo' },
  baidu: { selector: '#content_left h3 a, .c-container h3 a', name: '全网 · 百度' }
};

export function parseWebSearchHtml(html: string, baseUrl: string, engine: WebEngine, keyword?: string): SearchResult[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  return $(engines[engine].selector).toArray().flatMap((node) => {
    try {
      const href = $(node).attr('href');
      if (!href) return [];
      const link = new URL(href, baseUrl);
      let raw = link.searchParams.get('uddg') ?? link.toString();
      const tracking = link.searchParams.get('u');
      if (/^(?:cn\.|www\.)?bing\.com$/i.test(link.hostname) && tracking?.startsWith('a1')) raw = Buffer.from(tracking.slice(2), 'base64').toString('utf8');
      if (engine === 'baidu') {
        // Baidu exposes the actual destination in result metadata. Never import
        // an opaque /link URL or trust that metadata without public-URL checks.
        raw = $(node).closest('.c-container').attr('mu') || $(node).attr('data-landurl') || raw;
      }
      const target = assertSafeRemoteUrl(raw);
      if (/(?:^|\.)(?:bing|duckduckgo|baidu)\.com$/i.test(new URL(target).hostname) || seen.has(target)) return [];
      const title = $(node).text().trim();
      if (!title) return [];
      const container = $(node).closest('.b_algo,.result,.c-container');
      const summary = container.find('.b_caption p,.result__snippet,[data-module="abstract"],.c-abstract,[class*="abstract"]').first().text().replace(/\s+/g, ' ').trim().slice(0, 1200);
      const byline = summary.match(/(?:作\s*者|作者)\s*[:：]\s*([^,，。；;|\s]{1,40})/)?.[1]
        ?? title.normalize('NFKC').match(/\(([^()]{1,30})所著小说\)/)?.[1]
        ?? title.match(/_([^_]{1,30})小说/)?.[1];
      const result: SearchResult = { title, url: target, summary: summary || undefined, author: cleanAuthor(byline),
        provider: engines[engine].name, catalogStatus: 'unverified' };
      if (isAuthorIndex(result)) result.kind = 'author-index';
      if (isSearchNoise(result) || (keyword && (!isLikelyBookCandidate(result) || !matchesSearchKeyword(result, keyword)))) return [];
      seen.add(target);
      return [result];
    } catch { return []; }
  }).slice(0, 20);
}

export function webSearchQuery(keyword: string, page = 1): string {
  const quoted = searchTerms(keyword).map((term) => `"${term}"`).join(' ');
  return page === 1 ? `${quoted} 小说 目录` : page === 2 ? `${quoted} 在线阅读` : `${quoted} 小说 全部章节`;
}

export async function publicWebSearch(keyword: string, options: FetchOptions): Promise<SearchResult[]> {
  const page = Math.min(Math.max(options.searchPage ?? 1, 1), 3);
  const query = webSearchQuery(keyword, page);
  const expansionBudget = { remaining: 2 };
  const targets = [
    { id: 'bing' as const, url: `https://cn.bing.com/search?q=${encodeURIComponent(query)}&first=1`, name: '全网 · Bing' },
    { id: 'duckduckgo' as const, url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, name: '全网 · DuckDuckGo' },
    { id: 'baidu' as const, url: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`, name: '全网 · 百度' }
  ];
  const batches = await Promise.all(targets.map(async (target) => {
    try {
      if (options.shouldContinue?.() === false) return [];
      let results: SearchResult[] = [];
      let lastError: unknown;
      let hasResultMarkup = false;
      try {
        let finalUrl = target.url;
        const html = await fetchHtml(target.url, { ...options, maxBytes: 2_000_000, onFinalUrl: (url) => { finalUrl = url; } });
        hasResultMarkup = cheerio.load(html)(engines[target.id].selector).length > 0;
        results = parseWebSearchHtml(html, finalUrl, target.id, keyword);
      }
      catch (error) { lastError = error; }
      if (!results.length && !hasResultMarkup && !(lastError instanceof RateLimitedError) && options.browserRendering !== false && options.shouldContinue?.() !== false) {
        results = parseWebSearchHtml(await renderHtmlWithBrowser(target.url, options), target.url, target.id, keyword);
      }
      if (!results.length) throw lastError ?? new Error(hasResultMarkup ? '搜索页返回了结果，但没有匹配书名或作者的书籍候选。' : '未识别搜索结果，可能需要验证或搜索结构发生变化。');
      results = await expandAuthorIndexes(results, keyword, options, expansionBudget);
      if (!results.length) throw new Error('没有取得可导入的书籍候选；作者介绍或作品列表页不能直接作为小说导入。');
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
