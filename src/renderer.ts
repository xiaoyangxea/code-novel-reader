import { Book, ChapterContent } from './model';
import { readingTemplate } from './reading-templates';

export function pageNavigationState(pageIndex: number, pageCount: number): {
  hasPreviousPage: boolean;
  hasNextPage: boolean;
} {
  return {
    hasPreviousPage: pageIndex > 0,
    hasNextPage: pageIndex < Math.max(pageCount - 1, 0)
  };
}

export function chapterPrefetchIndexes(
  currentChapterIndex: number,
  chapterCount: number,
  requestedCount: number
): number[] {
  if (!Number.isFinite(currentChapterIndex) || !Number.isFinite(chapterCount) || !Number.isFinite(requestedCount)) return [];
  const count = Math.min(Math.max(Math.floor(requestedCount), 0), 10);
  const start = Math.max(Math.floor(currentChapterIndex) + 1, 0);
  const end = Math.min(Math.max(Math.floor(chapterCount), 0), start + count);
  return Array.from({ length: Math.max(end - start, 0) }, (_, offset) => start + offset);
}

export function paginate(content: string, targetCharacters: number): string[] {
  const paragraphs = content.replace(/\r/g, '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const pages: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > targetCharacters * 1.5) {
      if (current) {
        pages.push(current.trim());
        current = '';
      }
      for (let offset = 0; offset < paragraph.length; offset += targetCharacters) {
        pages.push(paragraph.slice(offset, offset + targetCharacters));
      }
      continue;
    }
    const addition = current ? `\n\n${paragraph}` : paragraph;
    if (current && current.length + addition.length > targetCharacters) {
      pages.push(current.trim());
      current = paragraph;
    } else {
      current += addition;
    }
  }
  if (current) {
    pages.push(current.trim());
  }
  return pages.length ? pages : ['（本章没有可显示的正文）'];
}

function splitDisplayLines(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n?|\n|\u2028|\u2029/)) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let current = '';
    let visualWidth = 0;
    for (const character of paragraph) {
      const charWidth = /[\u0000-\u00ff]/.test(character) ? 1 : 2;
      if (visualWidth + charWidth > width && current) {
        lines.push(current);
        current = '';
        visualWidth = 0;
      }
      current += character;
      visualWidth += charWidth;
    }
    if (current) {
      lines.push(current);
    }
  }
  return lines;
}

function safeComment(line: string): string {
  return line
    .replace(/[\r\n\u2028\u2029]/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/gi, '')
    .replace(/\*\//g, '* /');
}

function safeCodeString(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/gi, '');
  return JSON.stringify(normalized);
}

export function renderReader(
  book: Book,
  chapter: ChapterContent,
  pageText: string,
  chapterIndex: number,
  pageIndex: number,
  pageCount: number,
  commentWidth: number,
  options: { templateId?: string; hideReadingMarkers?: boolean } = {}
): string {
  return renderReaderLayout(book, chapter, pageText, chapterIndex, pageIndex, pageCount, commentWidth, options).content;
}

export function renderReaderLayout(
  book: Book, chapter: ChapterContent, pageText: string, chapterIndex: number,
  pageIndex: number, pageCount: number, commentWidth: number,
  options: { templateId?: string; hideReadingMarkers?: boolean } = {}
): { content: string; bodyLine: number; templateId: string } {
  const template = readingTemplate(options.templateId);
  const lines = splitDisplayLines(pageText, commentWidth);
  const comments = lines.map((line) => `  // ${safeComment(line)}`).join('\n');
  const prefix = `/* eslint-disable @typescript-eslint/no-unused-vars */
const pipeline = {
  name: ${safeCodeString(options.hideReadingMarkers ? template.id : book.title)},
  stage: ${safeCodeString(options.hideReadingMarkers ? 'processing' : chapter.title)},
  revision: ${chapterIndex + 1},
  offset: ${pageIndex + 1}
} as const;

${template.prefix}

`;
  const footer = options.hideReadingMarkers ? '\nvoid pipeline;\n'
    : `\n// trace: chapter ${chapterIndex + 1}/${book.chapters.length} · page ${pageIndex + 1}/${pageCount}
// navigation: Alt+Left/Right 翻页 · Alt+Shift+Left/Right 翻章 · Ctrl+Alt+B 隐藏
void pipeline;\n`;
  return { content: prefix + comments + template.suffix + footer,
    bodyLine: prefix.split('\n').length - 1, templateId: template.id };
}

export function renderBoss(templateId?: string): string {
  const template = readingTemplate(templateId);
  // No book, chapter or page text enters this path, even when reading metadata is visible.
  return `/* eslint-disable @typescript-eslint/no-unused-vars */
const pipeline = {
  name: ${safeCodeString(template.id)},
  stage: 'validation',
  revision: 1,
  offset: 0
} as const;

${template.prefix}
${template.suffix}

void pipeline;
`;
}
