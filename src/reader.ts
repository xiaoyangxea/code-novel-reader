import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadChapter } from './adapters';
import { maxLocalBookBytes, parseEpub, ParsedLocalBook, parsePlainText } from './local';
import { Book, ChapterContent, ReadingProgress } from './model';
import { BookRepository, SourceRepository } from './repository';
import { pageNavigationState, paginate, renderBoss, renderReader } from './renderer';

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
  private revealRevision = 0;

  constructor(
    private readonly repository: BookRepository,
    private readonly provider: ReaderDocumentProvider,
    private readonly sources: SourceRepository
  ) {}

  private config() {
    const config = vscode.workspace.getConfiguration('codeNovel');
    return {
      pageCharacters: config.get<number>('pageCharacters', 1400),
      commentWidth: config.get<number>('commentWidth', 72),
      timeoutMs: config.get<number>('requestTimeout', 15000),
      userAgent: config.get<string>('userAgent', 'Mozilla/5.0'),
      proxy: config.get<string>('proxy') || vscode.workspace.getConfiguration('http').get<string>('proxy') || undefined
    };
  }

  private async parseLocal(book: Book): Promise<ParsedLocalBook> {
    const cached = this.localCache.get(book.id);
    if (cached) {
      return cached;
    }
    const uri = vscode.Uri.file(book.source);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > maxLocalBookBytes) throw new Error('本地小说文件超过 64 MB，已拒绝读取。');
    const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
    const parsed = book.kind === 'epub'
      ? await parseEpub(bytes, book.source)
      : parsePlainText(bytes, book.source);
    this.localCache.set(book.id, parsed);
    if (book.title !== parsed.title || book.chapters.length !== parsed.chapters.length) {
      book.title = parsed.title;
      book.chapters = parsed.chapters;
      await this.repository.saveBook(book);
    }
    return parsed;
  }

  private async getChapter(book: Book, index: number, force = false): Promise<ChapterContent> {
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
    if (!force) {
      const cached = await this.repository.readCachedChapter(book.id, reference.url);
      if (cached) {
        return cached;
      }
    }
    const chapter = await loadChapter(reference.url, this.config(), this.sources.getSource(book.sourceId));
    await this.repository.cacheChapter(book.id, chapter);
    return chapter;
  }

  private async synchronizeNavigation(): Promise<void> {
    if (!this.activeBook || !this.chapter || this.activeBook.kind !== 'online') {
      return;
    }
    const index = this.progress.chapterIndex;
    const current = this.activeBook.chapters[index];
    if (current && current.title !== this.chapter.title) {
      current.title = this.chapter.title;
    }
    if (this.chapter.nextUrl && index === this.activeBook.chapters.length - 1
      && !this.activeBook.chapters.some((item) => item.url === this.chapter?.nextUrl)) {
      this.activeBook.chapters.push({ title: '下一章（待加载）', url: this.chapter.nextUrl });
    }
    await this.repository.saveBook(this.activeBook);
  }

  async openBook(book: Book): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `正在打开《${book.title}》...` },
      async () => {
        this.activeBook = book;
        this.progress = this.repository.getProgress(book.id);
        if (book.kind !== 'online') {
          await this.parseLocal(book);
        }
        this.progress.chapterIndex = Math.min(Math.max(this.progress.chapterIndex, 0), Math.max(book.chapters.length - 1, 0));
        await this.loadCurrentChapter();
        const document = await vscode.workspace.openTextDocument(this.provider.uri);
        await vscode.languages.setTextDocumentLanguage(document, 'typescript');
        this.editor = await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('setContext', 'codeNovel.readerActive', true);
        this.bossMode = false;
        this.render();
      }
    );
  }

  private async loadCurrentChapter(force = false): Promise<void> {
    if (!this.activeBook) {
      return;
    }
    this.chapter = await this.getChapter(this.activeBook, this.progress.chapterIndex, force);
    await this.synchronizeNavigation();
    this.pages = paginate(this.chapter.content, this.config().pageCharacters);
    this.progress.pageIndex = Math.min(Math.max(this.progress.pageIndex, 0), this.pages.length - 1);
    await this.persistProgress();
  }

  private render(): void {
    this.updateNavigationContext();
    if (!this.activeBook || !this.chapter) {
      this.provider.update(renderBoss());
      return;
    }
    if (this.bossMode) {
      this.provider.update(renderBoss());
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
    void vscode.commands.executeCommand('setContext', 'codeNovel.hasPreviousPage', state.hasPreviousPage);
    void vscode.commands.executeCommand('setContext', 'codeNovel.hasNextPage', state.hasNextPage);
    void vscode.commands.executeCommand('setContext', 'codeNovel.bossMode', this.bossMode);
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
    await this.repository.saveProgress(this.activeBook.id, { ...this.progress });
  }

  async nextPage(): Promise<void> {
    if (!this.activeBook || this.bossMode) return;
    if (this.progress.pageIndex < this.pages.length - 1) {
      this.progress.pageIndex += 1;
      await this.persistProgress();
      this.render();
    } else {
      await this.nextChapter();
    }
  }

  async previousPage(): Promise<void> {
    if (!this.activeBook || this.bossMode) return;
    if (this.progress.pageIndex > 0) {
      this.progress.pageIndex -= 1;
      await this.persistProgress();
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
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: '正在加载章节...' },
        () => this.loadCurrentChapter()
      );
      if (openLastPage) {
        this.progress.pageIndex = this.pages.length - 1;
        await this.persistProgress();
      }
      this.render();
    } catch (error) {
      vscode.window.showErrorMessage(`章节加载失败：${error instanceof Error ? error.message : String(error)}`);
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
