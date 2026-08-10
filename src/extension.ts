import * as path from 'node:path';
import * as vscode from 'vscode';
import { likelyCatalogUrl, loadCatalog, loadCatalogPreview, loadChapter, searchBooks } from './adapters';
import { BrowserVerificationRequiredError, startVerificationBrowser } from './browser';
import { discoverBooks, hasDiscoveryKey } from './discovery';
import { LibraryProvider, BookItem } from './library';
import { maxLocalBookBytes, parseEpub, parsePlainText } from './local';
import { Book, NovelSource, ParsedCatalog, SearchProviderConfig, SearchResult } from './model';
import { ReaderController, ReaderDocumentProvider } from './reader';
import { BookRepository, SourceRepository, stableId } from './repository';
import { manageSources } from './source-manager';
import { assertHttpUrl, searchNovelSources } from './source-rules';
import { siteProfiles } from './sites';

let activeReaderController: ReaderController | undefined;

function requestOptions(context: vscode.ExtensionContext, onProgress?: (message: string) => void) {
  const config = vscode.workspace.getConfiguration('codeNovel');
  const executable = config.inspect<string>('browserExecutable')?.globalValue?.trim();
  return {
    timeoutMs: config.get<number>('requestTimeout', 15000),
    userAgent: config.get<string>('userAgent', 'Mozilla/5.0'),
    proxy: config.get<string>('proxy') || vscode.workspace.getConfiguration('http').get<string>('proxy') || undefined,
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
): Promise<{ catalog: ParsedCatalog; selectedIndex: number }> {
  const inferredCatalogUrl = likelyCatalogUrl(url);
  for (const candidate of [...new Set([inferredCatalogUrl, url].filter((value): value is string => Boolean(value)))]) {
    try {
      const directCatalog = await loadCatalog(candidate, requestOptions(context, onProgress), source);
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

  const chapter = await loadChapter(url, requestOptions(context, onProgress), source);
  const candidates = [chapter.catalogUrl, inferredCatalogUrl].filter((value): value is string => Boolean(value));
  for (const candidate of [...new Set(candidates)]) {
    try {
      const catalog = await loadCatalog(candidate, requestOptions(context, onProgress), source);
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
      const { catalog, selectedIndex } = await catalogFromUrl(context, url, source, (message) => progress.report({ message }));
      const book: Book = {
        id: stableId('online', catalog.chapters[0]?.url ? likelyCatalogUrl(catalog.chapters[0].url) ?? url : url),
        title: catalog.title,
        author: catalog.author,
        kind: 'online',
        source: url,
        sourceId: source?.id,
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

async function probeDiscoveryResults(context: vscode.ExtensionContext, results: SearchResult[]): Promise<SearchResult[]> {
  const output: SearchResult[] = [];
  for (let offset = 0; offset < Math.min(results.length, 8); offset += 3) {
    const batch = results.slice(offset, offset + 3);
    output.push(...await Promise.all(batch.map(async (result) => {
      const inferred = likelyCatalogUrl(result.url);
      for (const candidate of [...new Set([inferred, result.url].filter((value): value is string => Boolean(value)))]) {
        try {
          const catalog = await loadCatalogPreview(candidate, requestOptions(context));
          if (catalog.chapters.length >= 2) {
            return { ...result, title: catalog.title || result.title };
          }
        } catch {
          // Keep the discovery result as an unverified URL.
        }
      }
      return result;
    })));
  }
  return [...output, ...results.slice(8)];
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

async function searchOnline(
  context: vscode.ExtensionContext,
  repository: BookRepository,
  sources: SourceRepository,
  reader: ReaderController
): Promise<void> {
  const keyword = await vscode.window.showInputBox({ title: '搜索在线小说', prompt: '输入书名或作者', placeHolder: '小说名称' });
  if (!keyword) return;
  if (keyword.length > 100 || /[\u0000-\u001f\u007f]/.test(keyword)) {
    throw new Error('搜索词不能超过 100 个字符，也不能包含控制字符。');
  }
  const config = vscode.workspace.getConfiguration('codeNovel');
  const customProviders = config.get<SearchProviderConfig[]>('searchProviders', []);
  const enabledBuiltIns = siteProfiles.filter((profile) => profile.search && sources.isBuiltInEnabled(profile.id));
  const customSources = sources.getSources().filter((source) => source.enabled && source.search);
  const source = await vscode.window.showQuickPick([
    { label: '全部已启用书源', description: '内置来源、我的书源和设置中的兼容入口', mode: 'all', names: enabledBuiltIns.map((item) => item.search!.name) },
    { label: '公共/内置来源', description: '只搜索启用的内置来源', mode: 'builtin', names: enabledBuiltIns.map((item) => item.search!.name) },
    { label: '我的书源', description: customSources.length ? `${customSources.length} 个可搜索书源` : '尚未导入带搜索规则的书源', mode: 'custom', names: [] },
    { label: '网络发现', description: '使用用户配置的 Brave Search API，结果需确认后导入', mode: 'discovery', names: [] },
    ...enabledBuiltIns.map((profile) => ({ label: profile.name, description: '内置来源', mode: 'builtin-one', names: [profile.search!.name] })),
    ...customSources.map((item) => ({ label: item.name, description: item.domains.join(', '), mode: 'custom-one', names: [item.id] }))
  ], { placeHolder: '选择搜索来源' });
  if (!source) return;
  if (source.mode === 'discovery' && !await hasDiscoveryKey(context)) {
    const action = await vscode.window.showWarningMessage(
      '网络发现需要你自己的 Brave Search API Key。也可以先在系统浏览器搜索，再把目录 URL 粘贴到扩展。',
      '配置网络发现',
      '在浏览器搜索'
    );
    if (action === '配置网络发现') await vscode.commands.executeCommand('codeNovel.manageSources');
    if (action === '在浏览器搜索') {
      const query = encodeURIComponent(`"${keyword}" 小说 目录 在线阅读`);
      await vscode.env.openExternal(vscode.Uri.parse(`https://search.brave.com/search?q=${query}`));
    }
    return;
  }
  let results: SearchResult[] = [];
  let errors: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `正在搜索“${keyword}”...` },
    async () => {
      if (source.mode === 'discovery') {
        results = await discoverBooks(context, keyword, requestOptions(context));
        results = await probeDiscoveryResults(context, results);
        return;
      }
      if (source.mode === 'all' || source.mode === 'builtin' || source.mode === 'builtin-one') {
        const legacyProviders = source.mode === 'all' ? customProviders : [];
        const builtIn = await searchBooks(keyword, legacyProviders, requestOptions(context), source.names);
        results.push(...builtIn.results);
        errors.push(...builtIn.errors);
      }
      if (source.mode === 'all' || source.mode === 'custom' || source.mode === 'custom-one') {
        const selectedSources = source.mode === 'custom-one'
          ? customSources.filter((item) => source.names.includes(item.id))
          : customSources;
        const mine = await searchNovelSources(keyword, selectedSources, requestOptions(context));
        results.push(...mine.results);
        errors.push(...mine.errors);
      }
    }
  );
  results = results.filter((item, index) => results.findIndex((other) => other.url === item.url) === index);
  if (results.length === 0) {
    const detail = errors.length ? `\n${errors.join('\n')}` : '';
    vscode.window.showWarningMessage(`没有搜索到结果。${detail}`);
    return;
  }
  const picked = await vscode.window.showQuickPick(results.map((result) => ({
    label: result.title,
    description: [result.author, result.provider, result.chapterCount ? `已识别 ${result.chapterCount} 章` : undefined].filter(Boolean).join(' · '),
    detail: result.latestChapter,
    result
  })), { placeHolder: '选择要导入的小说', matchOnDescription: true, matchOnDetail: true });
  if (picked) {
    await importOnlineUrl(context, repository, sources, reader, picked.result.url, picked.result.sourceId);
  }
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

export function activate(context: vscode.ExtensionContext): void {
  const repository = new BookRepository(context);
  const sources = new SourceRepository(context);
  const documentProvider = new ReaderDocumentProvider();
  const handleError = (error: unknown) => {
    void showError(context, error).catch((nested) => {
      vscode.window.showErrorMessage(nested instanceof Error ? nested.message : String(nested));
    });
  };
  const reader = new ReaderController(repository, documentProvider, sources, context, handleError);
  activeReaderController = reader;
  const library = new LibraryProvider(repository, () => sources.getSources().length);
  context.subscriptions.push(sources.onDidChange(() => library.refresh()));

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('code-novel', documentProvider),
    vscode.window.registerTreeDataProvider('codeNovel.library', library),
    vscode.commands.registerCommand('codeNovel.searchOnline', () => searchOnline(context, repository, sources, reader).catch(handleError)),
    vscode.commands.registerCommand('codeNovel.importUrl', () => importOnlineUrl(context, repository, sources, reader).catch(handleError)),
    vscode.commands.registerCommand('codeNovel.openLocal', () => importLocal(repository, reader).catch(handleError)),
    vscode.commands.registerCommand('codeNovel.openBook', (item?: BookItem | Book) => {
      const book = item instanceof BookItem ? item.book : item;
      if (book) reader.openBook(book).catch(handleError);
    }),
    vscode.commands.registerCommand('codeNovel.removeBook', async (item?: BookItem) => {
      if (!item) return;
      await removeFromLibrary(repository, item).catch(handleError);
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
}

export async function deactivate(): Promise<void> {
  await activeReaderController?.dispose();
  activeReaderController = undefined;
}
