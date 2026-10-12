import * as vscode from 'vscode';
import { NovelSource } from './model';
import { FetchOptions, fetchHtml } from './net';
import { SourceRepository } from './repository';
import { configureDiscovery, hasDiscoveryKey } from './discovery';
import { assertHttpUrl, generateNovelSource, normalizeNovelSource, testNovelSource } from './source-rules';
import { siteProfiles } from './sites';
import { loadCatalogPreview, loadChapter, likelyCatalogUrl, searchBooks } from './adapters';

async function readSourceImport(options: FetchOptions): Promise<{ source: NovelSource; label: string } | undefined> {
  const method = await vscode.window.showQuickPick([
    { label: '$(file-code) 本地 JSON 文件', value: 'file' },
    { label: '$(paste) 粘贴书源 JSON', value: 'paste' },
    { label: '$(cloud-download) 书源订阅 URL', value: 'subscription' }
  ], { title: '导入安全书源', placeHolder: '书源只允许 CSS 选择器和 URL 模板，不执行脚本' });
  if (!method) return undefined;
  let raw: string;
  let subscriptionUrl: string | undefined;
  if (method.value === 'file') {
    const selected = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: '导入书源',
      filters: { 'JSON 书源': ['json'] }
    });
    if (!selected?.[0]) return undefined;
    raw = Buffer.from(await vscode.workspace.fs.readFile(selected[0])).toString('utf8');
  } else if (method.value === 'paste') {
    const pasted = await vscode.window.showInputBox({
      title: '粘贴书源 JSON',
      prompt: '支持单行或多行 JSON 粘贴；不会执行其中的代码。',
      ignoreFocusOut: true
    });
    if (!pasted) return undefined;
    raw = pasted;
  } else {
    const input = await vscode.window.showInputBox({
      title: '导入书源订阅',
      prompt: '输入直接返回一个安全书源 JSON 的 HTTP/HTTPS 地址',
      placeHolder: 'https://example.com/source.json',
      ignoreFocusOut: true
    });
    if (!input) return undefined;
    subscriptionUrl = assertHttpUrl(input.trim(), '订阅 URL');
    raw = await fetchHtml(subscriptionUrl, { ...options, maxBytes: 500_000 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('书源不是有效的 JSON。');
  }
  const source = normalizeNovelSource(parsed, subscriptionUrl);
  return { source, label: `${source.name}（${source.domains.join(', ')}）` };
}

export async function importNovelSource(repository: SourceRepository, options: FetchOptions): Promise<void> {
  const imported = await readSourceImport(options);
  if (!imported) return;
  const answer = await vscode.window.showInformationMessage(
    `导入书源“${imported.label}”？`,
    { modal: true, detail: '已通过安全格式检查。导入后仍建议使用“测试书源”验证目录和正文。' },
    '导入'
  );
  if (answer !== '导入') return;
  await repository.saveSource(imported.source);
  vscode.window.showInformationMessage(`已导入书源“${imported.source.name}”。`);
}

export async function generateSource(repository: SourceRepository, options: FetchOptions): Promise<void> {
  const url = await vscode.window.showInputBox({
    title: '根据目录 URL 生成书源',
    prompt: '插件会测试目录和第一章正文，然后生成当前网站的声明式规则。',
    placeHolder: 'https://example.com/book/123/'
  });
  if (!url) return;
  const generated = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '正在分析目录和正文结构...' },
    () => generateNovelSource(url, options)
  );
  const answer = await vscode.window.showInformationMessage(
    `识别成功：${generated.catalog.title}，共 ${generated.catalog.chapters.length} 章。保存书源“${generated.source.name}”？`,
    { modal: true },
    '保存书源'
  );
  if (answer !== '保存书源') return;
  await repository.saveSource(generated.source);
}

async function replaceFromClipboard(repository: SourceRepository, current: NovelSource): Promise<void> {
  const raw = await vscode.env.clipboard.readText();
  if (!raw.trim()) throw new Error('剪贴板中没有 JSON。');
  const replacement = normalizeNovelSource(JSON.parse(raw), current.subscriptionUrl);
  if (replacement.id !== current.id) {
    const answer = await vscode.window.showWarningMessage(
      '新规则的名称或域名发生变化，将作为新书源保存。原书源不会自动删除。',
      { modal: true },
      '继续'
    );
    if (answer !== '继续') return;
  }
  replacement.addedAt = current.addedAt;
  await repository.saveSource(replacement);
}

async function manageCustomSource(repository: SourceRepository, source: NovelSource, options: FetchOptions): Promise<void> {
  const action = await vscode.window.showQuickPick([
    { label: source.enabled ? '$(circle-slash) 禁用书源' : '$(check) 启用书源', value: 'toggle' },
    { label: '$(beaker) 测试目录和正文', value: 'test' },
    ...(source.subscriptionUrl ? [{ label: '$(sync) 从订阅 URL 更新', value: 'update' }] : []),
    { label: '$(copy) 复制书源 JSON', value: 'copy' },
    { label: '$(replace) 用剪贴板 JSON 替换规则', value: 'replace' },
    { label: '$(save-as) 导出 JSON 文件', value: 'export' },
    { label: '$(trash) 删除书源', value: 'delete' }
  ], { title: source.name, placeHolder: source.domains.join(', ') });
  if (!action) return;
  if (action.value === 'toggle') {
    await repository.saveSource({ ...source, enabled: !source.enabled });
  } else if (action.value === 'test') {
    const url = await vscode.window.showInputBox({ title: `测试“${source.name}”`, prompt: '输入该书源下的一本书目录 URL' });
    if (!url) return;
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在测试目录和第一章...' },
      () => testNovelSource(source, url, options)
    );
    vscode.window.showInformationMessage(`测试成功：${result.catalog.title}，${result.catalog.chapters.length} 章；第一章“${result.sampleTitle}”。`);
  } else if (action.value === 'update' && source.subscriptionUrl) {
    const updated = normalizeNovelSource(JSON.parse(await fetchHtml(source.subscriptionUrl, { ...options, maxBytes: 500_000 })), source.subscriptionUrl);
    updated.addedAt = source.addedAt;
    await repository.saveSource(updated);
  } else if (action.value === 'copy') {
    await vscode.env.clipboard.writeText(JSON.stringify(source, null, 2));
    vscode.window.showInformationMessage('书源 JSON 已复制到剪贴板。');
  } else if (action.value === 'replace') {
    await replaceFromClipboard(repository, source);
  } else if (action.value === 'export') {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${source.name.replace(/[\\/:*?"<>|]/g, '_')}.json`),
      filters: { 'JSON 书源': ['json'] },
      saveLabel: '导出书源'
    });
    if (target) await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(source, null, 2), 'utf8'));
  } else if (action.value === 'delete') {
    const answer = await vscode.window.showWarningMessage(`删除书源“${source.name}”？书架中的书不会被删除。`, { modal: true }, '删除');
    if (answer === '删除') await repository.removeSource(source.id);
  }
}

export async function manageSources(
  context: vscode.ExtensionContext,
  repository: SourceRepository,
  options: FetchOptions
): Promise<void> {
  const discoveryConfigured = await hasDiscoveryKey(context);
  const customSources = repository.getSources();
  const checks = context.globalState.get<Record<string, { date: string; detail: string }>>('codeNovel.sourceChecks', {});
  const selected = await vscode.window.showQuickPick([
    { label: '$(cloud-download) 导入书源', description: '本地 JSON、粘贴 JSON 或订阅 URL', entryType: 'action', id: 'import' },
    { label: '$(wand) 根据目录 URL 自动生成', description: '分析目录和第一章后保存规则', entryType: 'action', id: 'generate' },
    { label: '$(globe) 网络发现设置', description: discoveryConfigured ? 'Brave Search API 已配置' : '未配置 API Key', entryType: 'action', id: 'discovery' },
    ...siteProfiles.filter((profile) => profile.search).map((profile) => ({
      label: `${repository.isBuiltInEnabled(profile.id) ? '$(check)' : '$(circle-slash)'} ${profile.name}`,
      description: `${profile.experimental ? '实验来源（默认关闭）' : '内置来源'}${checks[profile.id] ? ` · ${checks[profile.id]!.date} ${checks[profile.id]!.detail}` : ''}`,
      entryType: 'builtin',
      id: profile.id
    })),
    ...customSources.map((source) => ({
      label: `${source.enabled ? '$(check)' : '$(circle-slash)'} ${source.name}`,
      description: source.domains.join(', '),
      entryType: 'custom',
      id: source.id
    }))
  ], { title: '书源管理', placeHolder: '选择操作或书源', matchOnDescription: true });
  if (!selected) return;
  if (selected.entryType === 'action') {
    if (selected.id === 'import') await importNovelSource(repository, options);
    if (selected.id === 'generate') await generateSource(repository, options);
    if (selected.id === 'discovery') await configureDiscovery(context);
    return;
  }
  if (selected.entryType === 'builtin') {
    const profile = siteProfiles.find((item) => item.id === selected.id)!;
    const enabled = repository.isBuiltInEnabled(selected.id);
    const answer = await vscode.window.showQuickPick([
      { label: enabled ? '禁用此搜索来源' : '启用此搜索来源', action: 'toggle' },
      { label: '测试搜索、目录和正文', action: 'test' },
      ...(profile.provenance ? [{ label: '查看来源出处', action: 'origin' }] : [])
    ], { title: profile.name });
    if (answer?.action === 'toggle') await repository.setBuiltInEnabled(selected.id, !enabled);
    if (answer?.action === 'origin' && profile.provenance) await vscode.env.openExternal(vscode.Uri.parse(profile.provenance));
    if (answer?.action === 'test') {
      const keyword = await vscode.window.showInputBox({ title: `测试 ${profile.name}`, prompt: '输入一本你知道该站有的书名' });
      if (!keyword) return;
      let detail = '';
      try {
        detail = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '测试搜索、目录和第一章…' }, async () => {
          const searched = await searchBooks(keyword, [], options, [profile.search!.name]);
          if (!searched.results.length) throw new Error(searched.errors.join('；') || '搜索结果为零');
          const first = searched.results[0]!;
          const catalog = await loadCatalogPreview(likelyCatalogUrl(first.url) ?? first.url, options);
          if (!catalog.chapters.length) throw new Error('未识别目录');
          const chapter = await loadChapter(catalog.chapters[0]!.url, options);
          return `通过：${searched.results.length} 条结果，${catalog.chapters.length} 章，正文 ${chapter.content.length} 字`;
        });
      } catch (error) { detail = `未通过：${error instanceof Error ? error.message : String(error)}`; }
      checks[profile.id] = { date: new Date().toISOString().slice(0, 10), detail: detail.slice(0, 500) };
      await context.globalState.update('codeNovel.sourceChecks', checks);
      vscode.window.showInformationMessage(`${profile.name}：${detail}`);
    }
    return;
  }
  const source = repository.getSource(selected.id);
  if (source) await manageCustomSource(repository, source, options);
}
