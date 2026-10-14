import * as path from 'node:path';
import * as vscode from 'vscode';
import { likelyCatalogUrl, loadCatalog, loadChapter } from './adapters';
import { BrowserVerificationRequiredError, closeVerificationRoutes, startVerificationBrowser } from './browser';
import { LibraryProvider, BookItem } from './library';
import { maxLocalBookBytes, parseEpub, parsePlainText } from './local';
import { Book, NovelSource, ParsedCatalog } from './model';
import { ReaderController, ReaderDocumentProvider } from './reader';
import { BookRepository, SourceRepository, stableId } from './repository';
import { manageSources } from './source-manager';
import { assertHttpUrl } from './source-rules';
import { ChapterService } from './chapter-service';
import { DownloadManager } from './download';
import { configureBoss, saveBoss } from './boss';
import { searchOnlineUI } from './search-ui';
import { detectLocalProxy, effectiveProxy } from './proxy';

let activeReaderController: ReaderController | undefined;
let activeDownloads: DownloadManager | undefined;
let detectedProxy: string | undefined;

function requestOptions(context: vscode.ExtensionContext, onProgress?: (message: string) => void) {
  const config = vscode.workspace.getConfiguration('codeNovel');
  const executable = config.inspect<string>('browserExecutable')?.globalValue?.trim();
  return {
    timeoutMs: config.get<number>('requestTimeout', 15000),
    userAgent: config.get<string>('userAgent', 'Mozilla/5.0'),
    proxy: effectiveProxy(config.get<string>('proxy') || vscode.workspace.getConfiguration('http').get<string>('proxy'))
      || (config.get<boolean>('autoDetectProxy', true) ? detectedProxy : undefined),
    browserRendering: config.get<boolean>('browserRendering', true),
    browserExecutable: executable || undefined,
    browserDataDirectory: path.join(context.globalStorageUri.fsPath, 'browser-profiles'),
    browserTimeoutMs: config.get<number>('browserTimeout', 25000),
    onProgress
  };
}

async function catalogFromUrl(
  context: vscode.ExtensionContext,
  url: string,
  source?: NovelSource,
  onProgress?: (message: string) => void
): Promise<{ catalog: ParsedCatalog; selectedIndex: number; complete: boolean }> {
  const inferredCatalogUrl = likelyCatalogUrl(url);
  for (const candidate of [...new Set([inferredCatalogUrl, url].filter((value): value is string => Boolean(value)))]) {
    try {
      const directCatalog = await loadCatalog(candidate, requestOptions(context, onProgress), source);
      if (directCatalog.chapters.length >= 2) {
        return {
          catalog: directCatalog,
          complete: true,
          selectedIndex: Math.max(0, directCatalog.chapters.findIndex((item) => item.url === url))
        };
      }
    } catch {
      // A chapter page or blocked catalog can still be handled below.
    }
  }

  const chapter = await loadChapter(url, requestOptions(context, onProgress), source);
  const candidates = [chapter.catalogUrl, inferredCatalogUrl].filter((value): value is string => Boolean(value));
  for (const candidate of [...new Set(candidates)]) {
    try {
      const catalog = await loadCatalog(candidate, requestOptions(context, onProgress), source);
      if (catalog.chapters.length >= 2) {
        const selectedIndex = Math.max(0, catalog.chapters.findIndex((item) => item.url === url));
        return { catalog, selectedIndex, complete: true };
      }
    } catch {
      // Continue with the next inferred catalog URL.
    }
  }
  const chapters = [{ title: chapter.title, url }];
  if (chapter.nextUrl) chapters.push({ title: '下一章（待加载）', url: chapter.nextUrl });
  return {
    catalog: { title: chapter.title.replace(/第.+?[章回].*$/, '').trim() || '在线小说', chapters },
    selectedIndex: 0,
    complete: false
  };
}

async function importOnlineUrl(
  context: vscode.ExtensionContext,
  repository: BookRepository,
  sources: SourceRepository,
  reader: ReaderController,
  rawUrl?: string,
  sourceId?: string
): Promise<void> {
  const input = rawUrl ?? await vscode.window.showInputBox({
    title: '导入在线小说',
    prompt: '可输入书籍目录页或任意章节 URL',
    placeHolder: 'https://example.com/book/123/'
  });
  if (!input) return;
  let url: string;
  try {
    url = assertHttpUrl(input.trim());
  } catch {
    vscode.window.showErrorMessage('URL 格式不正确。');
    return;
  }
  const imported = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '正在识别小说目录和章节...' },
    async (progress) => {
      const source = sources.getSource(sourceId) ?? sources.findForUrl(url);
      const { catalog, selectedIndex, complete } = await catalogFromUrl(context, url, source, (message) => progress.report({ message }));
      const book: Book = {
        id: stableId('online', catalog.chapters[0]?.url ? likelyCatalogUrl(catalog.chapters[0].url) ?? url : url),
        title: catalog.title,
        author: catalog.author,
        kind: 'online',
        source: url,
        sourceId: source?.id,
        chapters: catalog.chapters,
        catalogComplete: complete,
        addedAt: Date.now()
      };
      await repository.saveBook(book);
      return { book, selectedIndex };
    }
  );
  const items = imported.book.chapters.map((chapter, index) => ({
    label: chapter.title,
    description: `第 ${index + 1} / ${imported.book.chapters.length} 章`,
    index
  }));
  const preferred = items[imported.selectedIndex];
  const orderedItems = preferred
    ? [preferred, ...items.filter((item) => item.index !== preferred.index)]
    : items;
  const picked = imported.book.chapters.length > 1
    ? await vscode.window.showQuickPick(orderedItems, {
      title: `《${imported.book.title}》目录（共 ${imported.book.chapters.length} 章）`,
      placeHolder: '输入章节名或序号搜索，选择后开始阅读',
      matchOnDescription: true
    })
    : orderedItems[0];
  if (!picked) {
    vscode.window.showInformationMessage(`《${imported.book.title}》已加入书架，可稍后打开并用 Ctrl+Alt+L 选择章节。`);
    return;
  }
  await repository.saveProgress(imported.book.id, { chapterIndex: picked.index, pageIndex: 0, updatedAt: Date.now() });
  await reader.openBook(imported.book);
}

async function openCatalog(reader: ReaderController, book: Book): Promise<void> {
  const items = book.chapters.map((chapter, index) => ({
    label: chapter.title,
    description: `第 ${index + 1} / ${book.chapters.length} 章`,
    index
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `《${book.title}》目录（共 ${book.chapters.length} 章）`,
    placeHolder: '输入章节名或序号搜索',
    matchOnDescription: true
  });
  if (picked) await reader.openBookAtChapter(book, picked.index);
}

async function refreshCatalog(context: vscode.ExtensionContext, repository: BookRepository, sources: SourceRepository, book: Book): Promise<void> {
  if (book.kind !== 'online') {
    vscode.window.showInformationMessage('本地书籍目录会在打开文件时自动重新解析。');
    return;
  }
  const progress = repository.getProgress(book.id);
  const currentUrl = book.chapters[progress.chapterIndex]?.url;
  const source = sources.getSource(book.sourceId) ?? sources.findForUrl(book.source);
  const refreshed = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `正在刷新《${book.title}》目录...` },
    (progress) => catalogFromUrl(context, book.source, source, (message) => progress.report({ message }))
  );
  book.title = refreshed.catalog.title;
  book.author = refreshed.catalog.author;
  book.chapters = refreshed.catalog.chapters;
  book.catalogComplete = refreshed.complete;
  book.sourceId = source?.id;
  await repository.saveBook(book);
  const chapterIndex = currentUrl ? book.chapters.findIndex((chapter) => chapter.url === currentUrl) : -1;
  await repository.saveProgress(book.id, {
    chapterIndex: chapterIndex >= 0 ? chapterIndex : Math.min(progress.chapterIndex, Math.max(book.chapters.length - 1, 0)),
    pageIndex: chapterIndex >= 0 ? progress.pageIndex : 0,
    updatedAt: Date.now()
  });
  vscode.window.showInformationMessage(`目录已更新，共 ${book.chapters.length} 章。`);
}

async function removeFromLibrary(repository: BookRepository, item: BookItem, beforeRemove: () => Promise<void>): Promise<void> {
  const book = item.book;
  if (book.kind === 'txt' || book.kind === 'epub') {
    const sourcePath = path.resolve(book.source);
    const answer = await vscode.window.showWarningMessage(
      `从书架移除《${book.title}》？\n\n本地源文件：${sourcePath}`,
      { modal: true, detail: '“移除并删除源文件”会把 TXT/EPUB 移入系统回收站。' },
      '移除并删除源文件',
      '仅从书架移除'
    );
    if (!answer) return;
    if (answer === '移除并删除源文件') {
      const sourceUri = vscode.Uri.file(sourcePath);
      try {
        const stat = await vscode.workspace.fs.stat(sourceUri);
        if ((stat.type & vscode.FileType.Directory) !== 0) {
          throw new Error('保存的本地源指向目录，已拒绝删除。');
        }
        await vscode.workspace.fs.delete(sourceUri, { recursive: false, useTrash: true });
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
          vscode.window.showWarningMessage('本地源文件已经不存在，将只清理书架记录。');
        } else {
          throw new Error(`无法删除本地源文件，书架记录未移除：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    await beforeRemove();
    await repository.removeBook(book.id);
    vscode.window.showInformationMessage(answer === '移除并删除源文件'
      ? `已移除《${book.title}》，本地源文件已移至回收站。`
      : `已从书架移除《${book.title}》，本地源文件已保留。`);
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `从书架移除《${book.title}》？已缓存的在线章节也会被清理。`,
    { modal: true },
    '移除'
  );
  if (answer === '移除') { await beforeRemove(); await repository.removeBook(book.id); }
}

async function importLocal(repository: BookRepository, reader: ReaderController): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: '打开小说',
    filters: { '小说文件': ['txt', 'epub', 'md', 'text'] }
  });
  const uri = selected?.[0];
  if (!uri) return;
  const extension = path.extname(uri.fsPath).toLowerCase();
  const kind = extension === '.epub' ? 'epub' as const : 'txt' as const;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '正在解析本地小说...' },
    async () => {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > maxLocalBookBytes) throw new Error('本地小说文件超过 64 MB，已拒绝读取。');
      const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
      const parsed = kind === 'epub' ? await parseEpub(bytes, uri.fsPath) : parsePlainText(bytes, uri.fsPath);
      const book: Book = {
        id: stableId(kind, uri.fsPath),
        title: parsed.title,
        kind,
        source: uri.fsPath,
        chapters: parsed.chapters,
        addedAt: Date.now()
      };
      await repository.saveBook(book);
      await reader.openBook(book, parsed);
    }
  );
}

async function showError(context: vscode.ExtensionContext, error: unknown): Promise<void> {
  if (error instanceof BrowserVerificationRequiredError) {
    const action = await vscode.window.showWarningMessage(
      '该站点要求浏览器验证。可以打开一个仅供本插件使用的隔离窗口；扩展不会读取你日常浏览器的账号、Cookie 或历史记录。',
      '打开专用验证窗口'
    );
    if (action !== '打开专用验证窗口') return;
    await startVerificationBrowser(error.url, requestOptions(context));
    vscode.window.showInformationMessage(
      '专用验证窗口已打开。请在其中完成验证或确认页面可以正常显示，然后手动关闭窗口并重试。若站点仍拒绝插件读取，将直接说明，不会再次循环要求验证。'
    );
    return;
  }
  vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (vscode.workspace.getConfiguration('codeNovel').get<boolean>('autoDetectProxy', true)) detectedProxy = await detectLocalProxy();
  const repository = new BookRepository(context);
  const sources = new SourceRepository(context);
  const documentProvider = new ReaderDocumentProvider();
  const handleError = (error: unknown) => {
    void showError(context, error).catch((nested) => {
      vscode.window.showErrorMessage(nested instanceof Error ? nested.message : String(nested));
    });
  };
  const chapters = new ChapterService(repository, (onProgress) => requestOptions(context, onProgress), (id) => sources.getSource(id));
  const reader = new ReaderController(repository, documentProvider, sources, context, chapters, handleError);
  const downloads = new DownloadManager(context, repository, chapters, async (book) => {
    if (book.catalogComplete !== true) await refreshCatalog(context, repository, sources, book);
    if (!book.catalogComplete) throw new Error('只识别了单章链接，整书下载需要可用的完整目录，请先导入目录 URL。');
  });
  activeReaderController = reader;
  activeDownloads = downloads;
  const library = new LibraryProvider(repository, () => sources.getSources().length, (id) => downloads.summary(id));
  context.subscriptions.push(downloads.onDidChange(() => library.refresh()));
  context.subscriptions.push(sources.onDidChange(() => library.refresh()));

  context.subscriptions.push(
    downloads,
    vscode.workspace.registerTextDocumentContentProvider('code-novel', documentProvider),
    vscode.window.registerTreeDataProvider('codeNovel.library', library),
    vscode.commands.registerCommand('codeNovel.searchOnline', () => searchOnlineUI(context, sources, () => requestOptions(context),
      (result) => importOnlineUrl(context, repository, sources, reader, result.url, result.sourceId)).catch(handleError)),
    vscode.commands.registerCommand('codeNovel.downloadBook', async (item?: BookItem | Book) => {
      let book = item instanceof BookItem ? item.book : item;
      if (!book) book = (await vscode.window.showQuickPick(repository.getBooks().filter((b) => b.kind === 'online')
        .map((b) => ({ label: b.title, book: b })), { title: '选择下载或导出的书籍' }))?.book;
      if (!book) return;
      await downloads.manage(book).catch(handleError);
    }),
    vscode.commands.registerCommand('codeNovel.configureBoss', () => configureBoss(context, reader).catch(handleError)),
    vscode.commands.registerCommand('codeNovel.saveBossContent', () => saveBoss(context, reader).catch(handleError)),
    vscode.commands.registerCommand('codeNovel.switchReadingTemplate', () => reader.switchReadingTemplate().catch(handleError)),
    vscode.commands.registerCommand('codeNovel.importUrl', () => importOnlineUrl(context, repository, sources, reader).catch(handleError)),
    vscode.commands.registerCommand('codeNovel.openLocal', () => importLocal(repository, reader).catch(handleError)),
    vscode.commands.registerCommand('codeNovel.openBook', (item?: BookItem | Book) => {
      const book = item instanceof BookItem ? item.book : item;
      if (book) reader.openBook(book).catch(handleError);
    }),
    vscode.commands.registerCommand('codeNovel.removeBook', async (item?: BookItem) => {
      if (!item) return;
      await removeFromLibrary(repository, item, async () => {
        reader.forgetBook(item.book.id);
        await downloads.remove(item.book.id);
        await chapters.cancelBook(item.book.id);
      }).catch(handleError);
    }),
    vscode.commands.registerCommand('codeNovel.openCatalog', (item?: BookItem | Book) => {
      const book = item instanceof BookItem ? item.book : item;
      if (book) openCatalog(reader, book).catch(handleError);
    }),
    vscode.commands.registerCommand('codeNovel.refreshCatalog', (item?: BookItem | Book) => {
      const book = item instanceof BookItem ? item.book : item;
      if (book) refreshCatalog(context, repository, sources, book).catch(handleError);
    }),
    vscode.commands.registerCommand('codeNovel.manageSources', () => manageSources(context, sources, requestOptions(context)).catch(handleError)),
    vscode.commands.registerCommand('codeNovel.clearBrowserData', async () => {
      const answer = await vscode.window.showWarningMessage(
        '清除插件专用浏览器的验证数据？这不会影响你的日常 Chrome/Edge 配置。',
        { modal: true },
        '清除'
      );
      if (answer !== '清除') return;
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(context.globalStorageUri, 'browser-profiles'), { recursive: true, useTrash: false });
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) throw error;
      }
      vscode.window.showInformationMessage('插件专用浏览器数据已清除。');
    }),
    vscode.commands.registerCommand('codeNovel.refreshLibrary', () => library.refresh()),
    vscode.commands.registerCommand('codeNovel.nextPage', () => reader.nextPage().catch(handleError)),
    vscode.commands.registerCommand('codeNovel.previousPage', () => reader.previousPage().catch(handleError)),
    vscode.commands.registerCommand('codeNovel.nextChapter', () => reader.nextChapter().catch(handleError)),
    vscode.commands.registerCommand('codeNovel.previousChapter', () => reader.previousChapter().catch(handleError)),
    vscode.commands.registerCommand('codeNovel.chooseChapter', () => reader.chooseChapter().catch(handleError)),
    vscode.commands.registerCommand('codeNovel.toggleBoss', () => reader.toggleBoss()),
    vscode.commands.registerCommand('codeNovel.reloadChapter', () => reader.reloadChapter().catch(handleError))
  );
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (['readingTemplateMode', 'readingTemplate', 'hideReadingMarkers', 'commentWidth']
      .some((setting) => event.affectsConfiguration(`codeNovel.${setting}`))) reader.refreshReadingTemplate();
  }));
}

export async function deactivate(): Promise<void> {
  await closeVerificationRoutes();
  await activeDownloads?.shutdown();
  activeDownloads = undefined;
  await activeReaderController?.dispose();
  activeReaderController = undefined;
}
