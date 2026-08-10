import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio/slim';
import type { CheerioAPI, Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { loadCatalog, loadChapter, parseCatalogHtml, parseChapterHtml } from './adapters';
import { BrowserVerificationRequiredError, renderHtmlWithBrowser } from './browser';
import { NovelSource, ParsedCatalog, SearchResult } from './model';
import { assertSafeRemoteUrl, FetchOptions, fetchHtml, resolveUrl } from './net';
import { sourceAllowsUrl } from './source-policy';

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是 JSON 对象。`);
  return value as JsonRecord;
}

function text(value: unknown, label: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error(`${label}必须是非空字符串。`);
  return value.trim();
}

function selector(value: unknown, label: string, optional = false): string | undefined {
  const result = text(value, label, optional);
  if (!result) return undefined;
  const combinators = result.match(/[>+~\s]/g)?.length ?? 0;
  if (result.length > 160 || /[\r\n{};]/.test(result) || /:(?:has|contains|matches)\s*\(/i.test(result)
    || result.split(',').length > 8 || combinators > 16) {
    throw new Error(`${label}不是安全的 CSS 选择器。`);
  }
  try {
    cheerio.load('<main><a></a></main>')(result);
  } catch {
    throw new Error(`${label}不是有效的 CSS 选择器。`);
  }
  return result;
}

export function assertHttpUrl(rawUrl: string, label = 'URL'): string {
  try {
    return assertSafeRemoteUrl(rawUrl);
  } catch (error) {
    throw new Error(`${label}不安全：${error instanceof Error ? error.message : String(error)}`);
  }
}

function sourceId(name: string, domains: string[]): string {
  return `custom-${createHash('sha1').update(`${name}:${domains.join(',')}`).digest('hex').slice(0, 16)}`;
}

export function normalizeNovelSource(input: unknown, subscriptionUrl?: string): NovelSource {
  const root = record(input, '书源');
  if (root.version !== 1) throw new Error('仅支持 version 为 1 的安全书源格式。');
  const serialized = JSON.stringify(root);
  if (/"(?:script|javascript|eval|headers?|cookies?|authorization|password|command)"\s*:/i.test(serialized)) {
    throw new Error('书源包含脚本、凭据、请求头或命令字段，已拒绝导入。');
  }
  const name = text(root.name, '书源名称')!;
  if (!Array.isArray(root.domains) || root.domains.length === 0 || root.domains.length > 20) {
    throw new Error('domains 必须包含 1 到 20 个域名。');
  }
  const domains = [...new Set(root.domains.map((value) => {
    if (typeof value !== 'string') throw new Error('domains 中只能填写域名。');
    const inputDomain = value.trim().toLowerCase().replace(/^\*\./, '');
    let domain: string;
    try {
      domain = new URL(`https://${inputDomain}`).hostname;
    } catch {
      throw new Error(`无效域名：${value}`);
    }
    if (!/^(?:[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]{0,61}[a-z0-9\u00a1-\uffff])?\.)+[a-z\u00a1-\uffff]{2,}$/i.test(domain)) {
      throw new Error(`无效域名：${value}`);
    }
    return domain;
  }))];
  const catalog = record(root.catalog, 'catalog');
  const chapter = record(root.chapter, 'chapter');
  let search: NovelSource['search'];
  if (root.search !== undefined) {
    const value = record(root.search, 'search');
    const searchUrl = text(value.url, 'search.url')!;
    if (!/\{\{?keyword\}?\}/.test(searchUrl)) throw new Error('search.url 必须包含 {keyword} 或 {{keyword}}。');
    assertHttpUrl(searchUrl.replace(/\{\{?keyword\}?\}/g, 'test'), 'search.url');
    search = {
      url: searchUrl,
      resultSelector: selector(value.resultSelector, 'search.resultSelector')!,
      titleSelector: selector(value.titleSelector, 'search.titleSelector')!,
      urlSelector: selector(value.urlSelector, 'search.urlSelector')!,
      authorSelector: selector(value.authorSelector, 'search.authorSelector', true),
      latestChapterSelector: selector(value.latestChapterSelector, 'search.latestChapterSelector', true)
    };
  }
  const normalized: NovelSource = {
    version: 1,
    id: sourceId(name, domains),
    name,
    domains,
    enabled: root.enabled !== false,
    search,
    catalog: {
      titleSelector: selector(catalog.titleSelector, 'catalog.titleSelector')!,
      chapterSelector: selector(catalog.chapterSelector, 'catalog.chapterSelector')!,
      authorSelector: selector(catalog.authorSelector, 'catalog.authorSelector', true)
    },
    chapter: {
      titleSelector: selector(chapter.titleSelector, 'chapter.titleSelector')!,
      contentSelector: selector(chapter.contentSelector, 'chapter.contentSelector')!,
      previousSelector: selector(chapter.previousSelector, 'chapter.previousSelector', true),
      nextSelector: selector(chapter.nextSelector, 'chapter.nextSelector', true),
      catalogSelector: selector(chapter.catalogSelector, 'chapter.catalogSelector', true)
    },
    subscriptionUrl: subscriptionUrl ? assertHttpUrl(subscriptionUrl, '订阅 URL') : undefined,
    addedAt: typeof root.addedAt === 'number' ? root.addedAt : Date.now()
  };
  if (normalized.search && !sourceAllowsUrl(normalized, normalized.search.url.replace(/\{\{?keyword\}?\}/g, 'test'))) {
    throw new Error('search.url 必须属于 domains 中声明的域名。');
  }
  return normalized;
}

function scoped(scope: Cheerio<AnyNode>, selectorValue: string): Cheerio<AnyNode> {
  try {
    return scope.is(selectorValue) ? scope.first() : scope.find(selectorValue).first();
  } catch {
    return scope.find('__invalid_selector__');
  }
}

export function parseSourceSearchHtml(html: string, baseUrl: string, source: NovelSource): SearchResult[] {
  if (!source.search) return [];
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $(source.search.resultSelector).each((_, element) => {
    const scope = $(element);
    const titleNode = scoped(scope, source.search!.titleSelector);
    const urlNode = scoped(scope, source.search!.urlSelector);
    const title = titleNode.text().replace(/\s+/g, ' ').trim() || titleNode.attr('title')?.trim();
    const url = resolveUrl(urlNode.attr('href') ?? urlNode.find('a[href]').first().attr('href'), baseUrl);
    if (!title || !url || !sourceAllowsUrl(source, url) || results.length >= 100) return;
    results.push({
      title,
      url,
      provider: source.name,
      sourceId: source.id,
      author: source.search!.authorSelector ? scoped(scope, source.search!.authorSelector).text().replace(/\s+/g, ' ').trim() || undefined : undefined,
      latestChapter: source.search!.latestChapterSelector
        ? scoped(scope, source.search!.latestChapterSelector).text().replace(/\s+/g, ' ').trim() || undefined
        : undefined
    });
  });
  return results.filter((item, index) => results.findIndex((other) => other.url === item.url) === index);
}

async function sourcePageHtml(
  url: string,
  options: FetchOptions,
  validate: (html: string) => void,
  referer?: string
): Promise<string> {
  let staticError: unknown;
  const limited = { ...options, maxBytes: Math.min(options.maxBytes ?? 2_000_000, 2_000_000), referer };
  try {
    const html = await fetchHtml(url, limited);
    validate(html);
    return html;
  } catch (error) {
    staticError = error;
  }
  if (options.browserRendering === false) throw staticError;
  try {
    const html = await renderHtmlWithBrowser(url, limited);
    validate(html);
    return html;
  } catch (error) {
    if (error instanceof BrowserVerificationRequiredError) throw error;
    throw new Error(`普通抓取失败：${staticError instanceof Error ? staticError.message : String(staticError)}；浏览器渲染也失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function searchNovelSources(
  keyword: string,
  sources: NovelSource[],
  options: FetchOptions
): Promise<{ results: SearchResult[]; errors: string[] }> {
  const errors: string[] = [];
  const enabled = sources.filter((source) => source.enabled && source.search).slice(0, 50);
  const results: SearchResult[] = [];
  let verificationError: BrowserVerificationRequiredError | undefined;
  for (let offset = 0; offset < enabled.length; offset += 5) {
    const batch = await Promise.all(enabled.slice(offset, offset + 5).map(async (source) => {
      const url = source.search!.url.replace(/\{\{?keyword\}?\}/g, encodeURIComponent(keyword));
      try {
        let parsed: SearchResult[] = [];
        const html = await sourcePageHtml(url, options, (value) => {
          parsed = parseSourceSearchHtml(value, url, source);
          if (parsed.length === 0) throw new Error('搜索页没有匹配书源规则。');
        });
        return parsed.length ? parsed : parseSourceSearchHtml(html, url, source);
      } catch (error) {
        if (error instanceof BrowserVerificationRequiredError) verificationError ??= error;
        errors.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }));
    results.push(...batch.flat());
  }
  if (results.length === 0 && enabled.length === 1 && verificationError) throw verificationError;
  return { results, errors };
}

function selectorFor($: CheerioAPI, node: AnyNode): string | undefined {
  const current = $(node);
  const id = current.attr('id');
  if (id && /^[\w-]+$/.test(id)) return `#${id}`;
  const classes = (current.attr('class') ?? '').split(/\s+/).filter((value) => /^[\w-]+$/.test(value));
  if (classes[0]) return `.${classes[0]}`;
  const name = (node as { name?: string }).name;
  return name && /^[a-z][\w-]*$/i.test(name) ? name : undefined;
}

function findCatalogSelector($: CheerioAPI, catalog: ParsedCatalog, baseUrl: string): string {
  const known = ['#list', '.listmain', '.chapter-list', '.chapterlist', '.book_list', '.volume-list', '.catalog', '#chapter-list', '#chapters', '.zjlist'];
  let best = { selector: '', count: 0 };
  for (const candidate of known) {
    const count = $(candidate).find('a[href]').length;
    if (count > best.count) best = { selector: candidate, count };
  }
  if (best.count >= 2) return `${best.selector} a[href]`;
  const firstUrl = catalog.chapters[0]?.url;
  const anchor = $('a[href]').toArray().find((node) => resolveUrl($(node).attr('href'), baseUrl) === firstUrl);
  let parent = anchor ? $(anchor).parent() : undefined;
  for (let depth = 0; parent?.length && depth < 5; depth += 1, parent = parent.parent()) {
    if (parent.find('a[href]').length < 2) continue;
    const value = selectorFor($, parent[0]!);
    if (value) return `${value} a[href]`;
  }
  return 'a[href]';
}

function findContentSelector($: CheerioAPI): string {
  const known = ['#content', '#chaptercontent', '#chapter-content', '#read-content', '.chapter-content', '.read-content', '.content_detail', '.yd_text2', '.txtnav', '.article-content', '.entry-content', 'article'];
  let best = { selector: '', length: 0 };
  for (const candidate of known) {
    $(candidate).each((_, node) => {
      const length = $(node).text().replace(/\s+/g, '').length;
      if (length > best.length) best = { selector: candidate, length };
    });
  }
  if (best.length >= 80) return best.selector;
  $('main,section,div').each((_, node) => {
    const length = $(node).text().replace(/\s+/g, '').length;
    const value = selectorFor($, node);
    if (value && length > best.length) best = { selector: value, length };
  });
  return best.selector || 'article';
}

export async function generateNovelSource(catalogUrl: string, options: FetchOptions): Promise<{
  source: NovelSource;
  catalog: ParsedCatalog;
}> {
  const safeUrl = assertHttpUrl(catalogUrl, '目录 URL');
  let catalog: ParsedCatalog | undefined;
  const catalogHtml = await sourcePageHtml(safeUrl, options, (html) => {
    catalog = parseCatalogHtml(html, safeUrl);
    if (catalog.chapters.length < 2) throw new Error('没有识别到完整目录，无法生成书源。');
  });
  if (!catalog || catalog.chapters.length < 2) throw new Error('没有识别到完整目录，无法生成书源。');
  const firstChapter = catalog.chapters[0]!;
  const chapterHtml = await sourcePageHtml(firstChapter.url, options, (html) => {
    parseChapterHtml(html, firstChapter.url);
  }, safeUrl);
  const catalogPage = cheerio.load(catalogHtml);
  const chapterPage = cheerio.load(chapterHtml);
  const hostname = new URL(safeUrl).hostname;
  const draft = normalizeNovelSource({
    version: 1,
    name: `${hostname}（自动生成）`,
    domains: [hostname],
    catalog: {
      titleSelector: catalogPage('h1').length ? 'h1' : 'title',
      chapterSelector: findCatalogSelector(catalogPage, catalog, safeUrl)
    },
    chapter: {
      titleSelector: chapterPage('h1').length ? 'h1' : 'title',
      contentSelector: findContentSelector(chapterPage)
    }
  });
  await loadChapter(firstChapter.url, options, draft);
  return { source: draft, catalog };
}

export async function testNovelSource(source: NovelSource, catalogUrl: string, options: FetchOptions): Promise<{
  catalog: ParsedCatalog;
  sampleTitle: string;
}> {
  const url = assertHttpUrl(catalogUrl, '测试目录 URL');
  const hostname = new URL(url).hostname.toLowerCase();
  if (!source.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new Error(`测试 URL 不属于书源域名：${source.domains.join(', ')}`);
  }
  const catalog = await loadCatalog(url, options, source);
  if (catalog.chapters.length < 2) throw new Error('目录选择器识别到的章节不足 2 个。');
  const sample = await loadChapter(catalog.chapters[0]!.url, options, source);
  return { catalog, sampleTitle: sample.title };
}
