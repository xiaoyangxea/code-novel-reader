import { Book, ChapterContent } from './model';

export function pageNavigationState(pageIndex: number, pageCount: number): {
  hasPreviousPage: boolean;
  hasNextPage: boolean;
} {
  return {
    hasPreviousPage: pageIndex > 0,
    hasNextPage: pageIndex < Math.max(pageCount - 1, 0)
  };
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
  for (const paragraph of text.split('\n')) {
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
  commentWidth: number
): string {
  const lines = splitDisplayLines(pageText, commentWidth);
  const comments = lines.map((line) => `  // ${safeComment(line)}`).join('\n');
  return `/* eslint-disable @typescript-eslint/no-unused-vars */
import type { Diagnostic, Range } from 'vscode';

interface ParseContext {
  readonly source: string;
  readonly revision: number;
  readonly diagnostics: Diagnostic[];
}

const pipeline = {
  name: ${safeCodeString(book.title)},
  stage: ${safeCodeString(chapter.title)},
  revision: ${chapterIndex + 1},
  offset: ${pageIndex + 1}
} as const;

export function collectDiagnostics(context: ParseContext): Diagnostic[] {
  const diagnostics = [...context.diagnostics];

${comments}

  return diagnostics;
}

// trace: chapter ${chapterIndex + 1}/${book.chapters.length} · page ${pageIndex + 1}/${pageCount}
// navigation: Alt+Left/Right 翻页 · Alt+Shift+Left/Right 翻章 · Ctrl+Alt+B 隐藏
void pipeline;
`;
}

export function renderBoss(): string {
  return `import type { CancellationToken, DiagnosticCollection, TextDocument } from 'vscode';

export interface ValidationPipeline {
  validate(document: TextDocument, token: CancellationToken): Promise<void>;
  dispose(): void;
}

export function createValidationPipeline(collection: DiagnosticCollection): ValidationPipeline {
  let revision = 0;
  return {
    async validate(document, token) {
      const currentRevision = ++revision;
      if (token.isCancellationRequested || document.isClosed) return;
      if (currentRevision !== revision) return;
      collection.set(document.uri, []);
    },
    dispose() {
      collection.clear();
      collection.dispose();
    }
  };
}
`;
}
