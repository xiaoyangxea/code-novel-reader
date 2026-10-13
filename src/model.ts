export type BookKind = 'online' | 'txt' | 'epub';

export interface ChapterRef {
  title: string;
  url: string;
}

export interface Book {
  id: string;
  title: string;
  author?: string;
  kind: BookKind;
  source: string;
  sourceId?: string;
  chapters: ChapterRef[];
  catalogComplete?: boolean;
  addedAt: number;
}

export interface ChapterContent {
  title: string;
  content: string;
  url: string;
  previousUrl?: string;
  nextUrl?: string;
  catalogUrl?: string;
}

export interface ReadingProgress {
  chapterIndex: number;
  pageIndex: number;
  updatedAt: number;
}

export interface SearchResult {
  title: string;
  author?: string;
  latestChapter?: string;
  summary?: string;
  kind?: 'book' | 'author-index';
  authorInferred?: boolean;
  url: string;
  provider: string;
  sourceId?: string;
  chapterCount?: number;
  catalogStatus?: 'verified' | 'unverified' | 'verification';
}

export interface SearchProviderConfig {
  name: string;
  url: string;
}

export interface ParsedCatalog {
  title: string;
  author?: string;
  chapters: ChapterRef[];
}

export interface NovelSourceSearchRule {
  url: string;
  method?: 'GET' | 'POST';
  form?: Record<string, string>;
  charset?: 'utf-8' | 'gbk' | 'gb18030';
  resultSelector: string;
  titleSelector: string;
  urlSelector: string;
  authorSelector?: string;
  latestChapterSelector?: string;
  nextPageSelector?: string;
}

export interface NovelSourceCatalogRule {
  titleSelector: string;
  chapterSelector: string;
  authorSelector?: string;
}

export interface NovelSourceChapterRule {
  titleSelector: string;
  contentSelector: string;
  previousSelector?: string;
  nextSelector?: string;
  catalogSelector?: string;
}

/** A data-only source rule. Remote scripts, request headers and credentials are intentionally unsupported. */
export interface NovelSource {
  version: 1;
  id: string;
  name: string;
  domains: string[];
  enabled: boolean;
  search?: NovelSourceSearchRule;
  catalog: NovelSourceCatalogRule;
  chapter: NovelSourceChapterRule;
  subscriptionUrl?: string;
  addedAt: number;
}
