import { promises as fs } from 'node:fs';
import path from 'node:path';

export const ui = { choices: [], inputs: [], messages: [], configuration: {}, saveTarget: undefined };
export class EventEmitter { event = () => ({ dispose() {} }); fire() {} dispose() {} }
export class Uri {
  constructor(fsPath, scheme = 'file') { this.fsPath = fsPath; this.scheme = scheme; }
  static file(p) { return new Uri(p); }
  static parse(p) { return new Uri(p, p.split(':')[0]); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts), base.scheme); }
}
export const StatusBarAlignment = { Left: 1 };
export const ProgressLocation = { Window: 1, Notification: 2 };
export const TextEditorRevealType = { AtTop: 0 };
export class Position { constructor(line, character) { this.line = line; this.character = character; } }
export class Range { constructor(start, end) { this.start = start; this.end = end; } }
export class Selection extends Range {}
export const commands = { executeCommand: async () => undefined };
export const languages = { setTextDocumentLanguage: async () => undefined };
export const workspace = {
  getConfiguration: () => ({ get: (key, fallback) => ui.configuration[key] ?? fallback, inspect: () => ({}) }),
  openTextDocument: async (value) => ({ uri: value instanceof Uri ? value : Uri.parse('untitled:boss.ts'),
    getText: () => value.content ?? '', lineCount: 1, lineAt: () => ({ text: '' }) }),
  fs: {
    readFile: (uri) => fs.readFile(uri.fsPath),
    writeFile: (uri, bytes) => fs.writeFile(uri.fsPath, bytes),
    stat: (uri) => fs.stat(uri.fsPath),
    rename: (a, b) => fs.rename(a.fsPath, b.fsPath)
  }
};
export const window = {
  activeTextEditor: undefined,
  createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
  showQuickPick: async () => ui.choices.shift(),
  showInputBox: async () => ui.inputs.shift(),
  showOpenDialog: async () => ui.choices.shift(),
  showSaveDialog: async () => ui.saveTarget,
  showTextDocument: async (document) => ({ document, revealRange() {} }),
  withProgress: async (_, task) => task({ report() {} }),
  showInformationMessage: async (message) => { ui.messages.push(message); },
  showWarningMessage: async (message) => { ui.messages.push(message); return ui.choices.shift(); },
  showErrorMessage: async (message) => { ui.messages.push(message); }
};
