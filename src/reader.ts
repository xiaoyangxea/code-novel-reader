import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChapterService } from './chapter-service';
import { maxLocalBookBytes, parseEpub, ParsedLocalBook, parsePlainText } from './local';
import { Book, ChapterContent, ReadingProgress } from './model';
import { BookRepository, SourceRepository } from './repository';
import { chapterPrefetchIndexes, pageNavigationState, paginate, renderBoss, renderReader } from './renderer';
import { normalizeSavedCatalog } from './adapters';

export class ReaderDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  private content = renderBoss();
  readonly onDidChange = this.emitter.event;
  readonly uri = vscode.Uri.parse('code-novel:/validation-pipeline.ts');

  provideTextDocumentContent(): string {
    return this.content;
  }

  update(content: string): void {
    this.content = content;
    this.emitter.fire(this.uri);
  }
}

export class ReaderController {
  private activeBook?: Book;
  private chapter?: ChapterContent;
  private progress: ReadingProgress = { chapterIndex: 0, pageIndex: 0, updatedAt: 0 };
  private pages: string[] = [];
  private bossMode = false;
  private editor?: vscode.TextEditor;
  private readonly localCache = new Map<string, ParsedLocalBook>();
  private pendingProgress?: { bookId: string; value: ReadingProgress };
  private progressSaveTimer?: ReturnType<typeof setTimeout>;
  private prefetchTimer?: ReturnType<typeof setTimeout>;
  private prefetchRevision = 0;
  private progressWrite: Promise<void> = Promise.resolve();
  private navigationContext?: { hasPreviousPage: boolean; hasNextPage: boolean; bossMode: boolean };
  private revealRevision = 0;
  private chapterRevision = 0;

  constructor(
    private readonly repository: BookRepository,
    private readonly provider: ReaderDocumentProvider,
    private readonly sources: SourceRepository,
    private readonly context: vscode.ExtensionContext,
    private readonly chapters: ChapterService,
    private readonly onError?: (error: unknown) => void | Promise<void>
  ) {}

  private rememberLocalBook(bookId: string, parsed: ParsedLocalBook): void {
    this.localCache.delete(bookId);
    this.localCache.set(bookId, parsed);
    while (this.localCache.size > 2) {
      const oldest = this.localCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.localCache.delete(oldest);
    }
  }

  private reportBackgroundError(error: unknown): void {
    if (this.onError) void Promise.resolve(this.onError(error)).catch(() => undefined);
  }

  private config(onProgress?: (message: string) => void) {
    const config = vscode.workspace.getConfiguration('codeNovel');
    const executable = config.inspect<string>('browserExecutable')?.globalValue?.trim();
    return {
      pageCharacters: config.get<number>('pageCharacters', 1400),
      commentWidth: config.get<number>('commentWidth', 72),
      timeoutMs: config.get<number>('requestTimeout', 15000),
      userAgent: config.get<string>('userAgent', 'Mozilla/5.0'),
      proxy: config.get<string>('proxy') || vscode.workspace.getConfiguration('http').get<string>('proxy') || undefined,
      browserRendering: config.get<boolean>('browserRendering', true),
      browserExecutable: executable || undefined,
      browserDataDirectory: path.join(this.context.globalStorageUri.fsPath, 'browser-profiles'),
      browserTimeoutMs: config.get<number>('browserTimeout', 25000),
      prefetchNextChapter: config.get<boolean>('prefetchNextChapter', true),
      prefetchChapterCount: config.get<number>('prefetchChapterCount', 3),
      onProgress
    };
  }

  private async parseLocal(book: Book): Promise<ParsedLocalBook> {
    const cached = this.localCache.get(book.id);
    if (cached) {
      this.rememberLocalBook(book.id, cached);
      return cached;
    }
    const uri = vscode.Uri.file(book.source);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > maxLocalBookBytes) throw new Error('本地小说文件超过 64 MB，已拒绝读取。');
    const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
    const parsed = book.kind === 'epub'
      ? await parseEpub(bytes, book.source)
      : parsePlainText(bytes, book.source);
    this.rememberLocalBook(book.id, parsed);
    if (book.title !== parsed.title || book.chapters.length !== parsed.chapters.length) {
      book.title = parsed.title;
      book.chapters = parsed.chapters;
      await this.repository.saveBook(book);
    }
    return parsed;
  }

  private async getChapter(
    book: Book,
    index: number,
    force = false,
    onProgress?: (message: string) => void
  ): Promise<ChapterContent> {
    const reference = book.chapters[index];
    if (!reference) {
      throw new Error('章节不存在。');
    }
    if (book.kind !== 'online') {
      const parsed = await this.parseLocal(book);
      const chapter = parsed.contents[index];
      if (!chapter) {
        throw new Error('无法读取本地章节。');
      }
      return chapter;
    }
    return this.chapters.get(book, index, 0, force, onProgress);
  }

  private scheduleChapterPrefetch(): void {
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    const revision = ++this.prefetchRevision;
    const book = this.activeBook;
    const config = this.config();
    if (!book || book.kind !== 'online' || !config.prefetchNextChapter) return;
    const indexes = chapterPrefetchIndexes(this.progress.chapterIndex, book.chapters.length, config.prefetchChapterCount);
    if (indexes.length === 0) return;
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = undefined;
      if (revision !== this.prefetchRevision || this.activeBook?.id !== book.id) return;
      void this.prefetchChapters(book, indexes, revision);
    }, 200);
  }

  private async prefetchChapters(book: Book, indexes: number[], revision: number): Promise<void> {
    for (const index of indexes) {
      if (revision !== this.prefetchRevision || this.activeBook?.id !== book.id) return;
      try {
        await this.chapters.get(book, index, 10, false, undefined,
          () => revision === this.prefetchRevision && this.activeBook?.id === book.id);
      } catch {
        // Stop this window after a failure. Explicit navigation will retry and report it.
        return;
      }
    }
  }

  private async synchronizeNavigation(): Promise<void> {
    if (!this.activeBook || !this.chapter || this.activeBook.kind !== 'online') {
      return;
    }
    const index = this.progress.chapterIndex;
    const current = this.activeBook.chapters[index];
    let changed = false;
    if (current && current.title !== this.chapter.title) {
      current.title = this.chapter.title;
      changed = true;
    }
    if (this.chapter.nextUrl && index === this.activeBook.chapters.length - 1
      && !this.activeBook.chapters.some((item) => item.url === this.chapter?.nextUrl)) {
      this.activeBook.chapters.push({ title: '下一章（待加载）', url: this.chapter.nextUrl });
      changed = true;
    }
    if (changed) await this.repository.saveBook(this.activeBook);
  }

  async openBook(book: Book, parsedLocal?: ParsedLocalBook): Promise<void> {
    this.chapters.allowBook(book.id);
    await this.flushProgress();
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    this.prefetchRevision += 1;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `正在打开《${book.title}》...` },
      async (progress) => {
        const originalBook = book;
        const saved = { ...this.repository.getProgress(book.id) };
        const currentUrl = book.chapters[saved.chapterIndex]?.url;
        book = normalizeSavedCatalog(book);
        if (book !== originalBook && saved.updatedAt > 0 && currentUrl) {
          const migrated = book.chapters.findIndex((chapter) => chapter.url === currentUrl);
          if (migrated >= 0) saved.chapterIndex = migrated;
        }
        this.activeBook = book;
        this.bossMode = false;
        if (parsedLocal && book.kind !== 'online') this.rememberLocalBook(book.id, parsedLocal);
        this.progress = saved;
        if (book !== originalBook) {
          await this.repository.saveBook(book);
          if (this.activeBook !== book) return;
          await this.repository.saveProgress(book.id, saved);
          if (this.activeBook !== book) return;
        }
        if (book.kind !== 'online') {
          await this.parseLocal(book);
        }
        this.progress.chapterIndex = Math.min(Math.max(this.progress.chapterIndex, 0), Math.max(book.chapters.length - 1, 0));
        if (!await this.loadCurrentChapter(false, (message) => progress.report({ message }))) return;
        const document = await vscode.workspace.openTextDocument(this.provider.uri);
        await vscode.languages.setTextDocumentLanguage(document, 'typescript');
        this.editor = await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('setContext', 'codeNovel.readerActive', true);
        this.render();
      }
    );
  }

  private async loadCurrentChapter(force = false, onProgress?: (message: string) => void): Promise<boolean> {
    if (!this.activeBook) {
      return false;
    }
    const book = this.activeBook;
    const index = this.progress.chapterIndex;
    const revision = ++this.chapterRevision;
    const chapter = await this.getChapter(book, index, force, onProgress);
    if (this.activeBook !== book || this.progress.chapterIndex !== index || revision !== this.chapterRevision) return false;
    this.chapter = chapter;
    await this.synchronizeNavigation();
    if (this.activeBook !== book || this.progress.chapterIndex !== index || revision !== this.chapterRevision) return false;
    this.pages = paginate(this.chapter.content, this.config().pageCharacters);
    this.progress.pageIndex = Math.min(Math.max(this.progress.pageIndex, 0), this.pages.length - 1);
    await this.persistProgress();
    if (this.activeBook !== book || this.progress.chapterIndex !== index || revision !== this.chapterRevision) return false;
    this.scheduleChapterPrefetch();
    return true;
  }

  private render(): void {
    this.updateNavigationContext();
    if (!this.activeBook || !this.chapter) {
      this.provider.update(this.bossContent());
      return;
    }
    if (this.bossMode) {
      this.provider.update(this.bossContent());
      return;
    }
    const content = renderReader(
      this.activeBook,
      this.chapter,
      this.pages[this.progress.pageIndex] ?? '',
      this.progress.chapterIndex,
      this.progress.pageIndex,
      this.pages.length,
      this.config().commentWidth
    );
    this.provider.update(content);
    void this.revealReadingArea(content);
  }

  private updateNavigationContext(): void {
    const state = this.activeBook && this.chapter && !this.bossMode
      ? pageNavigationState(this.progress.pageIndex, this.pages.length)
      : { hasPreviousPage: false, hasNextPage: false };
    const next = { ...state, bossMode: this.bossMode };
    if (this.navigationContext?.hasPreviousPage !== next.hasPreviousPage) {
      void vscode.commands.executeCommand('setContext', 'codeNovel.hasPreviousPage', next.hasPreviousPage);
    }
    if (this.navigationContext?.hasNextPage !== next.hasNextPage) {
      void vscode.commands.executeCommand('setContext', 'codeNovel.hasNextPage', next.hasNextPage);
    }
    if (this.navigationContext?.bossMode !== next.bossMode) {
      void vscode.commands.executeCommand('setContext', 'codeNovel.bossMode', next.bossMode);
    }
    this.navigationContext = next;
  }

  private async revealReadingArea(expectedContent: string): Promise<void> {
    const revision = ++this.revealRevision;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (revision !== this.revealRevision || !this.editor || this.bossMode) return;
      if (this.editor.document.getText() !== expectedContent) continue;
      let bodyLine = -1;
      for (let line = 12; line < this.editor.document.lineCount; line += 1) {
        const text = this.editor.document.lineAt(line).text;
        if (text.startsWith('// trace:')) break;
        if (/^\s*\/\/ /.test(text)) {
          bodyLine = line;
          break;
        }
      }
      const line = bodyLine >= 0 ? bodyLine : Math.min(16, Math.max(this.editor.document.lineCount - 1, 0));
      const position = new vscode.Position(line, 0);
      this.editor.selection = new vscode.Selection(position, position);
      this.editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
      return;
    }
  }

  private async persistProgress(): Promise<void> {
    if (!this.activeBook) {
      return;
    }
    this.progress.updatedAt = Date.now();
    this.pendingProgress = { bookId: this.activeBook.id, value: { ...this.progress } };
    await this.flushProgress();
  }

  private scheduleProgressPersistence(): void {
    if (!this.activeBook) return;
    this.progress.updatedAt = Date.now();
    this.pendingProgress = { bookId: this.activeBook.id, value: { ...this.progress } };
    if (this.progressSaveTimer) clearTimeout(this.progressSaveTimer);
    this.progressSaveTimer = setTimeout(() => {
      this.progressSaveTimer = undefined;
      void this.flushProgress().catch((error) => this.reportBackgroundError(error));
    }, 400);
  }

  async flushProgress(): Promise<void> {
    if (this.progressSaveTimer) {
      clearTimeout(this.progressSaveTimer);
      this.progressSaveTimer = undefined;
    }
    const pending = this.pendingProgress;
    this.pendingProgress = undefined;
    if (!pending) {
      await this.progressWrite;
      return;
    }
    const operation = this.progressWrite
      .catch(() => undefined)
      .then(() => this.repository.saveProgress(pending.bookId, pending.value));
    this.progressWrite = operation.catch(() => undefined);
    await operation;
  }

  async dispose(): Promise<void> {
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = undefined;
    this.prefetchRevision += 1;
    await this.flushProgress();
  }

  async nextPage(): Promise<void> {
    if (!this.activeBook || this.bossMode) return;
    if (this.progress.pageIndex < this.pages.length - 1) {
      this.progress.pageIndex += 1;
      this.scheduleProgressPersistence();
      this.render();
    } else {
      await this.nextChapter();
    }
  }

  async previousPage(): Promise<void> {
    if (!this.activeBook || this.bossMode) return;
    if (this.progress.pageIndex > 0) {
      this.progress.pageIndex -= 1;
      this.scheduleProgressPersistence();
      this.render();
    } else if (this.progress.chapterIndex > 0) {
      await this.previousChapter(true);
    }
  }

  async nextChapter(): Promise<void> {
    if (!this.activeBook || this.bossMode) return;
    if (this.progress.chapterIndex >= this.activeBook.chapters.length - 1) {
      vscode.window.showInformationMessage('已经是最后一章。');
      return;
    }
    this.progress.chapterIndex += 1;
    this.progress.pageIndex = 0;
    await this.loadWithFeedback();
  }

  async previousChapter(openLastPage = false): Promise<void> {
    if (!this.activeBook || this.bossMode) return;
    if (this.progress.chapterIndex <= 0) {
      if (this.chapter?.previousUrl && this.activeBook.kind === 'online') {
        this.activeBook.chapters.unshift({ title: '上一章（待加载）', url: this.chapter.previousUrl });
        await this.repository.saveBook(this.activeBook);
      } else {
        vscode.window.showInformationMessage('已经是第一章。');
        return;
      }
    } else {
      this.progress.chapterIndex -= 1;
    }
    this.progress.pageIndex = 0;
    await this.loadWithFeedback(openLastPage);
  }

  private async loadWithFeedback(openLastPage = false): Promise<void> {
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    this.prefetchRevision += 1;
    try {
      const loaded = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: '正在加载章节...' },
        (progress) => this.loadCurrentChapter(false, (message) => progress.report({ message }))
      );
      if (!loaded) return;
      if (openLastPage) {
        this.progress.pageIndex = this.pages.length - 1;
        await this.persistProgress();
      }
      this.render();
    } catch (error) {
      if (this.onError) {
        await this.onError(error);
      } else {
        vscode.window.showErrorMessage(`章节加载失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async chooseChapter(): Promise<void> {
    if (!this.activeBook) return;
    const items = this.activeBook.chapters.map((chapter, index) => ({
      label: chapter.title,
      description: `第 ${index + 1} 章`,
      index
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择章节', matchOnDescription: true });
    if (!picked) return;
    this.progress.chapterIndex = picked.index;
    this.progress.pageIndex = 0;
    await this.loadWithFeedback();
  }

  async openBookAtChapter(book: Book, chapterIndex: number): Promise<void> {
    await this.flushProgress();
    await this.repository.saveProgress(book.id, {
      chapterIndex: Math.min(Math.max(chapterIndex, 0), Math.max(book.chapters.length - 1, 0)),
      pageIndex: 0,
      updatedAt: Date.now()
    });
    await this.openBook(book);
  }

  toggleBoss(): void {
    this.bossMode = !this.bossMode;
    this.render();
  }

  private bossContent(): string {
    return this.context.globalState.get<string>('codeNovel.bossContent') ?? renderBoss();
  }

  refreshBossContent(): void { if (this.bossMode || !this.activeBook) this.render(); }

  forgetBook(id: string): void {
    if (this.activeBook?.id !== id) return;
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    this.prefetchRevision += 1;
    this.chapterRevision += 1;
    this.activeBook = undefined;
    this.chapter = undefined;
    this.pendingProgress = undefined;
    this.render();
  }

  async reloadChapter(): Promise<void> {
    if (!this.activeBook || !this.chapter || this.activeBook.kind !== 'online') return;
    await this.repository.deleteCachedChapter(this.activeBook.id, this.chapter.url);
    await this.loadCurrentChapter(true);
    this.render();
  }

  getActiveBook(): Book | undefined {
    return this.activeBook;
  }
}
