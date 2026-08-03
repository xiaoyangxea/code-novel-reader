import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { Book, BookKind, ChapterContent, ReadingProgress } from './model';

const booksKey = 'codeNovel.books.v1';
const progressKey = 'codeNovel.progress.v1';

export function stableId(kind: BookKind, source: string): string {
  return createHash('sha1').update(`${kind}:${source}`).digest('hex').slice(0, 20);
}

function cacheName(url: string): string {
  return `${createHash('sha1').update(url).digest('hex')}.json`;
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
