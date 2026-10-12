import * as vscode from 'vscode';
import { Book } from './model';
import { BookRepository } from './repository';

export class SourceManagerItem extends vscode.TreeItem {
  constructor(sourceCount: number) {
    super('书源管理', vscode.TreeItemCollapsibleState.None);
    this.description = sourceCount > 0 ? `${sourceCount} 个自定义书源` : '导入、测试和管理';
    this.tooltip = '管理公共书源、自定义书源和网络发现';
    this.contextValue = 'codeNovel.sourceManager';
    this.iconPath = new vscode.ThemeIcon('server-environment');
    this.command = { command: 'codeNovel.manageSources', title: '书源管理' };
  }
}

export class BookItem extends vscode.TreeItem {
  constructor(readonly book: Book, detail: string) {
    super(book.title, vscode.TreeItemCollapsibleState.None);
    this.description = book.author || detail;
    this.tooltip = `${book.title}${book.author ? `\n作者：${book.author}` : ''}\n${detail}`;
    this.contextValue = 'codeNovel.book';
    this.iconPath = new vscode.ThemeIcon(book.kind === 'online' ? 'globe' : 'book');
    this.command = {
      command: 'codeNovel.openBook',
      title: '阅读',
      arguments: [this]
    };
  }
}

export class LibraryProvider implements vscode.TreeDataProvider<BookItem | SourceManagerItem> {
  private readonly emitter = new vscode.EventEmitter<BookItem | SourceManagerItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly repository: BookRepository, private readonly sourceCount: () => number,
    private readonly downloadSummary: (id: string) => string = () => '') {
    repository.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: BookItem | SourceManagerItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Array<BookItem | SourceManagerItem> {
    const books = this.repository.getBooks().map((book) => {
      const progress = this.repository.getProgress(book.id);
      const detail = `${book.kind === 'online' ? '在线' : book.kind.toUpperCase()} · ${progress.chapterIndex + 1}/${Math.max(book.chapters.length, 1)}${this.downloadSummary(book.id) ? ` · ${this.downloadSummary(book.id)}` : ''}`;
      return new BookItem(book, detail);
    });
    return [new SourceManagerItem(this.sourceCount()), ...books];
  }
}
