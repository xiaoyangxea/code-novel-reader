import * as vscode from 'vscode';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { ChapterService } from './chapter-service';
import { Book } from './model';
import { BookRepository } from './repository';
import { downloadIndexes, safeExportName } from './download-utils';

interface DownloadState {
  urls: string[];
  status: 'queued' | 'running' | 'paused' | 'cancelled' | 'completed';
  completed: number;
  bytes?: number;
  failures: Record<string, string>;
}

export class DownloadManager implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly states: Record<string, DownloadState>;
  private readonly revisions = new Map<string, number>();
  private running = false;
  private disposed = false;
  private writes: Promise<void> = Promise.resolve();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);

  constructor(private readonly context: vscode.ExtensionContext, private readonly repository: BookRepository,
    private readonly chapters: ChapterService, private readonly ensureCatalog: (book: Book) => Promise<void>) {
    this.states = context.globalState.get<Record<string, DownloadState>>('codeNovel.downloads.v1', {});
    for (const state of Object.values(this.states)) {
      if (state.status === 'running' || state.status === 'queued') state.status = 'paused';
    }
    this.status.command = 'codeNovel.downloadBook';
  }

  private save(): Promise<void> {
    this.changed.fire();
    const snapshot = JSON.parse(JSON.stringify(this.states)) as Record<string, DownloadState>;
    this.writes = this.writes.catch(() => undefined).then(() => this.context.globalState.update('codeNovel.downloads.v1', snapshot));
    return this.writes;
  }

  summary(id: string): string {
    const state = this.states[id];
    if (!state) return '';
    const names = { queued: '下载排队', running: '下载中', paused: '下载暂停', cancelled: '已取消', completed: '下载完成' };
    return `${names[state.status]} ${state.completed}/${state.urls.length}`;
  }

  async manage(book: Book): Promise<void> {
    if (book.kind !== 'online') { vscode.window.showInformationMessage('这本书已是本地文件。'); return; }
    const previous = this.states[book.id];
    const action = await vscode.window.showQuickPick([
      { label: '下载整本书', value: 'all' },
      { label: '下载指定章节范围', value: 'range' },
      ...(previous ? [
        { label: `继续下载（已完成 ${previous.completed}/${previous.urls.length}）`, value: 'resume' },
        { label: '暂停下载', value: 'pause' },
        { label: '取消下载（保留章节缓存）', value: 'cancel' },
        { label: `重试失败章节（${Object.keys(previous.failures).length}）`, value: 'retry' }
      ] : []),
      { label: '导出已缓存章节为 TXT', value: 'export' }
    ], { title: `《${book.title}》下载到本地`, placeHolder: '后台下载不受老板键影响；关闭 VS Code 后可手动续传' });
    if (!action) return;
    if (action.value === 'export') { await this.export(book); return; }
    if (action.value === 'pause' || action.value === 'cancel') {
      this.revisions.set(book.id, (this.revisions.get(book.id) ?? 0) + 1);
      if (previous) previous.status = action.value === 'pause' ? 'paused' : 'cancelled';
      await this.save();
      return;
    }
    if (previous?.status === 'running' || previous?.status === 'queued') {
      vscode.window.showInformationMessage('这本书已有下载任务，请先暂停后再更改范围。'); return;
    }
    if (action.value === 'all' || action.value === 'range') await this.ensureCatalog(book);
    this.chapters.allowBook(book.id);
    if (action.value === 'resume') {
      previous!.status = 'queued';
      previous!.failures = {};
    } else {
      let indexes: number[];
      if (action.value === 'retry') {
        indexes = book.chapters.flatMap((chapter, index) => previous?.failures[chapter.url] ? [index] : []);
      } else {
        const input = action.value === 'range'
          ? await vscode.window.showInputBox({ title: '下载章节范围', prompt: `输入起止章节序号，例如 1-100（共 ${book.chapters.length} 章）` })
          : `1-${book.chapters.length}`;
        if (!input) return;
        indexes = downloadIndexes(input, book.chapters.length);
      }
      if (!indexes.length) { vscode.window.showInformationMessage('没有需要重试的失败章节。'); return; }
      this.states[book.id] = { urls: indexes.map((index) => book.chapters[index]!.url), status: 'queued', completed: 0, failures: {} };
    }
    this.revisions.set(book.id, (this.revisions.get(book.id) ?? 0) + 1);
    await this.save();
    void this.drain().catch((error) => vscode.window.showErrorMessage(`下载任务保存失败：${String(error)}`));
    vscode.window.showInformationMessage('下载任务已加入后台队列。通过书架右键“下载到本地”管理任务。');
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (!this.disposed) {
        const entry = Object.entries(this.states).find(([, state]) => state.status === 'queued');
        if (!entry) break;
        const [id, state] = entry;
        const book = this.repository.getBook(id);
        if (!book) { delete this.states[id]; await this.save(); continue; }
        const revision = this.revisions.get(id) ?? 0;
        const allowed = () => !this.disposed && this.states[id] === state
          && revision === (this.revisions.get(id) ?? 0) && state.status === 'running' && Boolean(this.repository.getBook(id));
        state.status = 'running';
        state.completed = 0;
        state.bytes = 0;
        state.failures = {};
        await this.save();
        for (const url of state.urls) {
          if (!allowed()) break;
          const index = book.chapters.findIndex((chapter) => chapter.url === url);
          this.status.text = `$(cloud-download) ${state.completed}/${state.urls.length}`;
          this.status.tooltip = `${book.title} · ${index >= 0 ? book.chapters[index]!.title : '章节不在当前目录'} · 点击管理下载`;
          this.status.show();
          try {
            const chapter = await this.chapters.get(book, index, 20, false, undefined, allowed);
            if (this.states[id] !== state) break;
            state.bytes += Buffer.byteLength(chapter.content, 'utf8');
            state.completed += 1;
            if (state.bytes > 256_000_000) throw new Error('本次下载已达到 256 MB 上限，请缩小章节范围。');
            if (allowed()) await this.save();
          } catch (error) {
            if (!allowed()) break;
            state.failures[url] = error instanceof Error ? error.message : String(error);
            // A failed/challenged site should not receive a whole-book retry storm.
            state.status = 'paused';
            await this.save();
            vscode.window.showWarningMessage(`《${book.title}》下载已暂停：${state.failures[url]}。可完成验证后继续下载。`);
            break;
          }
        }
        if (allowed()) {
          state.status = 'completed';
          await this.save();
          vscode.window.showInformationMessage(`《${book.title}》下载完成：${state.completed}/${state.urls.length} 章，可离线阅读或导出 TXT。`);
        } else if (this.states[id] === state) await this.save();
      }
    } finally { this.running = false; this.status.hide(); }
  }

  async remove(id: string): Promise<void> {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    delete this.states[id];
    await this.save();
  }

  private async export(book: Book): Promise<void> {
    let references = book.chapters;
    const state = this.states[book.id];
    if (state && state.urls.length < book.chapters.length) {
      const selection = await vscode.window.showQuickPick(['全部目录（未缓存章节会标记缺失）', '本次下载任务的章节范围'], { title: '选择 TXT 导出范围' });
      if (!selection) return;
      if (selection === '本次下载任务的章节范围') {
        const urls = new Set(state.urls);
        references = book.chapters.filter((chapter) => urls.has(chapter.url));
      }
    }
    const missing: number[] = [];
    let found = 0;
    for (const reference of references) {
      if (await this.repository.readCachedChapter(book.id, reference.url)) found += 1;
      else missing.push(book.chapters.indexOf(reference) + 1);
    }
    if (!found) { vscode.window.showInformationMessage('还没有缓存正文，请先下载或阅读章节。'); return; }
    if (missing.length && await vscode.window.showWarningMessage(
      `所选范围已缓存 ${found}/${references.length} 章。缺失章节：${missing.slice(0, 20).join('、')}${missing.length > 20 ? '…' : ''}。导出的 TXT 会标明缺章。`,
      { modal: true }, '导出不完整 TXT') !== '导出不完整 TXT') return;
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.globalStorageUri.fsPath, `${safeExportName(book.title)}.txt`)),
      filters: { 'TXT 小说': ['txt'] }, saveLabel: '导出 TXT' });
    if (!target) return;
    if (target.scheme !== 'file') throw new Error('请选取本机文件路径。');
    await mkdir(path.dirname(target.fsPath), { recursive: true });
    const temporary = await mkdtemp(path.join(path.dirname(target.fsPath), '.code-novel-export-'));
    const file = path.join(temporary, 'novel.txt');
    try {
      const handle = await open(file, 'wx');
      let bytes = 0;
      try {
        const write = async (text: string) => {
          const chunk = Buffer.from(text, 'utf8'); bytes += chunk.length;
          if (bytes > 64_000_000) throw new Error('导出超过 64 MB，请改用章节范围下载后导出。');
          await handle.writeFile(chunk);
        };
        await write(`${book.title}\n${book.author ? `作者：${book.author}\n` : ''}${missing.length ? `【不完整导出：缺少 ${missing.length} 章】\n` : ''}`);
        for (const reference of references) {
          const chapter = await this.repository.readCachedChapter(book.id, reference.url);
          await write(`\n\n${chapter?.title ?? reference.title}\n\n${chapter?.content ?? '【本章未缓存】'}\n`);
        }
      } finally { await handle.close(); }
      await vscode.workspace.fs.rename(vscode.Uri.file(file), target, { overwrite: true });
      vscode.window.showInformationMessage(`已导出 ${found} 章到 ${target.fsPath}。导出文件不会随书架移除而删除。`);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async shutdown(): Promise<void> {
    if (this.disposed) { await this.writes; return; }
    this.disposed = true;
    for (const state of Object.values(this.states)) {
      if (state.status === 'running' || state.status === 'queued') state.status = 'paused';
    }
    await this.save();
    this.status.dispose();
    this.changed.dispose();
  }

  dispose(): void { void this.shutdown().catch(() => undefined); }
}
