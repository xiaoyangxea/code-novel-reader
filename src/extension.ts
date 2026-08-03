import * as path from 'node:path';
import * as vscode from 'vscode';
import { likelyCatalogUrl, loadCatalog, loadChapter, searchBooks } from './adapters';
import { LibraryProvider, BookItem } from './library';
import { parseEpub, parsePlainText } from './local';
import { Book, ParsedCatalog, SearchProviderConfig } from './model';
import { ReaderController, ReaderDocumentProvider } from './reader';
import { BookRepository, stableId } from './repository';
import { builtInSearchProviders } from './sites';

function requestOptions() {
  const config = vscode.workspace.getConfiguration('codeNovel');
  return {
    timeoutMs: config.get<number>('requestTimeout', 15000),
    userAgent: config.get<string>('userAgent', 'Mozilla/5.0'),
    proxy: config.get<string>('proxy') || vscode.workspace.getConfiguration('http').get<string>('proxy') || undefined
  };
}

async function catalogFromUrl(url: string): Promise<{ catalog: ParsedCatalog; selectedIndex: number }> {
  const inferredCatalogUrl = likelyCatalogUrl(url);
  for (const candidate of [...new Set([inferredCatalogUrl, url].filter((value): value is string => Boolean(value)))]) {
    try {
      const directCatalog = await loadCatalog(candidate, requestOptions());
      if (directCatalog.chapters.length >= 2) {
        return {
          catalog: directCatalog,
          selectedIndex: Math.max(0, directCatalog.chapters.findIndex((item) => item.url === url))
        };
      }
    } catch {
      // A chapter page or blocked catalog can still be handled below.
    }
  }

  const chapter = await loadChapter(url, requestOptions());
  const candidates = [chapter.catalogUrl, inferredCatalogUrl].filter((value): value is string => Boolean(value));
  for (const candidate of [...new Set(candidates)]) {
    try {
      const catalog = await loadCatalog(candidate, requestOptions());
      if (catalog.chapters.length >= 2) {
        const selectedIndex = Math.max(0, catalog.chapters.findIndex((item) => item.url === url));
        return { catalog, selectedIndex };
      }
    } catch {
      // Continue with the next inferred catalog URL.
    }
  }
  const chapters = [{ title: chapter.title, url }];
  if (chapter.nextUrl) chapters.push({ title: '下一章（待加载）', url: chapter.nextUrl });
  return {
    catalog: { title: chapter.title.replace(/第.+?[章回].*$/, '').trim() || '在线小说', chapters },
    selectedIndex: 0
  };
}

async function importOnlineUrl(repository: BookRepository, reader: ReaderController, rawUrl?: string): Promise<void> {
  const input = rawUrl ?? await vscode.window.showInputBox({
    title: '导入在线小说',
    prompt: '可输入书籍目录页或任意章节 URL',
    placeHolder: 'https://example.com/book/123/'
  });
  if (!input) return;
  let url: string;
  try {
    url = new URL(input.trim()).toString();
  } catch {
    vscode.window.showErrorMessage('URL 格式不正确。');
    return;
  }
  const imported = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '正在识别小说目录和章节...' },
    async () => {
      const { catalog, selectedIndex } = await catalogFromUrl(url);
      const book: Book = {
        id: stableId('online', catalog.chapters[0]?.url ? likelyCatalogUrl(catalog.chapters[0].url) ?? url : url),
        title: catalog.title,
        author: catalog.author,
        kind: 'online',
        source: url,
        chapters: catalog.chapters,
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

async function removeFromLibrary(repository: BookRepository, item: BookItem): Promise<void> {
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
  if (answer === '移除') await repository.removeBook(book.id);
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
      await reader.openBook(book);
    }
  );
}

async function searchOnline(repository: BookRepository, reader: ReaderController): Promise<void> {
  const keyword = await vscode.window.showInputBox({ title: '搜索在线小说', prompt: '输入书名或作者', placeHolder: '小说名称' });
  if (!keyword) return;
  const config = vscode.workspace.getConfiguration('codeNovel');
  const customProviders = config.get<SearchProviderConfig[]>('searchProviders', []);
  const source = await vscode.window.showQuickPick([
    { label: '全部站点', description: '同时搜索所有已启用来源', names: undefined },
    ...[...builtInSearchProviders, ...customProviders.map((provider) => ({ ...provider, kind: 'html' as const }))]
      .map((provider) => ({ label: provider.name, description: provider.kind === 'html' ? 'HTML 搜索' : 'API 搜索', names: [provider.name] }))
  ], { placeHolder: '选择搜索来源' });
  if (!source) return;
  const { results, errors } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `正在搜索“${keyword}”...` },
    () => searchBooks(keyword, customProviders, requestOptions(), source.names)
  );
  if (results.length === 0) {
    const detail = errors.length ? `\n${errors.join('\n')}` : '';
    vscode.window.showWarningMessage(`没有搜索到结果。${detail}`);
    return;
  }
  const picked = await vscode.window.showQuickPick(results.map((result) => ({
    label: result.title,
    description: [result.author, result.provider].filter(Boolean).join(' · '),
    detail: result.latestChapter,
    result
  })), { placeHolder: '选择要导入的小说', matchOnDescription: true, matchOnDetail: true });
  if (picked) {
    await importOnlineUrl(repository, reader, picked.result.url);
  }
}

function showError(error: unknown): void {
  vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
}

export function activate(context: vscode.ExtensionContext): void {
  const repository = new BookRepository(context);
  const documentProvider = new ReaderDocumentProvider();
  const reader = new ReaderController(repository, documentProvider);
  const library = new LibraryProvider(repository);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('code-novel', documentProvider),
    vscode.window.registerTreeDataProvider('codeNovel.library', library),
    vscode.commands.registerCommand('codeNovel.searchOnline', () => searchOnline(repository, reader).catch(showError)),
    vscode.commands.registerCommand('codeNovel.importUrl', () => importOnlineUrl(repository, reader).catch(showError)),
    vscode.commands.registerCommand('codeNovel.openLocal', () => importLocal(repository, reader).catch(showError)),
    vscode.commands.registerCommand('codeNovel.openBook', (item?: BookItem | Book) => {
      const book = item instanceof BookItem ? item.book : item;
      if (book) reader.openBook(book).catch(showError);
    }),
    vscode.commands.registerCommand('codeNovel.removeBook', async (item?: BookItem) => {
      if (!item) return;
      await removeFromLibrary(repository, item);
    }),
    vscode.commands.registerCommand('codeNovel.refreshLibrary', () => library.refresh()),
    vscode.commands.registerCommand('codeNovel.nextPage', () => reader.nextPage().catch(showError)),
    vscode.commands.registerCommand('codeNovel.previousPage', () => reader.previousPage().catch(showError)),
    vscode.commands.registerCommand('codeNovel.nextChapter', () => reader.nextChapter().catch(showError)),
    vscode.commands.registerCommand('codeNovel.previousChapter', () => reader.previousChapter().catch(showError)),
    vscode.commands.registerCommand('codeNovel.chooseChapter', () => reader.chooseChapter().catch(showError)),
    vscode.commands.registerCommand('codeNovel.toggleBoss', () => reader.toggleBoss()),
    vscode.commands.registerCommand('codeNovel.reloadChapter', () => reader.reloadChapter().catch(showError))
  );
}

export function deactivate(): void {}
