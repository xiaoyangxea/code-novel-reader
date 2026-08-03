import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { ChapterContent, ChapterRef, ParsedCatalog, SearchProviderConfig, SearchResult } from './model';
import { FetchOptions, fetchHtml, resolveUrl } from './net';
import { builtInSearchProviders, BuiltInSearchProvider, profileForUrl, SiteProfile } from './sites';

const chapterTitlePattern = /^(?:正文\s*)?(?:第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*[章回卷节篇部集]|chapter\s*\d+|序章|序言|楔子|引子|前言|后记|番外|尾声)/i;
const noisePattern = /^(?:上一章|下一章|上一页|下一页|返回目录|章节目录|手机阅读|加入书签|投推荐票|请记住|最新网址|本章未完|点击下一页|喜欢.*请收藏|天才一秒记住)/i;
const catalogNoisePattern = /^(?:分卷阅读|展开|收起|返回|目录|全部章节|加入书架|立即阅读|下载|点击查看)/i;

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

function hiddenSelectorsFromStyles($: CheerioAPI): string[] {
  const selectors: string[] = [];
  const hiddenDeclaration = /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\D|$)|font-size\s*:\s*0(?:\D|$)|text-indent\s*:\s*-\d{3,}|left\s*:\s*-\d{3,})/i;
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  $('style').each((_, style) => {
    const css = $(style).text();
    for (const match of css.matchAll(rulePattern)) {
      if (!hiddenDeclaration.test(match[2] ?? '')) continue;
      for (const selector of (match[1] ?? '').split(',').map((value) => value.trim())) {
        // Avoid feeding at-rules or pathological selectors into css-select.
        if (selector && selector.length <= 120 && !selector.startsWith('@')) selectors.push(selector);
      }
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
    '.chapter-content', '.read-content', '.content_detail', '.yd_text2',
    '.txtnav', '.article-content', '.entry-content', 'article'
  ];
  const candidates: Array<{ text: string; score: number }> = [];
  for (const selector of [...new Set(preferred)]) {
    $(selector).each((_, node) => {
      const text = textWithBreaks($, node);
      if (text.length >= 120) {
        candidates.push({ text, score: candidateScore(text, $(node).find('a').length) + 500 });
      }
    });
  }
  if (candidates.length === 0) {
    $('main,section,div').each((_, node) => {
      const text = textWithBreaks($, node);
      if (text.length >= 300) {
        candidates.push({ text, score: candidateScore(text, $(node).find('a').length) });
      }
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.text ?? '';
}

function valueFromSelector($: CheerioAPI, selector: string): string {
  const node = $(selector).first();
  return tidy(node.is('meta') ? node.attr('content') ?? '' : node.text());
}

function titleFromPage($: CheerioAPI, profile?: SiteProfile): string {
  const selectors = [
    ...(profile?.chapterTitleSelectors ?? []),
    'h1', '.bookname h1', '.chaptername', '.chapter-title', '#info h1'
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
  const matches: Array<{ url: string; rank: number }> = [];
  $('a[href]').each((_, anchor) => {
    const label = tidy($(anchor).text()) || tidy($(anchor).attr('title') ?? '');
    const rank = patterns.findIndex((pattern) => pattern.test(label));
    if (rank < 0) {
      return;
    }
    const url = resolveUrl($(anchor).attr('href'), baseUrl);
    if (url && url !== baseUrl) {
      matches.push({ url, rank });
    }
  });
  matches.sort((a, b) => a.rank - b.rank);
  return matches[0]?.url;
}

export function parseChapterHtml(html: string, url: string): ChapterContent {
  if (/cf-turnstile|cf-browser-verification|Just a moment|Checking your browser|验证码|人机验证/i.test(html)) {
    throw new Error('站点返回了人机验证页面；扩展不会绕过验证码或登录限制。');
  }
  const $ = cheerio.load(html);
  const profile = profileForUrl(url);
  const content = selectContent($, profile);
  if (content.length < 80) {
    throw new Error('未能识别正文；页面可能需要登录、使用动态脚本，或站点规则尚未适配。');
  }
  return {
    title: titleFromPage($, profile),
    content,
    url,
    previousUrl: bestLink($, url, [/^上一章$/i, /上一章节/i, /prev(?:ious)?\s*chapter/i, /上一页/i]),
    nextUrl: bestLink($, url, [/^下一章$/i, /下一章节/i, /next\s*chapter/i, /下一页/i]),
    catalogUrl: bestLink($, url, [/章节目录/i, /^目录$/i, /返回目录/i, /book\s*index/i])
  };
}

function anchorsFromContainer($: CheerioAPI, selector: string, baseUrl: string): ChapterRef[] {
  const chapters: ChapterRef[] = [];
  $(selector).find('a[href]').each((_, anchor) => {
    const title = tidy($(anchor).text());
    const url = resolveUrl($(anchor).attr('href'), baseUrl);
    if (title && url && !catalogNoisePattern.test(title) && !/\/totaltome\//i.test(url)
      && (chapterTitlePattern.test(title) || title.length >= 2)) {
      chapters.push({ title, url });
    }
  });
  return dedupeChapters(chapters);
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
  if (profile?.id !== 'mayiwsk' || chapters.length < 3) return chapters;
  const indexed = chapters.map((chapter, index) => ({ chapter, index, ordinal: chapterOrdinal(chapter.title) }));
  const numbered = indexed.filter((item) => item.ordinal !== undefined);
  if (numbered.length / chapters.length < 0.65) return chapters;

  // Mayi places a "latest chapters" block before the complete catalog. Stable
  // numeric ordering folds that prefix back into the actual chapter sequence.
  return indexed.sort((left, right) => {
    if (left.ordinal === undefined && right.ordinal === undefined) return left.index - right.index;
    if (left.ordinal === undefined) return 1;
    if (right.ordinal === undefined) return -1;
    return left.ordinal - right.ordinal || left.index - right.index;
  }).map((item) => item.chapter);
}

function inferChapterAnchors($: CheerioAPI, baseUrl: string): ChapterRef[] {
  const chapters: ChapterRef[] = [];
  $('a[href]').each((_, anchor) => {
    const title = tidy($(anchor).text());
    if (!chapterTitlePattern.test(title)) {
      return;
    }
    const url = resolveUrl($(anchor).attr('href'), baseUrl);
    if (url) {
      chapters.push({ title, url });
    }
  });
  return dedupeChapters(chapters);
}

function authorFromPage($: CheerioAPI, profile?: SiteProfile): string | undefined {
  for (const selector of profile?.authorSelectors ?? []) {
    const value = valueFromSelector($, selector).replace(/^(?:作\s*者|作者)[：:]?\s*/, '');
    if (value) return value;
  }
  const explicit = tidy($('[itemprop="author"],.author,.book-author').first().text()).replace(/^作者[：:]?\s*/, '');
  if (explicit) {
    return explicit;
  }
  for (const node of $('p').toArray()) {
    const text = tidy($(node).text());
    const match = text.match(/(?:作\s*者|作者)[：:]?\s*(.+)/);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

export function parseCatalogHtml(html: string, url: string): ParsedCatalog {
  if (/cf-turnstile|cf-browser-verification|Just a moment|Checking your browser|验证码|人机验证/i.test(html)) {
    throw new Error('站点返回了人机验证页面；扩展不会绕过验证码或登录限制。');
  }
  const $ = cheerio.load(html);
  const profile = profileForUrl(url);
  const selectors = [
    ...(profile?.catalogSelectors ?? []),
    '#list', '.listmain', '.chapter-list', '.chapterlist', '.book_list',
    '.volume-list', '.catalog', '#chapter-list', '#chapters', '.zjlist'
  ];
  let chapters: ChapterRef[] = [];
  for (const selector of selectors) {
    const current = anchorsFromContainer($, selector, url);
    if (current.length > chapters.length) {
      chapters = current;
    }
  }
  if (chapters.length < 2) {
    chapters = inferChapterAnchors($, url);
  }
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

function parseSearchRows($: CheerioAPI, baseUrl: string, provider: string): SearchResult[] {
  const results: SearchResult[] = [];
  const isBookHref = (href: string) => /(?:\/\d+[_/]\d*\/?$|\/book\/|\/novel\/|\/info\/|\/onebook\.php\?novelid=|\/wiki\/|\/ebooks\/|\/\d+\/$)/i.test(href);
  $('.grid tr,table tr,.search-list li,.result-list li,.search-result-list li,.search-result-item,.search-tab li,.bookbox,.book-item,.newbox li').each((_, row) => {
    const links = $(row).find('a[href]').toArray();
    const bookLink = links.find((link) => {
      const href = $(link).attr('href') ?? '';
      const label = tidy($(link).text());
      return label.length >= 2 && !chapterTitlePattern.test(label) && !/最新章节|立即阅读|详情/.test(label)
        && isBookHref(href);
    }) ?? links[0];
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
      author: cells[2] || tidy($(row).find('.author').first().text()) || undefined
    });
  });
  if (results.length === 0) {
    $('a[href]').each((_, anchor) => {
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
  return parseSearchRows(cheerio.load(html), baseUrl, provider);
}

export function parseMediaWikiSearch(json: string, provider: BuiltInSearchProvider): SearchResult[] {
  const data = JSON.parse(json) as { query?: { search?: Array<{ title?: string; snippet?: string }> } };
  return (data.query?.search ?? []).flatMap((item) => {
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
  return (data.data?.datas?.list ?? []).flatMap((item) => {
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

export async function searchBooks(
  keyword: string,
  customProviders: SearchProviderConfig[],
  options: FetchOptions,
  providerFilter?: string[]
): Promise<{ results: SearchResult[]; errors: string[] }> {
  let providers: BuiltInSearchProvider[] = [
    ...builtInSearchProviders,
    ...customProviders.map((provider) => ({ ...provider, kind: 'html' as const }))
  ];
  if (providerFilter?.length) {
    providers = providers.filter((provider) => providerFilter.includes(provider.name));
  }
  const errors: string[] = [];
  const batches = await Promise.all(providers.map(async (provider) => {
    const url = provider.url.replaceAll('{keyword}', encodeURIComponent(keyword));
    try {
      const html = await fetchHtml(url, options);
      if (provider.kind === 'mediawiki') return parseMediaWikiSearch(html, provider);
      if (provider.kind === 'zongheng') return parseZonghengSearch(html, provider);
      return parseSearchHtml(html, url, provider.name);
    } catch (error) {
      errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }));
  return { results: dedupeSearch(batches.flat()), errors };
}

export async function loadCatalog(url: string, options: FetchOptions): Promise<ParsedCatalog> {
  return parseCatalogHtml(await fetchHtml(url, options), url);
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
    fetchHtml(stylesheetUrl, { ...options, referer: url })
  ));
  const css = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value.slice(0, 500_000)] : []).join('\n');
  if (!css) return html;
  const styleTag = `<style data-code-novel-site-styles>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${styleTag}</head>`) : `${styleTag}${html}`;
}

export async function loadChapter(url: string, options: FetchOptions): Promise<ChapterContent> {
  const html = await fetchHtml(url, { ...options, referer: url });
  return parseChapterHtml(await includeSiteStyles(html, url, options), url);
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
