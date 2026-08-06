import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { Book, BookKind, ChapterContent, NovelSource, ReadingProgress } from './model';
import { normalizeNovelSource } from './source-rules';

const booksKey = 'codeNovel.books.v1';
const progressKey = 'codeNovel.progress.v1';
const sourcesKey = 'codeNovel.sources.v1';
const disabledBuiltInsKey = 'codeNovel.disabledBuiltIns.v1';

export function stableId(kind: BookKind, source: string): string {
  return createHash('sha1').update(`${kind}:${source}`).digest('hex').slice(0, 20);
}

function cacheName(url: string): string {
  return `${createHash('sha1').update(url).digest('hex')}.json`;
}

function assertBookId(id: string): void {
  if (!/^[a-f0-9]{20}$/.test(id)) throw new Error('书籍 ID 无效，已拒绝访问缓存路径。');
}

export class BookRepository {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  getBooks(): Book[] {
    return this.context.globalState.get<Book[]>(booksKey, []).sort((a, b) => b.addedAt - a.addedAt);
  }

  getBook(id: string): Book | undefined {
    return this.getBooks().find((book) => book.id === id);
  }

  async saveBook(book: Book): Promise<void> {
    const books = this.getBooks().filter((item) => item.id !== book.id);
    books.unshift(book);
    await this.context.globalState.update(booksKey, books);
    this.changeEmitter.fire();
  }

  async removeBook(id: string): Promise<void> {
    await this.context.globalState.update(booksKey, this.getBooks().filter((book) => book.id !== id));
    const progress = this.context.globalState.get<Record<string, ReadingProgress>>(progressKey, {});
    delete progress[id];
    await this.context.globalState.update(progressKey, progress);
    try {
      assertBookId(id);
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.context.globalStorageUri, 'chapters', id), {
        recursive: true,
        useTrash: false
      });
    } catch {
      // The book may not have downloaded any chapter cache yet.
    }
    this.changeEmitter.fire();
  }

  getProgress(bookId: string): ReadingProgress {
    return this.context.globalState.get<Record<string, ReadingProgress>>(progressKey, {})[bookId]
      ?? { chapterIndex: 0, pageIndex: 0, updatedAt: 0 };
  }

  async saveProgress(bookId: string, value: ReadingProgress): Promise<void> {
    const progress = this.context.globalState.get<Record<string, ReadingProgress>>(progressKey, {});
    progress[bookId] = value;
    await this.context.globalState.update(progressKey, progress);
    this.changeEmitter.fire();
  }

  private chapterCacheUri(bookId: string, url: string): vscode.Uri {
    assertBookId(bookId);
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'chapters', bookId, cacheName(url));
  }

  async readCachedChapter(bookId: string, url: string): Promise<ChapterContent | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.chapterCacheUri(bookId, url));
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as ChapterContent;
    } catch {
      return undefined;
    }
  }

  async cacheChapter(bookId: string, chapter: ChapterContent): Promise<void> {
    assertBookId(bookId);
    const uri = this.chapterCacheUri(bookId, chapter.url);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.context.globalStorageUri, 'chapters', bookId));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(chapter), 'utf8'));
  }

  async deleteCachedChapter(bookId: string, url: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.chapterCacheUri(bookId, url));
    } catch {
      // Cache absence is expected.
    }
  }
}

export class SourceRepository {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  getSources(): NovelSource[] {
    return this.context.globalState.get<NovelSource[]>(sourcesKey, []).flatMap((source) => {
      try {
        const normalized = normalizeNovelSource(source, source.subscriptionUrl);
        return [{
          ...normalized,
          enabled: source.enabled !== false,
          addedAt: typeof source.addedAt === 'number' ? source.addedAt : normalized.addedAt
        }];
      } catch {
        return [];
      }
    }).sort((left, right) => right.addedAt - left.addedAt);
  }

  getSource(id: string | undefined): NovelSource | undefined {
    return id ? this.getSources().find((source) => source.id === id) : undefined;
  }

  findForUrl(rawUrl: string): NovelSource | undefined {
    let hostname: string;
    try {
      hostname = new URL(rawUrl).hostname.toLowerCase();
    } catch {
      return undefined;
    }
    return this.getSources().find((source) => source.enabled && source.domains.some((domain) => {
      const normalized = domain.toLowerCase().replace(/^\*\./, '');
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    }));
  }

  async saveSource(source: NovelSource): Promise<void> {
    const current = this.getSources();
    if (!current.some((item) => item.id === source.id) && current.length >= 100) {
      throw new Error('自定义书源数量已达到 100 个，请先删除不再使用的书源。');
    }
    const sources = current.filter((item) => item.id !== source.id);
    sources.unshift(source);
    await this.context.globalState.update(sourcesKey, sources);
    this.changeEmitter.fire();
  }

  async removeSource(id: string): Promise<void> {
    await this.context.globalState.update(sourcesKey, this.getSources().filter((source) => source.id !== id));
    this.changeEmitter.fire();
  }

  getDisabledBuiltIns(): string[] {
    return this.context.globalState.get<string[]>(disabledBuiltInsKey, []);
  }

  isBuiltInEnabled(id: string): boolean {
    return !this.getDisabledBuiltIns().includes(id);
  }

  async setBuiltInEnabled(id: string, enabled: boolean): Promise<void> {
    const disabled = new Set(this.getDisabledBuiltIns());
    if (enabled) disabled.delete(id); else disabled.add(id);
    await this.context.globalState.update(disabledBuiltInsKey, [...disabled]);
    this.changeEmitter.fire();
  }
}
