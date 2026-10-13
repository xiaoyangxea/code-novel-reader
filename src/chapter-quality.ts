import type { ChapterContent } from './model';

export class RestrictedChapterError extends Error {
  constructor(message = '检测到试读遮罩或疑似截断正文，完整章节可能需要登录、订阅或购买；不会将可疑片段当作完整正文。') { super(message); this.name = 'RestrictedChapterError'; }
}

export function isSuspectedCachedExcerpt(chapter: ChapterContent): boolean {
  try {
    return /(?:^|\.)(?:book|reader)\.qq\.com$/i.test(new URL(chapter.url).hostname)
      && chapter.content.length < 500 && /(?:\.{3}|…)\s*$/.test(chapter.content);
  } catch { return false; }
}
