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
  chapters: ChapterRef[];
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
  url: string;
  provider: string;
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
