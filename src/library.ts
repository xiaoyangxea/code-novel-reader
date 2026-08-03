import * as vscode from 'vscode';
import { Book } from './model';
import { BookRepository } from './repository';

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

export class LibraryProvider implements vscode.TreeDataProvider<BookItem> {
  private readonly emitter = new vscode.EventEmitter<BookItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly repository: BookRepository) {
    repository.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: BookItem): vscode.TreeItem {
    return element;
  }

  getChildren(): BookItem[] {
    return this.repository.getBooks().map((book) => {
      const progress = this.repository.getProgress(book.id);
      const detail = `${book.kind === 'online' ? '在线' : book.kind.toUpperCase()} · ${progress.chapterIndex + 1}/${Math.max(book.chapters.length, 1)}`;
      return new BookItem(book, detail);
    });
  }
}
