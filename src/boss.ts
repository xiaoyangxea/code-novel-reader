import * as vscode from 'vscode';
import { renderBoss } from './renderer';
import { ReaderController } from './reader';

export function validateBossContent(content: string): string {
  if (Buffer.byteLength(content, 'utf8') > 256_000) throw new Error('老板键内容不能超过 256 KB。');
  return content;
}

export async function configureBoss(context: vscode.ExtensionContext, reader: ReaderController): Promise<void> {
  const action = await vscode.window.showQuickPick([
    { label: '编辑自定义内容', value: 'edit' },
    { label: '从本地文件导入内容快照', value: 'import' },
    { label: '预览老板键内容', value: 'preview' },
    { label: '恢复默认 TypeScript 模板', value: 'reset' }
  ], { title: '老板键显示内容', placeHolder: '仅显示文本，不执行代码；快捷键可在 VS Code 键盘快捷方式中修改' });
  if (!action) return;
  const content = context.globalState.get<string>('codeNovel.bossContent') ?? renderBoss();
  if (action.value === 'reset') {
    await context.globalState.update('codeNovel.bossContent', undefined);
    reader.refreshBossContent();
  } else if (action.value === 'import') {
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: '导入老板键内容' });
    if (!selected?.[0]) return;
    if ((await vscode.workspace.fs.stat(selected[0])).size > 256_000) throw new Error('老板键文件不能超过 256 KB。');
    await context.globalState.update('codeNovel.bossContent', validateBossContent(Buffer.from(await vscode.workspace.fs.readFile(selected[0])).toString('utf8')));
    reader.refreshBossContent();
    vscode.window.showInformationMessage('老板键内容快照已保存。');
  } else {
    const doc = await vscode.workspace.openTextDocument({ content, language: 'typescript' });
    await vscode.window.showTextDocument(doc, { preview: action.value === 'preview' });
    if (action.value === 'edit') vscode.window.showInformationMessage('编辑完成后运行“代码小说: 保存当前编辑器为老板键内容”。');
  }
}

export async function saveBoss(context: vscode.ExtensionContext, reader: ReaderController): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme === 'code-novel') throw new Error('请先打开并编辑要作为老板键内容的文本或代码。');
  await context.globalState.update('codeNovel.bossContent', validateBossContent(editor.document.getText()));
  reader.refreshBossContent();
  vscode.window.showInformationMessage('老板键内容已保存，再次触发老板键即可显示。');
}
