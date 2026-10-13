import * as cheerio from 'cheerio/slim';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { BrowserAutomationBlockedError, BrowserVerificationRequiredError, isBrowserChallengeHtml, renderHtmlBatchWithBrowser, renderHtmlWithBrowser } from './browser';
import { Book, ChapterContent, ChapterRef, NovelSource, ParsedCatalog, SearchProviderConfig, SearchResult } from './model';
import { FetchOptions, fetchHtml, resolveUrl, RateLimitedError } from './net';
import { builtInSearchProviders, BuiltInSearchProvider, profileForUrl, SiteProfile } from './sites';
import { requireSourceUrl, sourceAllowsUrl } from './source-policy';
import { filterSearchProviders, relevantSearchResults, siteSearchQuery } from './search-utils';
import { cleanAuthor } from './book-metadata';
import { RestrictedChapterError, isSuspectedCachedExcerpt } from './chapter-quality';

const chapterTitlePattern = /^(?:正文\s*)?(?:第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*[章回卷节篇部集]|chapter\s*\d+|序章|序言|楔子|引子|前言|后记|番外|尾声)/i;
const noisePattern = /^(?:上一章|下一章|上一页|下一页|返回目录|章节目录|手机阅读|加入书签|投推荐票|请记住|最新网址|本章未完|点击下一页|喜欢.*请收藏|天才一秒记住)/i;
const catalogNoisePattern = /^(?:分卷阅读|展开|收起|返回|目录|全部章节|加入书架|立即阅读|下载|点击查看)/i;
const browserPreferenceLifetimeMs = 30 * 60 * 1000;
const browserPreferredUntil = new Map<string, number>();

function browserIsPreferred(url: string): boolean {
  return (browserPreferredUntil.get(new URL(url).origin) ?? 0) > Date.now();
}

function tidy(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/[\t\r]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

function cleanNovelText(value: string): string {
  const lines = value
    .replace(/\r/g, '')
    .split('\n')
    .map(tidy)
    .filter((line) => line.length > 0 && !noisePattern.test(line));
  const output: string[] = [];
  for (const line of lines) {
    if (output.at(-1) !== line) {
      output.push(line);
    }
  }
  return output.join('\n\n');
}

function assertReadablePage(html: string): void {
  if (isBrowserChallengeHtml(html)) {
    throw new Error('站点返回了人机验证页面；需要使用插件的专用浏览器验证。');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanChapterPageText(content: string, title: string): string {
  const escapedTitle = escapeRegExp(title.replace(/\s*[（(]第\s*\d+\s*\/\s*\d+\s*[页頁][）)]\s*$/i, '').trim());
  const pageMarker = '[（(]?第\\s*\\d+\\s*\\/\\s*\\d+\\s*[页頁][）)]?';
  return content
    .replace(new RegExp(`^\\s*${escapedTitle}\\s*${pageMarker}?\\s*`, 'i'), '')
    .replace(new RegExp(`^\\s*${pageMarker}\\s*`, 'i'), '')
    .replace(/[（(]本章未完[^）)]*[）)]/g, '')
    .replace(/read\d+\(\);?/gi, '')
    .trim();
}

function hiddenSelectorsFromStyles($: CheerioAPI): string[] {
  const selectors: string[] = [];
  const hiddenDeclaration = /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\D|$)|font-size\s*:\s*0(?:\D|$)|text-indent\s*:\s*-\d{3,}|left\s*:\s*-\d{3,})/i;
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  $('style').each((_, style) => {
    const css = $(style).text();
    for (const match of css.matchAll(rulePattern)) {
      if (!hiddenDeclaration.test(match[2] ?? '')) continue;
      for (const selector of (match[1] ?? '').split(',').map((value) => value.trim())) {
        if (selectors.length >= 64) break;
        // Avoid feeding at-rules or pathological selectors into css-select.
        const combinators = selector.match(/[>+~\s]/g)?.length ?? 0;
        if (selector && selector.length <= 120 && !selector.startsWith('@')
          && !/:(?:has|contains|matches)\s*\(/i.test(selector) && combinators <= 16) {
          selectors.push(selector);
        }
      }
      if (selectors.length >= 64) return false;
    }
  });
  return [...new Set(selectors)];
}

function textWithBreaks($: CheerioAPI, node: AnyNode): string {
  const clone = $(node).clone();
  clone.find('script,style,noscript,iframe,form,button,select,.ad,.ads,.advert,.recommend,.tips,.tools,.toolbar,[hidden],[aria-hidden="true"]').remove();
  for (const selector of hiddenSelectorsFromStyles($)) {
    try {
      clone.find(selector).remove();
    } catch {
      // Ignore selectors that Cheerio does not implement (for example browser-only pseudo classes).
    }
  }
  clone.find('*').each((_, element) => {
    const current = $(element);
    const style = (current.attr('style') ?? '').toLowerCase().replace(/\s+/g, '');
    const className = current.attr('class') ?? '';
    const id = current.attr('id') ?? '';
    const hiddenByStyle = /(?:display:none|visibility:hidden|opacity:0(?:;|$)|font-size:0(?:px|em|rem|%;|$)|text-indent:-\d{3,}|left:-\d{3,})/.test(style);
    const hiddenByName = /(?:^|[-_])(hidden?|anti|noise|watermark|crawler|spider|bot)(?:[-_]|$)/i.test(`${className} ${id}`);
    if (hiddenByStyle || hiddenByName) current.remove();
  });
  clone.find('br').replaceWith('\n');
  clone.find('p,div,li').each((_, element) => {
    $(element).append('\n');
  });
  return cleanNovelText(clone.text());
}

function candidateScore(text: string, linkCount: number): number {
  const chinese = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const punctuation = (text.match(/[。！？；：“”]/g) ?? []).length;
  return text.length + chinese * 0.8 + punctuation * 3 - linkCount * 45;
}

function selectContent($: CheerioAPI, profile?: SiteProfile): string {
  const preferred = [
    ...(profile?.contentSelectors ?? []),
    '#content', '#chaptercontent', '#chapter-content', '#read-content',
    '#chapterContent', '#reader-content', '#booktxt', '#txt', '#novelcontent', '#BookText',
    '.chapter-content', '.chapterContent', '.read-content', '.readcontent', '.readarea',
    '.content_detail', '.yd_text2', '.novelcontent', '.txtnav', '.article-content',
    '.entry-content', '.contentbox', 'article'
  ];
  let best: { text: string; score: number } | undefined;
  const seen = new Set<AnyNode>();
  let checked = 0;
  const consider = (node: AnyNode, bonus: number, minimum: number): boolean => {
    if (seen.has(node)) return true;
    seen.add(node);
    checked += 1;
    if (checked > 300) return false;
    const text = textWithBreaks($, node);
    if (text.length >= minimum) {
      const score = candidateScore(text, $(node).find('a').length) + bonus;
      if (!best || score > best.score) best = { text, score };
    }
    return true;
  };
  for (const selector of [...new Set(preferred)]) {
    $(selector).each((_, node) => {
      if (!consider(node, 500, 120)) return false;
    });
  }
  if (!best) {
    $('main,section,div').each((_, node) => {
      if (!consider(node, 0, 300)) return false;
    });
  }
  return best?.text ?? '';
}

function valueFromSelector($: CheerioAPI, selector: string): string {
  const node = $(selector).first();
  return tidy(node.is('meta') ? node.attr('content') ?? '' : node.text());
}

function titleFromPage($: CheerioAPI, profile?: SiteProfile): string {
  const selectors = [
    ...(profile?.chapterTitleSelectors ?? []),
    'h1', '.bookname h1', '.chaptername', '.chapter-name', '.chapter-title',
    '.read-title', '.title_txtbox', '#info h1'
  ];
  for (const selector of selectors) {
    const value = valueFromSelector($, selector);
    if (value) {
      return value;
    }
  }
  return tidy($('title').text()).split(/[_\-|—]/)[0]?.trim() || '未命名章节';
}

function bestLink($: CheerioAPI, baseUrl: string, patterns: RegExp[]): string | undefined {
  let best: { url: string; rank: number } | undefined;
  $('a[href]').each((_, anchor) => {
    const label = tidy($(anchor).text()) || tidy($(anchor).attr('title') ?? '');
    const rank = patterns.findIndex((pattern) => pattern.test(label));
    if (rank < 0) {
      return;
    }
    const url = resolveUrl($(anchor).attr('href'), baseUrl);
    if (url && url !== baseUrl && (!best || rank < best.rank)) best = { url, rank };
    if (best?.rank === 0) return false;
  });
  return best?.url;
}

function linkFromSelector($: CheerioAPI, selector: string | undefined, baseUrl: string): string | undefined {
  if (!selector) return undefined;
  try {
    const node = $(selector).first();
    return resolveUrl(node.attr('href') ?? node.find('a[href]').first().attr('href'), baseUrl);
  } catch {
    return undefined;
  }
}

function allowedSourceLink(source: NovelSource | undefined, url: string | undefined): string | undefined {
  return !source || !url || sourceAllowsUrl(source, url) ? url : undefined;
}

function customProfile(source: NovelSource | undefined, url: string): SiteProfile | undefined {
  if (!source) return profileForUrl(url);
  return {
    id: source.id,
    name: source.name,
    hosts: /$a/,
    contentSelectors: [source.chapter.contentSelector],
    catalogSelectors: [],
    chapterTitleSelectors: [source.chapter.titleSelector],
    bookTitleSelectors: [source.catalog.titleSelector],
    authorSelectors: source.catalog.authorSelector ? [source.catalog.authorSelector] : []
  };
}

export function parseChapterHtml(html: string, url: string, source?: NovelSource): ChapterContent {
  assertReadablePage(html);
  const $ = cheerio.load(html);
  const profile = customProfile(source, url);
  const rawTitle = titleFromPage($, profile).replace(/\s*[（(](?:第\s*)?\d+\s*\/\s*\d+\s*[页頁]?[）)]\s*$/i, '').trim();
  const breadcrumbTitle = rawTitle.split(/\s*[>›»]\s*/).at(-1)?.trim() ?? rawTitle;
  const title = chapterTitlePattern.test(breadcrumbTitle) ? breadcrumbTitle : rawTitle;
  const content = cleanChapterPageText(selectContent($, profile), title);
  const masked = $('#article.isMask,.chapter-content.isMask,.chapter-content[data-locked="true"],.chapter-content[data-preview="true"]').filter((_, node) =>
    !$(node).is('[hidden],[aria-hidden="true"]') && !/display\s*:\s*none/i.test($(node).attr('style') ?? '')).length > 0;
  const accessPrompt = $('#article,.chapter-content,#content').text();
  if (masked || isSuspectedCachedExcerpt({ url, content, title })
    || /(?:本章|章节|正文).{0,24}(?:订阅后|购买后|付费后)|^\s*请(?:先)?(?:登录|登陆)(?:后)?(?:阅读|查看)/.test(accessPrompt.trim())) throw new RestrictedChapterError();
  if (content.length < 80) {
    throw new Error('未能识别正文；页面可能需要登录、使用动态脚本，或站点规则尚未适配。');
  }
  return {
    title,
    content,
    url,
    previousUrl: allowedSourceLink(source, linkFromSelector($, source?.chapter.previousSelector, url)
      ?? bestLink($, url, [/^上一(?:章|回|节)$/i, /上一章节/i, /prev(?:ious)?\s*chapter/i])),
    nextUrl: allowedSourceLink(source, linkFromSelector($, source?.chapter.nextSelector, url)
      ?? bestLink($, url, [/^下一(?:章|回|节)$/i, /下一章节/i, /next\s*chapter/i])),
    catalogUrl: allowedSourceLink(source, linkFromSelector($, source?.chapter.catalogSelector, url)
      ?? bestLink($, url, [/章节目录/i, /^目录$/i, /返回目录/i, /book\s*index/i]))
  };
}

function chapterRefsFromAnchors($: CheerioAPI, anchors: AnyNode[], baseUrl: string): ChapterRef[] {
  const chapters: ChapterRef[] = [];
  $(anchors).each((_, anchor) => {
    if (chapters.length >= 20_000) return false;
    const title = tidy($(anchor).text());
    const url = resolveUrl($(anchor).attr('href'), baseUrl);
    if (title && url && chapterLinkCompatible(url, baseUrl, title) && !catalogNoisePattern.test(title) && !/\/totaltome\//i.test(url)
      && (chapterTitlePattern.test(title) || title.length >= 2)) {
      chapters.push({ title, url });
    }
  });
  return dedupeChapters(chapters);
}

function chapterLinkCompatible(rawUrl: string, baseUrl: string, title: string): boolean {
  const target = new URL(rawUrl);
  const base = new URL(baseUrl);
  if (target.href === base.href) return false;
  const profile = profileForUrl(baseUrl);
  const targetCatalog = profile?.inferCatalogUrl?.(new URL(rawUrl));
  const currentCatalog = profile?.inferCatalogUrl?.(new URL(baseUrl));
  if (targetCatalog && currentCatalog) {
    const current = new URL(currentCatalog);
    const inferred = new URL(targetCatalog);
    return profileForUrl(rawUrl)?.id === profile?.id && current.pathname === inferred.pathname && current.search === inferred.search;
  }
  const directory = base.pathname.replace(/(?:catalog|list|index)\/?$/i, '');
  if (directory.endsWith('/') && /\d|\/(?:book|novel|shu|xs-|ibook)\//i.test(directory)) {
    if (target.pathname.startsWith(directory) && target.pathname !== directory) return true;
    const bookId = directory.match(/\/(?:book|novel|shu)\/(\d+)/)?.[1];
    if (bookId && new RegExp(`^/(?:read|chapter|book)/${bookId}(?:/|$)`).test(target.pathname)) return true;
    // A root-level chapter endpoint may use global IDs. Only explicit chapter
    // labels qualify; another book's directory or a generic recommendation does not.
    return chapterTitlePattern.test(title) && /\.(?:html?|aspx|php)$/i.test(target.pathname)
      && target.pathname.split('/').filter(Boolean).length === 1;
  }
  return true;
}

function anchorsFromContainer($: CheerioAPI, selector: string, baseUrl: string, largestOnly = false): ChapterRef[] {
  const selected = $(selector);
  const latest = new Set<AnyNode>();
  selected.find('dt,h2,h3').each((_, heading) => {
    if (!/最新章节|最近更新/.test(tidy($(heading).text()))) return;
    const siblings = $(heading).siblings('dt,h2,h3');
    if (!siblings.toArray().some((node) => /正文|全部章节|完整目录|章节列表|全部目录/.test(tidy($(node).text())))) return;
    $(heading).nextAll().each((_, sibling) => {
      if ($(sibling).is('dt,h2,h3')) return false;
      for (const anchor of $(sibling).find('a[href]').add($(sibling).filter('a[href]')).toArray()) latest.add(anchor);
    });
  });
  const anchorsFor = (container: AnyNode[]) => $(container).find('a[href]').toArray().filter((anchor) => !latest.has(anchor));
  if (!largestOnly) return chapterRefsFromAnchors($, anchorsFor(selected.toArray()), baseUrl);
  let best: ChapterRef[] = [];
  selected.each((_, container) => {
    const current = chapterRefsFromAnchors($, anchorsFor([container]), baseUrl);
    if (current.length > best.length) best = current;
  });
  return best;
}

function dedupeChapters(chapters: ChapterRef[]): ChapterRef[] {
  const seen = new Set<string>();
  return chapters.filter((chapter) => {
    if (seen.has(chapter.url)) {
      return false;
    }
    seen.add(chapter.url);
    return true;
  });
}

const chineseDigits: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9
};

function chineseNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  if (!/^[零〇一二两三四五六七八九十百千万]+$/.test(value)) return undefined;
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const character of value) {
    if (character in chineseDigits) {
      digit = chineseDigits[character] ?? 0;
      continue;
    }
    const unit = character === '十' ? 10 : character === '百' ? 100 : character === '千' ? 1000 : 10000;
    if (unit === 10000) {
      section = (section + digit) * unit;
      total += section;
      section = 0;
    } else {
      section += (digit || 1) * unit;
    }
    digit = 0;
  }
  return total + section + digit;
}

function chapterOrdinal(title: string): number | undefined {
  const match = title.match(/(?:正文\s*)?第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*[章回节篇集]/i)
    ?? title.match(/^chapter\s*(\d+)/i);
  return match?.[1] ? chineseNumber(match[1]) : undefined;
}

function normalizeCatalogOrder(chapters: ChapterRef[], profile?: SiteProfile): ChapterRef[] {
  if (chapters.length < 2) return chapters;
  const indexed = chapters.map((chapter, index) => ({ chapter, index, ordinal: chapterOrdinal(chapter.title) }));
  const numbered = indexed.filter((item) => item.ordinal !== undefined);
  if (numbered.length / chapters.length < 0.65) return chapters;
  const explicitSort = profile?.id === 'mayiwsk' || profile?.sortCatalogByOrdinal;
  if (!explicitSort) {
    // Only reverse a clearly descending, globally numbered list. Volume-local
    // numbering resets and ascending catalogs must retain their original order.
    if (new Set(numbered.map((item) => item.ordinal)).size !== numbered.length) return chapters;
    const descending = numbered.slice(1).filter((item, index) => item.ordinal! < numbered[index]!.ordinal!).length;
    if (descending / (numbered.length - 1) >= 0.9) return [...chapters].reverse();
    return chapters;
  }

  // Mayi places a "latest chapters" block before the complete catalog. Stable
  // numeric ordering folds that prefix back into the actual chapter sequence.
  return indexed.sort((left, right) => {
    if (left.ordinal === undefined && right.ordinal === undefined) return left.index - right.index;
    if (left.ordinal === undefined) return 1;
    if (right.ordinal === undefined) return -1;
    return left.ordinal - right.ordinal || left.index - right.index;
  }).map((item) => item.chapter);
}

export function normalizeSavedCatalog(book: Book): Book {
  if (book.kind !== 'online') return book;
  const chapters = normalizeCatalogOrder(book.chapters, profileForUrl(book.source));
  const author = cleanAuthor(book.author);
  if (author === book.author && chapters.every((chapter, index) => chapter === book.chapters[index])) return book;
  return { ...book, author, chapters };
}

function inferChapterAnchors($: CheerioAPI, baseUrl: string): ChapterRef[] {
  const chapters: ChapterRef[] = [];
  $('a[href]').each((_, anchor) => {
    if (chapters.length >= 20_000) return false;
    const title = tidy($(anchor).text());
    if (!chapterTitlePattern.test(title)) {
      return;
    }
    const url = resolveUrl($(anchor).attr('href'), baseUrl);
    if (url && chapterLinkCompatible(url, baseUrl, title)) {
      chapters.push({ title, url });
    }
  });
  return dedupeChapters(chapters);
}

function authorFromPage($: CheerioAPI, profile?: SiteProfile): string | undefined {
  for (const selector of ['meta[property="og:novel:author"]', 'meta[name="og:novel:author"]', '[itemprop="author"]', 'a[rel="author"]']) {
    const value = cleanAuthor(valueFromSelector($, selector));
    if (value) return value;
  }
  for (const selector of profile?.authorSelectors ?? []) {
    const value = cleanAuthor(valueFromSelector($, selector));
    if (value) return value;
  }
  const explicit = cleanAuthor($('[itemprop="author"],.author,.book-author,.author-name').first().text());
  if (explicit) {
    return explicit;
  }
  for (const node of $('p').toArray().slice(0, 500)) {
    const text = tidy($(node).text());
    const match = text.match(/^\s*(?:作\s*者|作者)\s*[：:]\s*(.+)/);
    if (match?.[1]) {
      const value = cleanAuthor(match[1]);
      if (value) return value;
    }
  }
  return undefined;
}

export function parseCatalogHtml(html: string, url: string, source?: NovelSource): ParsedCatalog {
  assertReadablePage(html);
  const $ = cheerio.load(html);
  const profile = customProfile(source, url);
  const selectors = [
    ...(profile?.catalogSelectors ?? []),
    '#list', '.listmain', '.chapter-list', '.chapterlist', '.book_list',
    '.volume-list', '.catalog', '#catalog', '#chapter-list', '#chapterlist',
    '#chapters', '.zjlist', '.directory', '.section-list', '.full_chapters'
  ];
  let chapters: ChapterRef[] = [];
  if (source) {
    try {
      const selected = $(source.catalog.chapterSelector);
      const anchors = selected.filter('a[href]').add(selected.find('a[href]'));
      anchors.each((_, anchor) => {
        const title = tidy($(anchor).text()) || tidy($(anchor).attr('title') ?? '');
        const chapterUrl = resolveUrl($(anchor).attr('href'), url);
        if (chapters.length >= 20_000) return false;
        if (title && chapterUrl && sourceAllowsUrl(source, chapterUrl) && !catalogNoisePattern.test(title)) {
          chapters.push({ title, url: chapterUrl });
        }
      });
      chapters = dedupeChapters(chapters);
    } catch {
      throw new Error('书源的目录选择器无效。');
    }
  } else {
    for (const selector of selectors) {
      const current = anchorsFromContainer($, selector, url, Boolean(profile?.largestCatalogContainer));
      if (current.length > chapters.length) {
        chapters = current;
      }
    }
  }
  if (chapters.length < 2) {
    chapters = inferChapterAnchors($, url);
  }
  if (source) chapters = chapters.filter((chapter) => sourceAllowsUrl(source, chapter.url)).slice(0, 20_000);
  chapters = normalizeCatalogOrder(chapters, profile);
  let title = '';
  for (const selector of profile?.bookTitleSelectors ?? []) {
    title = valueFromSelector($, selector);
    if (title) break;
  }
  title ||= tidy($('#info h1,.book-info h1,.bookname h1,h1').first().text())
    || tidy($('title').text()).split(/[_\-|—]/)[0]?.trim()
    || '未命名小说';
  return { title, author: authorFromPage($, profile), chapters };
}

function catalogIdentity(profile: SiteProfile, rawUrl: string): string | undefined {
  const path = new URL(rawUrl).pathname;
  const patterns: Record<string, RegExp> = {
    qidiy: /\/book\/(\d+)/i,
    kudushu: /\/(?:book|html)\/(?:\d+\/)?(\d+)/i,
    sudugu: /^\/(\d+)(?:\/|$)/i,
    xszj: /\/b\/(\d+)/i,
    biquge365: /\/(?:shu|book|newbook)\/(\d+)/i
  };
  return patterns[profile.id]?.exec(path)?.[1];
}

function catalogPageNumber(rawUrl: string): number {
  const path = new URL(rawUrl).pathname;
  const match = path.match(/(?:_|p-|asc-|\/cs\/)(\d+)(?:\.html)?\/?$/i);
  return match?.[1] ? Number(match[1]) : 1;
}

export function catalogPageUrls(html: string, url: string): string[] {
  const profile = profileForUrl(url);
  if (!profile) return [];
  const $ = cheerio.load(html);
  const values: string[] = [];
  for (const selector of profile.catalogPageSelectors ?? []) {
    try {
      $(selector).each((_, node) => {
        const value = $(node).attr('value') ?? $(node).attr('href');
        if (value) values.push(value);
      });
    } catch {
      // A malformed site-specific selector should not break generic discovery.
    }
  }
  $('a[href]').each((_, anchor) => {
    const label = tidy($(anchor).text()) || tidy($(anchor).attr('title') ?? '');
    const rel = ($(anchor).attr('rel') ?? '').toLowerCase().split(/\s+/);
    const href = $(anchor).attr('href');
    if (href && (rel.includes('next') || /^(?:下一页|下页|下一頁)(?:[>›»→]*)$/i.test(label))) values.push(href);
    if (href && profile.catalogPageUrlPattern) {
      const candidate = resolveUrl(href, url);
      if (candidate && profile.catalogPageUrlPattern.test(new URL(candidate).pathname)) values.push(href);
    }
  });

  const current = new URL(url);
  const identity = catalogIdentity(profile, url);
  const seen = new Set<string>([current.toString()]);
  return values.flatMap((value) => {
    const resolved = resolveUrl(value, url);
    if (!resolved || seen.has(resolved)) return [];
    try {
      const candidate = new URL(resolved);
      if (candidate.hostname !== current.hostname) return [];
      if (profile.catalogPageUrlPattern && !profile.catalogPageUrlPattern.test(candidate.pathname)) return [];
      const candidateIdentity = catalogIdentity(profile, resolved);
      if (identity && candidateIdentity !== identity) return [];
      candidate.hash = '';
      const normalized = candidate.toString();
      if (seen.has(normalized)) return [];
      seen.add(normalized);
      return [normalized];
    } catch {
      return [];
    }
  }).sort((left, right) => catalogPageNumber(left) - catalogPageNumber(right));
}

function parseSearchRows($: CheerioAPI, baseUrl: string, provider: string): SearchResult[] {
  const results: SearchResult[] = [];
  const isBookHref = (href: string) => !/\/(?:fenlei|genre|sort|category|class|blist|rank|top|search|tag|user|login)(?:\/|\.|\?)/i.test(href)
    && !/\/list\d+\/\d+(?:\/|$)/i.test(href)
    && /(?:\/\d+[_/]\d*\/?$|\/(?:book|novel|info|shu|b)\/|\/onebook\.php\?novelid=|\/wiki\/|\/ebooks\/|\/\d+\/$)/i.test(href);
  $('.grid tr,table tr,.search-list li,.result-list li,.search-result-list li,.search-result-item,.search-tab li,.bookbox,.book-item,.newbox li,.book-img-text li,.bookinfo,.book,.book-li,.novel-item,.result-item').each((_, row) => {
    if (results.length >= 100) return false;
    const links = $(row).find('a[href]').toArray();
    const bookLink = links.find((link) => {
      const href = $(link).attr('href') ?? '';
      const label = tidy($(link).text());
      return label.length >= 2 && !chapterTitlePattern.test(label) && !/最新章节|立即阅读|详情/.test(label)
        && isBookHref(href);
    });
    if (!bookLink) {
      return;
    }
    const title = tidy($(bookLink).text());
    const url = resolveUrl($(bookLink).attr('href'), baseUrl);
    if (!title || !url) {
      return;
    }
    const cells = $(row).find('td').toArray().map((cell) => tidy($(cell).text()));
    const latestChapter = links.map((link) => tidy($(link).text())).find((label) => chapterTitlePattern.test(label));
    results.push({
      title,
      url,
      provider,
      latestChapter,
      author: cleanAuthor(cells[2]) || cleanAuthor($(row).find('.author').first().text())
    });
  });
  if (results.length === 0) {
    $('a[href]').each((_, anchor) => {
      if (results.length >= 100) return false;
      const href = $(anchor).attr('href') ?? '';
      const title = tidy($(anchor).attr('title') ?? '') || tidy($(anchor).text());
      const url = resolveUrl(href, baseUrl);
      if (title.length >= 2 && url && isBookHref(href) && !chapterTitlePattern.test(title)
        && !/首页|书库|排行|分类|详情|立即阅读|最新章节/.test(title)) {
        results.push({ title, url, provider });
      }
    });
  }
  return dedupeSearch(results);
}

export function parseSearchHtml(html: string, baseUrl: string, provider: string): SearchResult[] {
  assertReadablePage(html);
  const $ = cheerio.load(html);
  // Some exact-title searches return the book detail/catalog directly.
  if ($('meta[property="og:novel:book_name"],meta[name="og:novel:book_name"]').length
    || ($('#info h1,.book-info h1').length && $('#list,.chapter-list,.section-list').length)) {
    try {
      const catalog = parseCatalogHtml(html, baseUrl);
      if (catalog.chapters.length >= 2) return [{ title: catalog.title, author: catalog.author, url: baseUrl,
        provider, chapterCount: catalog.chapters.length, catalogStatus: 'verified' }];
    } catch { /* Fall through to search rows. */ }
  }
  return parseSearchRows($, baseUrl, provider);
}

export function searchNextPageUrl(html: string, currentUrl: string, selector?: string): string | undefined {
  const $ = cheerio.load(html);
  const link = selector ? $(selector).first() : $('a[href]').filter((_, node) =>
    /^(?:下一页|下页|下一頁|next)(?:[\s>›»→]*)$/i.test(tidy($(node).text())) || $(node).attr('rel') === 'next').first();
  const url = resolveUrl(link.attr('href'), currentUrl);
  if (!url || url === currentUrl || new URL(url).origin !== new URL(currentUrl).origin) return undefined;
  return url;
}

const searchPages = new Map<string, Map<number, string>>();

export function parseMediaWikiSearch(json: string, provider: BuiltInSearchProvider): SearchResult[] {
  const data = JSON.parse(json) as { query?: { search?: Array<{ title?: string; snippet?: string }> } };
  return (data.query?.search ?? []).slice(0, 100).flatMap((item) => {
    if (!item.title) return [];
    return [{
      title: item.title,
      url: `https://zh.wikisource.org/wiki/${encodeURIComponent(item.title.replaceAll(' ', '_'))}`,
      provider: provider.name,
      latestChapter: item.snippet?.replace(/<[^>]+>/g, '').trim()
    }];
  });
}

export function parseZonghengSearch(json: string, provider: BuiltInSearchProvider): SearchResult[] {
  type Item = { bookId?: number; name?: string; authorName?: string; chapterName?: string };
  const data = JSON.parse(json) as { data?: { datas?: { list?: Item[] } } };
  return (data.data?.datas?.list ?? []).slice(0, 100).flatMap((item) => {
    if (!item.bookId || !item.name) return [];
    return [{
      title: item.name.replace(/<[^>]+>/g, ''),
      author: item.authorName,
      latestChapter: item.chapterName,
      url: `https://book.zongheng.com/book/${item.bookId}.html`,
      provider: provider.name
    }];
  });
}

function dedupeSearch(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.url)) {
      return false;
    }
    seen.add(result.url);
    return true;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function browserFallback<T>(
  url: string,
  options: FetchOptions,
  staticAttempt: () => Promise<T>,
  renderedAttempt: (html: string) => Promise<T> | T
): Promise<T> {
  const preferenceKey = new URL(url).origin;
  if (options.browserRendering !== false && browserIsPreferred(url)) {
    try {
      const html = await renderHtmlWithBrowser(url, options);
      return await renderedAttempt(html);
    } catch (error) {
      browserPreferredUntil.delete(preferenceKey);
      if (error instanceof BrowserVerificationRequiredError || error instanceof BrowserAutomationBlockedError || error instanceof RestrictedChapterError || error instanceof RateLimitedError) throw error;
      // Retry through the ordinary request path in case the site's behavior changed.
    }
  }
  let staticError: unknown;
  try {
    const result = await staticAttempt();
    browserPreferredUntil.delete(preferenceKey);
    return result;
  } catch (error) {
    if (error instanceof RestrictedChapterError || error instanceof RateLimitedError) throw error;
    staticError = error;
  }
  if (options.browserRendering === false) throw staticError;
  try {
    const html = await renderHtmlWithBrowser(url, options);
    const result = await renderedAttempt(html);
    browserPreferredUntil.set(preferenceKey, Date.now() + browserPreferenceLifetimeMs);
    return result;
  } catch (error) {
    if (error instanceof BrowserVerificationRequiredError || error instanceof BrowserAutomationBlockedError || error instanceof RestrictedChapterError || error instanceof RateLimitedError) throw error;
    throw new Error(`普通抓取失败：${errorMessage(staticError)}；浏览器渲染也失败：${errorMessage(error)}`);
  }
}

async function loadCatalogPage(url: string, options: FetchOptions, source?: NovelSource): Promise<{ html: string; catalog: ParsedCatalog }> {
  let effectiveUrl = url;
  const parse = (html: string) => {
    const catalog = parseCatalogHtml(html, effectiveUrl, source);
    if (catalog.chapters.length === 0) throw new Error('未识别到有效目录，页面可能需要浏览器渲染或目录规则尚未适配。');
    return { html, catalog };
  };
  const limited = { ...options, maxBytes: Math.min(options.maxBytes ?? 2_000_000, 2_000_000),
    onFinalUrl: (value: string) => { effectiveUrl = value; options.onFinalUrl?.(value); },
    ...(source ? { allowsUrl: (value: string) => sourceAllowsUrl(source, value) } : {}) };
  return browserFallback(url, limited, async () => parse(await fetchHtml(url, limited)), parse);
}

export async function loadCatalogPreview(url: string, options: FetchOptions, source?: NovelSource): Promise<ParsedCatalog> {
  if (source) requireSourceUrl(source, url);
  return (await loadCatalogPage(url, options, source)).catalog;
}

export function chapterPageState(html: string, url: string, source?: NovelSource): { current?: number; total?: number; nextPageUrl?: string } {
  if (source) return {};
  const profile = profileForUrl(url);
  const $ = cheerio.load(html);
  const markerText = `${$('title').text()} ${$('h1').first().text()} ${$('body').text().slice(0, 20_000)}`;
  const marker = markerText.match(/第\s*(\d+)\s*\/\s*(\d+)\s*[页頁]/i);
  const current = marker?.[1] ? Number(marker[1]) : undefined;
  const total = marker?.[2] ? Number(marker[2]) : undefined;
  let nextPageUrl: string | undefined;
  $('a[href]').each((_, anchor) => {
    const label = tidy($(anchor).text()) || tidy($(anchor).attr('title') ?? '');
    if (!/^(?:下一页|下页|下一頁)(?:[>›»→]*)$/i.test(label)) return;
    nextPageUrl = resolveUrl($(anchor).attr('href'), url);
    return false;
  });
  if (!nextPageUrl && current && total && current < total) {
    nextPageUrl = profile?.inferChapterPageUrl?.(new URL(url), current + 1);
  }
  if (nextPageUrl) {
    try {
      const next = new URL(nextPageUrl);
      const currentUrl = new URL(url);
      if (next.hostname !== currentUrl.hostname) nextPageUrl = undefined;
      const identity = profile ? catalogIdentity(profile, url) : undefined;
      const nextIdentity = profile ? catalogIdentity(profile, next.toString()) : undefined;
      if (identity && nextIdentity && identity !== nextIdentity) nextPageUrl = undefined;
    } catch {
      nextPageUrl = undefined;
    }
  }
  return { current, total, nextPageUrl };
}

async function loadChapterPage(
  url: string,
  options: FetchOptions,
  source?: NovelSource
): Promise<{ html: string; chapter: ChapterContent; page: ReturnType<typeof chapterPageState> }> {
  let effectiveUrl = url;
  const parse = (html: string) => parseLoadedChapterPage(html, effectiveUrl, { ...options, onFinalUrl: undefined }, source);
  const limited = { ...options, maxBytes: Math.min(options.maxBytes ?? 2_000_000, 2_000_000),
    onFinalUrl: (value: string) => { effectiveUrl = value; options.onFinalUrl?.(value); },
    ...(source ? { allowsUrl: (value: string) => sourceAllowsUrl(source, value) } : {}) };
  return browserFallback(url, limited, async () => parse(await fetchHtml(url, { ...limited, referer: url })), parse);
}

async function parseLoadedChapterPage(
  html: string,
  url: string,
  options: FetchOptions,
  source?: NovelSource
): Promise<{ html: string; chapter: ChapterContent; page: ReturnType<typeof chapterPageState> }> {
  const styled = await includeSiteStyles(html, url, options);
  return { html: styled, chapter: parseChapterHtml(styled, url, source), page: chapterPageState(styled, url, source) };
}

export async function searchBooks(
  keyword: string,
  customProviders: SearchProviderConfig[],
  options: FetchOptions,
  providerFilter?: string[]
): Promise<{ results: SearchResult[]; errors: string[] }> {
  const nativeKeyword = siteSearchQuery(keyword);
  let providers: BuiltInSearchProvider[] = [
    ...filterSearchProviders(builtInSearchProviders, providerFilter),
    ...customProviders.map((provider) => ({ ...provider, kind: 'html' as const }))
  ];
  const errors: string[] = [];
  let verificationError: BrowserVerificationRequiredError | undefined;
  providers = providers.slice(0, 50);
  const results: SearchResult[] = [];
  for (let offset = 0; offset < providers.length; offset += 5) {
    if (options.shouldContinue?.() === false) break;
    const batch = await Promise.all(providers.slice(offset, offset + 5).map(async (provider) => {
      const page = Math.min(Math.max(options.searchPage ?? 1, 1), 5);
      const cacheKey = `${provider.url}:${keyword}`;
      let url = provider.url.replaceAll('{keyword}', encodeURIComponent(nativeKeyword)).replaceAll('{page}', String(page));
      if (page > 1 && !provider.url.includes('{page}') && provider.kind !== 'zongheng') {
        const discovered = searchPages.get(cacheKey)?.get(page);
        if (!discovered) return [];
        url = discovered;
      }
      if (provider.kind === 'zongheng') { const parsed = new URL(url); parsed.searchParams.set('pageNo', String(page)); url = parsed.toString(); }
      try {
        let effectiveUrl = url;
        const htmlOptions = { ...options, maxBytes: Math.min(options.maxBytes ?? 2_000_000, 2_000_000),
          method: provider.method, charset: provider.charset,
          form: provider.form ? Object.fromEntries(Object.entries(provider.form).map(([key, value]) =>
            [key, value.replaceAll('{keyword}', nativeKeyword).replaceAll('{page}', String(page))])) : undefined,
          onFinalUrl: (value: string) => { effectiveUrl = value; } };
        let parsedResults: SearchResult[] = [];
        const parse = (value: string) => {
          parsedResults = parseSearchHtml(value, effectiveUrl, provider.name);
          const $ = cheerio.load(value);
          const visibleText = $('body').text();
          if (!parsedResults.length && !/没有找到|未找到|暂无|没有搜索到|无搜索结果|未搜索到/.test(visibleText)) {
            throw new Error('搜索页没有匹配结果结构，可能需要浏览器渲染。');
          }
          return value;
        };
        const html = provider.kind === 'html'
          ? await browserFallback(url, { ...htmlOptions, browserRendering: provider.method === 'POST' ? false : options.browserRendering }, async () => {
            const value = await fetchHtml(url, htmlOptions);
            return parse(value);
          }, parse)
          : await fetchHtml(url, htmlOptions);
        if (provider.kind === 'mediawiki') parsedResults = parseMediaWikiSearch(html, provider);
        if (provider.kind === 'zongheng') parsedResults = parseZonghengSearch(html, provider);
        parsedResults = relevantSearchResults(parsedResults, keyword);
        const next = provider.kind === 'html' ? searchNextPageUrl(html, effectiveUrl) : undefined;
        if (next) {
          if (searchPages.size >= 100) searchPages.delete(searchPages.keys().next().value!);
          const pages = searchPages.get(cacheKey) ?? new Map<number, string>();
          pages.set(page + 1, next); searchPages.set(cacheKey, pages);
        }
        options.onSearchBatch?.(parsedResults, provider.name, undefined, page < 5 && Boolean(next ||
          ((provider.url.includes('{page}') || provider.kind === 'zongheng') && parsedResults.length > 0)));
        return parsedResults;
      } catch (error) {
        if (error instanceof BrowserVerificationRequiredError) verificationError ??= error;
        errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
        options.onSearchBatch?.([], provider.name, errorMessage(error));
        return [];
      }
    }));
    results.push(...batch.flat());
  }
  if (results.length === 0 && providers.length === 1 && verificationError) throw verificationError;
  return { results: dedupeSearch(results), errors };
}

export async function loadCatalog(url: string, options: FetchOptions, source?: NovelSource): Promise<ParsedCatalog> {
  if (source) requireSourceUrl(source, url);
  const first = await loadCatalogPage(url, options, source);
  if (source) return first.catalog;
  const profile = profileForUrl(url);
  if (!profile || (!profile.catalogPageSelectors?.length && !profile.catalogPageUrlPattern)) return first.catalog;

  const chapters = [...first.catalog.chapters];
  const queue = catalogPageUrls(first.html, url);
  const visited = new Set<string>([new URL(url).toString()]);
  const maxPages = Math.min(Math.max(profile.maxCatalogPages ?? 20, 1), 100);
  const appendPage = (html: string, pageUrl: string) => {
    const pageCatalog = parseCatalogHtml(html, pageUrl);
    if (pageCatalog.chapters.length === 0) throw new Error(`目录分页未识别到章节：${pageUrl}`);
    chapters.push(...pageCatalog.chapters);
    for (const discovered of catalogPageUrls(html, pageUrl)) {
      if (!visited.has(discovered) && !queue.includes(discovered)) queue.push(discovered);
    }
  };

  if ((profile.id === 'qidiy' || profile.id === 'kudushu') && queue.length > 0) {
    let cursor = 0;
    let loadedPages = 1;
    while (cursor < queue.length && visited.size < maxPages && chapters.length < 20_000) {
      const batch: string[] = [];
      while (cursor < queue.length && batch.length < 5 && visited.size < maxPages) {
        const pageUrl = queue[cursor];
        cursor += 1;
        if (!pageUrl || visited.has(pageUrl)) continue;
        visited.add(pageUrl);
        batch.push(pageUrl);
      }
      if (batch.length === 0) continue;
      const totalPages = Math.min(Math.max(queue.length + 1, loadedPages + batch.length), maxPages);
      options.onProgress?.(`正在读取目录分页 ${loadedPages + 1}-${loadedPages + batch.length} / ${totalPages}`);
      if (profile.catalogDelayMs) await new Promise((resolve) => setTimeout(resolve, profile.catalogDelayMs));
      try {
        const limited = { ...options, maxBytes: Math.min(options.maxBytes ?? 2_000_000, 2_000_000) };
        let rendered: Map<string, string>;
        if (profile.id !== 'qidiy' && !browserIsPreferred(url)) {
          try {
            const pages = await Promise.all(batch.map(async (pageUrl) => {
              const html = await fetchHtml(pageUrl, limited);
              assertReadablePage(html);
              return [new URL(pageUrl).toString(), html] as const;
            }));
            rendered = new Map(pages);
          } catch (error) {
            if (options.browserRendering === false) throw error;
            rendered = await renderHtmlBatchWithBrowser(batch, limited);
            browserPreferredUntil.set(new URL(url).origin, Date.now() + browserPreferenceLifetimeMs);
          }
        } else {
          rendered = await renderHtmlBatchWithBrowser(batch, limited);
          browserPreferredUntil.set(new URL(url).origin, Date.now() + browserPreferenceLifetimeMs);
        }
        for (const pageUrl of batch) {
          const html = rendered.get(new URL(pageUrl).toString());
          if (!html) throw new Error(`普通浏览器没有返回目录分页：${pageUrl}`);
          appendPage(html, pageUrl);
        }
      } catch (error) {
        if (error instanceof BrowserVerificationRequiredError || error instanceof BrowserAutomationBlockedError) throw error;
        if (options.browserRendering === false) throw error;
        for (const pageUrl of batch) {
          const page = await loadCatalogPage(pageUrl, options);
          appendPage(page.html, pageUrl);
        }
      }
      loadedPages += batch.length;
    }
    return {
      title: first.catalog.title,
      author: first.catalog.author,
      chapters: normalizeCatalogOrder(dedupeChapters(chapters).slice(0, 20_000), profile)
    };
  }

  for (let index = 0; index < queue.length && visited.size < maxPages; index += 1) {
    const pageUrl = queue[index];
    if (!pageUrl || visited.has(pageUrl)) continue;
    visited.add(pageUrl);
    options.onProgress?.(`正在读取目录分页 ${Math.min(index + 2, maxPages)} / ${Math.min(Math.max(queue.length + 1, index + 2), maxPages)}`);
    if (profile.catalogDelayMs) await new Promise((resolve) => setTimeout(resolve, profile.catalogDelayMs));
    const page = await loadCatalogPage(pageUrl, options);
    appendPage(page.html, pageUrl);
    if (chapters.length >= 20_000) break;
  }
  return {
    title: first.catalog.title,
    author: first.catalog.author,
    chapters: normalizeCatalogOrder(dedupeChapters(chapters).slice(0, 20_000), profile)
  };
}

async function includeSiteStyles(html: string, url: string, options: FetchOptions): Promise<string> {
  if (profileForUrl(url)?.id !== 'mayiwsk') return html;
  const $ = cheerio.load(html);
  const stylesheetUrls = $('link[rel~="stylesheet"][href]').toArray().flatMap((link) => {
    const resolved = resolveUrl($(link).attr('href'), url);
    if (!resolved) return [];
    try {
      return new URL(resolved).hostname === new URL(url).hostname ? [resolved] : [];
    } catch {
      return [];
    }
  }).slice(0, 4);
  if (stylesheetUrls.length === 0) return html;
  const settled = await Promise.allSettled(stylesheetUrls.map((stylesheetUrl) =>
    fetchHtml(stylesheetUrl, { ...options, referer: url, maxBytes: 500_000 })
  ));
  const css = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value.slice(0, 500_000)] : []).join('\n');
  if (!css) return html;
  const styleTag = `<style data-code-novel-site-styles>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${styleTag}</head>`) : `${styleTag}${html}`;
}

async function loadChapterPageBatch(
  urls: string[],
  options: FetchOptions
): Promise<Array<{ html: string; chapter: ChapterContent; page: ReturnType<typeof chapterPageState> }>> {
  const limited = { ...options, maxBytes: Math.min(options.maxBytes ?? 2_000_000, 2_000_000) };
  if (!browserIsPreferred(urls[0] ?? 'https://invalid.invalid')) {
    try {
      return await Promise.all(urls.map(async (pageUrl) => {
        let effectiveUrl = pageUrl;
        const html = await fetchHtml(pageUrl, { ...limited, referer: pageUrl,
          onFinalUrl: (value) => { effectiveUrl = value; options.onFinalUrl?.(value); } });
        return parseLoadedChapterPage(html, effectiveUrl, { ...limited, onFinalUrl: undefined });
      }));
    } catch (error) {
      if (error instanceof RestrictedChapterError || error instanceof RateLimitedError) throw error;
      if (options.browserRendering === false) throw error;
    }
  }
  try {
    const rendered = await renderHtmlBatchWithBrowser(urls, limited);
    browserPreferredUntil.set(new URL(urls[0]!).origin, Date.now() + browserPreferenceLifetimeMs);
    return await Promise.all(urls.map((pageUrl) => {
      const html = rendered.get(new URL(pageUrl).toString());
      if (!html) throw new Error(`普通浏览器没有返回正文分页：${pageUrl}`);
      return parseLoadedChapterPage(html, pageUrl, limited);
    }));
  } catch (error) {
    if (error instanceof BrowserVerificationRequiredError || error instanceof BrowserAutomationBlockedError || error instanceof RestrictedChapterError || error instanceof RateLimitedError) throw error;
    const pages = [];
    for (const pageUrl of urls) pages.push(await loadChapterPage(pageUrl, options));
    return pages;
  }
}

export async function loadChapter(url: string, options: FetchOptions, source?: NovelSource): Promise<ChapterContent> {
  if (source) requireSourceUrl(source, url);
  const first = await loadChapterPage(url, options, source);
  if (source || !first.page.nextPageUrl) return first.chapter;

  const contents = [first.chapter.content];
  const visited = new Set<string>([new URL(url).toString()]);
  const profile = profileForUrl(url);

  if ((profile?.id === 'qidiy' || profile?.id === 'kudushu')
    && profile.inferChapterPageUrl && first.page.current && first.page.total
    && first.page.current < first.page.total && first.page.total <= 20) {
    const inferred: string[] = [];
    const inferredSeen = new Set(visited);
    for (let pageNumber = first.page.current + 1; pageNumber <= first.page.total; pageNumber += 1) {
      const pageUrl = profile.inferChapterPageUrl(new URL(url), pageNumber);
      if (!pageUrl || inferredSeen.has(pageUrl) || new URL(pageUrl).hostname !== new URL(url).hostname) {
        inferred.length = 0;
        break;
      }
      inferredSeen.add(pageUrl);
      inferred.push(pageUrl);
    }
    if (inferred.length > 0) {
      const pages = [];
      for (let offset = 0; offset < inferred.length; offset += 5) {
        const batch = inferred.slice(offset, offset + 5);
        const firstNumber = first.page.current + offset + 1;
        options.onProgress?.(`正在读取正文分页 ${firstNumber}-${firstNumber + batch.length - 1} / ${first.page.total}`);
        pages.push(...await loadChapterPageBatch(batch, options));
      }
      const current = pages.at(-1)!;
      if (current.page.current && current.page.total && current.page.current < current.page.total) {
        throw new Error(`章节分页不完整：只读取到第 ${current.page.current}/${current.page.total} 页。`);
      }
      return {
        ...first.chapter,
        content: [first.chapter.content, ...pages.map((page) => page.chapter.content)].join('\n\n'),
        nextUrl: current.chapter.nextUrl,
        catalogUrl: first.chapter.catalogUrl ?? current.chapter.catalogUrl
      };
    }
  }

  let current = first;
  for (let pageCount = 1; pageCount < 20 && current.page.nextPageUrl; pageCount += 1) {
    const pageUrl = current.page.nextPageUrl;
    if (visited.has(pageUrl)) throw new Error('章节分页形成了循环，已停止读取。');
    visited.add(pageUrl);
    options.onProgress?.(`正在读取正文分页 ${pageCount + 1}${current.page.total ? ` / ${current.page.total}` : ''}`);
    const next = await loadChapterPage(pageUrl, options);
    if (!first.page.total && next.chapter.title !== first.chapter.title) {
      // Some sites call chapter navigation "下一页". Do not merge a different
      // chapter into this one or keep following it until the pagination cap.
      return { ...first.chapter, content: contents.join('\n\n'), nextUrl: pageUrl,
        catalogUrl: first.chapter.catalogUrl ?? current.chapter.catalogUrl };
    }
    current = next;
    contents.push(current.chapter.content);
  }
  if (current.page.nextPageUrl) throw new Error('单章超过 20 个网页分页，已停止读取。');
  if (current.page.current && current.page.total && current.page.current < current.page.total) {
    throw new Error(`章节分页不完整：只读取到第 ${current.page.current}/${current.page.total} 页。`);
  }
  return {
    ...first.chapter,
    content: contents.join('\n\n'),
    nextUrl: current.chapter.nextUrl,
    catalogUrl: first.chapter.catalogUrl ?? current.chapter.catalogUrl
  };
}

export function likelyCatalogUrl(chapterUrl: string): string | undefined {
  try {
    const url = new URL(chapterUrl);
    const profileUrl = profileForUrl(chapterUrl)?.inferCatalogUrl?.(url);
    if (profileUrl) return profileUrl;
    if (/\.s?html?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/[^/]+\.s?html?$/i, '');
      url.search = '';
      url.hash = '';
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}
