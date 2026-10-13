import { loadChapter } from './adapters';
import { Book, ChapterContent, NovelSource } from './model';
import { FetchOptions } from './net';
import { isSuspectedCachedExcerpt } from './chapter-quality';

export class BackgroundTaskCancelled extends Error {}

/** One shared network queue: explicit reading precedes prefetch and downloads. */
export class ChapterService {
  private readonly pending = new Map<string, { promise: Promise<ChapterContent>; priority: number;
    watchers: Array<() => boolean> }>();
  private readonly queue: Array<{ key: string; priority: number; run: () => Promise<void> }> = [];
  private running = false;
  private readonly removed = new Set<string>();

  async cancelBook(id: string): Promise<void> {
    this.removed.add(id);
    await Promise.allSettled([...this.pending].filter(([key]) => key.startsWith(`${id}:`)).map(([, job]) => job.promise));
  }

  allowBook(id: string): void { this.removed.delete(id); }

  constructor(
    private readonly cache: {
      readCachedChapter(id: string, url: string): Promise<ChapterContent | undefined>;
      cacheChapter(id: string, chapter: ChapterContent): Promise<void>;
      getBook(id: string): Book | undefined;
    },
    private readonly options: (onProgress?: (message: string) => void) => FetchOptions,
    private readonly source: (id?: string) => NovelSource | undefined,
    private readonly loader = loadChapter
  ) {}

  async get(book: Book, index: number, priority = 0, force = false,
    onProgress?: (message: string) => void, allowed: () => boolean = () => true): Promise<ChapterContent> {
    if (!this.cache.getBook(book.id) || this.removed.has(book.id)) throw new BackgroundTaskCancelled();
    const reference = book.chapters[index];
    if (!reference) throw new Error('章节不存在。');
    if (!force) {
      const cached = await this.cache.readCachedChapter(book.id, reference.url);
      if (cached && !isSuspectedCachedExcerpt(cached)) return cached;
    }
    const key = `${book.id}:${reference.url}${force ? ':force' : ''}`;
    const existing = this.pending.get(key);
    if (existing) {
      existing.watchers.push(allowed);
      existing.priority = Math.min(existing.priority, priority);
      const queued = this.queue.find((job) => job.key === key);
      if (queued) queued.priority = existing.priority;
      try { return await existing.promise; } catch (error) {
        if (priority === 0 && error instanceof BackgroundTaskCancelled) {
          return this.get(book, index, priority, force, onProgress);
        }
        throw error;
      }
    }
    let resolve!: (chapter: ChapterContent) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ChapterContent>((yes, no) => { resolve = yes; reject = no; });
    this.pending.set(key, { promise, priority, watchers: [allowed] });
    this.queue.push({ key, priority, run: async () => {
      try {
        // A download or foreground reader can keep a cancelled prefetch alive.
        if (!this.pending.get(key)?.watchers.some((watcher) => watcher())) throw new BackgroundTaskCancelled();
        if (!this.cache.getBook(book.id) || this.removed.has(book.id)) throw new BackgroundTaskCancelled();
        const chapter = await this.loader(reference.url, this.options(onProgress), this.source(book.sourceId));
        if (this.cache.getBook(book.id) && !this.removed.has(book.id)) await this.cache.cacheChapter(book.id, chapter);
        resolve(chapter);
      } catch (error) { reject(error); }
      finally { this.pending.delete(key); }
    } });
    void this.drain();
    return promise;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        this.queue.sort((a, b) => a.priority - b.priority);
        await this.queue.shift()!.run();
      }
    } finally { this.running = false; }
  }
}
