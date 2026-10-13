import * as cheerio from 'cheerio/slim';
import { parseSearchHtml } from './adapters';
import { cleanAuthor } from './book-metadata';
import type { SearchResult } from './model';
import { assertSafeRemoteUrl, fetchHtml, type FetchOptions } from './net';
import { isAuthorIndex, isSearchNoise, relevantSearchResults, searchTerms } from './search-utils';

export function parseAuthorIndexBooks(html: string, url: string, index: SearchResult, keyword: string): SearchResult[] {
  const $ = cheerio.load(html);
  const heading = $('h1,.author-name,.authorName').first().text().trim();
  const byline = index.title.match(/^(.{1,40}?)(?:的全部作品|的作品列表|最新小说大全|全部作品)/)?.[1];
  const author = cleanAuthor(index.author) || cleanAuthor(byline) || (searchTerms(keyword).length === 1
    && heading === keyword.trim() ? cleanAuthor(heading) : undefined);
  const workScope = $('main,.author-books,.author-work,.works-list,.ranklist').first();
  const workHtml = workScope.length ? workScope.html() ?? '' : html;
  return relevantSearchResults(parseSearchHtml(workHtml, url, index.provider).flatMap((book) => {
    try {
      const target = assertSafeRemoteUrl(book.url);
      if (new URL(target).origin !== new URL(url).origin || target === url || isAuthorIndex(book)) return [];
      const explicitAuthor = cleanAuthor(book.author);
      return [{ ...book, author: explicitAuthor || author, authorInferred: !explicitAuthor && Boolean(author), kind: 'book' as const, catalogStatus: 'unverified' as const }];
    } catch { return []; }
  }), keyword).slice(0, 40);
}

/** No recursion or browser launch; at most two public author-index requests. */
export async function expandAuthorIndexes(items: SearchResult[], keyword: string, options: FetchOptions,
  budget = { remaining: 2 }): Promise<SearchResult[]> {
  const books = items.filter((item) => !isAuthorIndex(item) && !isSearchNoise(item));
  for (const index of items.filter((item) => isAuthorIndex(item) && !isSearchNoise(item))) {
    if (options.shouldContinue?.() === false || budget.remaining <= 0) break;
    budget.remaining -= 1;
    try {
      let finalUrl = index.url;
      const html = await fetchHtml(index.url, { ...options, timeoutMs: Math.min(options.timeoutMs, 7000),
        browserRendering: false, maxBytes: 1_000_000, onFinalUrl: (value) => { finalUrl = value; } });
      if (options.shouldContinue?.() === false) break;
      books.push(...parseAuthorIndexBooks(html, finalUrl, index, keyword));
    } catch (error) {
      options.onSearchBatch?.([], `${index.provider} · 作者作品`, error instanceof Error ? error.message : String(error));
    }
  }
  return relevantSearchResults(books, keyword).filter((item, i, all) => all.findIndex((other) => other.url === item.url) === i);
}
