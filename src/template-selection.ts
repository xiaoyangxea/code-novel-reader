import { createHash } from 'node:crypto';
import { readingTemplate, readingTemplates } from './reading-templates';

export type ReadingTemplateMode = 'chapter' | 'book' | 'fixed';
export const templateStateKey = 'codeNovel.readingTemplates.v1';
export const bossTemplateStateKey = 'codeNovel.bossTemplates.v1';
const maxBooks = 100;
const maxChapters = 64;
const ids = new Set(readingTemplates.map((item) => item.id));
interface ChapterChoice { key: string; id: string; }
interface BookChoices { bookTemplate?: string; chapters: ChapterChoice[]; }
export interface TemplateState {
  version: 1;
  remaining: string[];
  last?: string;
  books: [string, BookChoices][];
}

export function readingTemplateMode(value: unknown): ReadingTemplateMode {
  return value === 'book' || value === 'fixed' ? value : 'chapter';
}

function key(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** Bounded local state; selection happens only on chapter changes or commands. */
export class ReadingTemplateSelector {
  private remaining: string[] = [];
  private last?: string;
  private readonly books = new Map<string, BookChoices>();
  revision = 0;

  constructor(raw: unknown, private readonly random: () => number = Math.random) {
    if (!raw || typeof raw !== 'object') return;
    const state = raw as Partial<TemplateState>;
    if (state.version !== 1) return;
    if (Array.isArray(state.remaining)) this.remaining = [...new Set(state.remaining.filter((id) => ids.has(id)))].slice(0, ids.size);
    if (ids.has(state.last!)) this.last = state.last;
    if (!Array.isArray(state.books)) return;
    for (const entry of state.books.slice(-maxBooks)) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [bookKey, choices] = entry;
      if (typeof bookKey !== 'string' || !/^[a-f0-9]{32}$/.test(bookKey) || !choices || typeof choices !== 'object') continue;
      const chapters: ChapterChoice[] = [];
      if (Array.isArray(choices.chapters)) {
        for (const choice of choices.chapters.slice(-maxChapters)) {
          if (choice && typeof choice.key === 'string' && /^[a-f0-9]{32}$/.test(choice.key)
            && ids.has(choice.id) && !chapters.some((item) => item.key === choice.key)) chapters.push({ key: choice.key, id: choice.id });
        }
      }
      this.books.set(bookKey, { bookTemplate: ids.has(choices.bookTemplate!) ? choices.bookTemplate : undefined, chapters });
    }
  }

  private choices(bookId: string): BookChoices {
    const bookKey = key(bookId);
    let choices = this.books.get(bookKey);
    if (!choices) {
      choices = { chapters: [] };
      this.books.set(bookKey, choices);
      while (this.books.size > maxBooks) this.books.delete(this.books.keys().next().value!);
      this.revision += 1;
    } else if (this.books.keys().next().value !== undefined && [...this.books.keys()].at(-1) !== bookKey) {
      this.books.delete(bookKey);
      this.books.set(bookKey, choices);
      this.revision += 1;
    }
    return choices;
  }

  private draw(): string {
    if (!this.remaining.length) {
      this.remaining = readingTemplates.map((item) => item.id);
      for (let index = this.remaining.length - 1; index > 0; index -= 1) {
        const sample = this.random();
        const other = Math.floor((Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 0.999999999) : 0) * (index + 1));
        [this.remaining[index], this.remaining[other]] = [this.remaining[other]!, this.remaining[index]!];
      }
    }
    let index = this.remaining.length - 1;
    if (this.remaining[index] === this.last && this.remaining.length > 1) index -= 1;
    if (this.remaining[index] === this.last) {
      // An explicit choice can make the last card repeat. Start a new cycle.
      this.remaining = [];
      return this.draw();
    }
    const [selected] = this.remaining.splice(index, 1);
    this.last = selected!;
    this.revision += 1;
    return selected!;
  }

  choose(bookId: string, chapterUrl: string, mode: ReadingTemplateMode, fixedId?: string): string {
    if (mode === 'fixed') return readingTemplate(fixedId).id;
    const choices = this.choices(bookId);
    const existing = mode === 'book' ? choices.bookTemplate : choices.chapters.find((item) => item.key === key(chapterUrl))?.id;
    if (existing) {
      if (this.last !== existing) { this.last = existing; this.revision += 1; }
      return existing;
    }
    return this.change(bookId, chapterUrl, mode);
  }

  change(bookId: string, chapterUrl: string, mode: ReadingTemplateMode, requestedId?: string, previousId?: string): string {
    const choices = mode === 'fixed' ? undefined : this.choices(bookId);
    const current = mode === 'book' ? choices?.bookTemplate : choices?.chapters.find((item) => item.key === key(chapterUrl))?.id;
    if (previousId && ids.has(previousId)) this.last = previousId;
    else if (current) this.last = current;
    const selected = requestedId && ids.has(requestedId) ? requestedId : this.draw();
    this.last = selected;
    if (choices && mode === 'book') choices.bookTemplate = selected;
    if (choices && mode === 'chapter') {
      const chapterKey = key(chapterUrl);
      choices.chapters = choices.chapters.filter((item) => item.key !== chapterKey);
      choices.chapters.push({ key: chapterKey, id: selected });
      if (choices.chapters.length > maxChapters) choices.chapters.shift();
    }
    this.revision += 1;
    return selected;
  }

  forget(bookId: string): void {
    if (this.books.delete(key(bookId))) this.revision += 1;
  }

  snapshot(): TemplateState {
    return { version: 1, remaining: [...this.remaining], last: this.last,
      books: [...this.books].map(([bookKey, choices]) => [bookKey, { bookTemplate: choices.bookTemplate,
        chapters: choices.chapters.map((item) => ({ ...item })) }]) };
  }
}
