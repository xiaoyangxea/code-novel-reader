import * as vscode from 'vscode';
import { loadCatalogPreview, likelyCatalogUrl, searchBooks } from './adapters';
import { BrowserVerificationRequiredError } from './browser';
import { discoverBooks, hasDiscoveryKey, configureDiscovery } from './discovery';
import { FetchOptions } from './net';
import { SearchProviderConfig, SearchResult } from './model';
import { SourceRepository } from './repository';
import { searchNovelSources } from './source-rules';
import { siteProfiles } from './sites';
import { groupSearchResults } from './search-utils';
import { publicWebSearch } from './web-search';

interface Item extends vscode.QuickPickItem { results?: SearchResult[]; action?: 'more' | 'discovery' | 'public' | 'status'; }

export async function searchOnlineUI(context: vscode.ExtensionContext, sources: SourceRepository,
  getOptions: () => FetchOptions, importResult: (result: SearchResult) => Promise<void>): Promise<void> {
  const keyword = (await vscode.window.showInputBox({ title: '搜索在线小说', prompt: '输入书名或作者' }))?.trim();
  if (!keyword) return;
  if (keyword.length > 100 || /[\u0000-\u001f\u007f]/.test(keyword)) throw new Error('搜索词不能超过 100 个字符或包含控制字符。');
  const profiles = siteProfiles.filter((profile) => profile.search && sources.isBuiltInEnabled(profile.id));
  const mine = sources.getSources().filter((source) => source.enabled && source.search);
  const legacy = vscode.workspace.getConfiguration('codeNovel').get<SearchProviderConfig[]>('searchProviders', []);
  const selected = await vscode.window.showQuickPick([
    { label: '全部已启用书源', mode: 'all', names: profiles.map((p) => p.search!.name) },
    { label: '公共/内置来源', mode: 'builtin', names: profiles.map((p) => p.search!.name) },
    { label: '我的书源', mode: 'custom', names: [] },
    { label: '网络发现（Brave API）', mode: 'discovery', names: [] },
    { label: '公开网页搜索（实验，无需 Key）', description: '搜索词会发送给 DuckDuckGo，可用性取决于搜索网站', mode: 'public', names: [] },
    ...profiles.map((p) => ({ label: p.name, mode: 'builtin-one', names: [p.search!.name] })),
    ...mine.map((p) => ({ label: p.name, mode: 'custom-one', names: [p.id] }))
  ], { title: '选择搜索来源' });
  if (!selected) return;
  const selectedNames = selected.names as string[];
  const picker = vscode.window.createQuickPick<Item>();
  picker.title = `搜索“${keyword}”`;
  picker.placeholder = '结果陆续显示；选择同一本书后可切换来源，Esc 停止继续搜索';
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.ignoreFocusOut = true;
  const results: SearchResult[] = [];
  const statuses = new Map<string, string>();
  const more = new Set<string>();
  let page = 1;
  let discoveryPage = 0;
  let alive = true;
  let busy = false;
  let chosen: SearchResult[] | undefined;
  const update = () => {
    if (!alive) return;
    picker.items = [
      ...groupSearchResults(results, keyword).map((group) => ({ label: group[0]!.title,
        description: `${group[0]!.author ?? ''} · ${group.length} 个来源`,
        detail: group.map((r) => `${r.provider}${r.catalogStatus === 'verified' ? '（目录已识别）' : r.catalogStatus === 'verification' ? '（需要验证）' : ''}`).join(' · '), results: group })),
      ...(!busy && more.size && page < 5 ? [{ label: '$(add) 加载更多站内结果', action: 'more' as const }] : []),
      { label: '$(globe) 扩大搜索范围（Brave API）', action: 'discovery' },
      { label: '$(search) 公开网页补搜（实验）', action: 'public' },
      { label: `$(info) 来源状态（${statuses.size}）`, description: busy ? '搜索中…' : `${results.length} 条结果`, action: 'status' }
    ];
    picker.busy = busy;
  };
  const batch = (items: SearchResult[], provider: string, error?: string, hasMore?: boolean) => {
    if (!alive) return;
    for (const result of items) if (!results.some((r) => r.url === result.url)) results.push(result);
    statuses.set(provider, error ? `失败：${error}` : `${items.length} 条结果${hasMore ? '，有后续分页' : ''}`);
    if (hasMore && provider !== '网络发现' && provider !== '公开网页搜索') more.add(provider); else more.delete(provider);
    update();
  };
  const probe = async (items: SearchResult[]) => {
    for (const item of items.slice(0, 8)) {
      if (!alive) break;
      try {
        const catalog = await loadCatalogPreview(likelyCatalogUrl(item.url) ?? item.url, { ...getOptions(), browserRendering: false });
        if (catalog.chapters.length >= 2) {
          item.title = catalog.title;
          item.author = catalog.author;
          item.chapterCount = catalog.chapters.length;
          item.catalogStatus = 'verified';
        }
      } catch (error) { item.catalogStatus = error instanceof BrowserVerificationRequiredError ? 'verification' : 'unverified'; }
      update();
    }
  };
  const run = async (mode: string) => {
    if (busy || !alive) return;
    busy = true; update();
    const options: FetchOptions = { ...getOptions(), searchPage: page, shouldContinue: () => alive, onSearchBatch: batch };
    try {
      if (mode === 'discovery') {
        if (!await hasDiscoveryKey(context)) await configureDiscovery(context);
        if (!await hasDiscoveryKey(context) || !alive) return;
        if (discoveryPage >= 5) { statuses.set('网络发现', '已达到本次补搜 5 页上限'); return; }
        discoveryPage += 1;
        const items = await discoverBooks(context, keyword, { ...options, searchPage: discoveryPage });
        await probe(items);
      } else if (mode === 'public') {
        const items = await publicWebSearch(keyword, options);
        batch(items, '公开网页搜索'); await probe(items);
      } else {
        await Promise.all([
          ['all', 'builtin', 'builtin-one'].includes(mode)
            ? searchBooks(keyword, mode === 'all' ? legacy : [], options,
              [...selectedNames, ...(mode === 'all' ? legacy.map((p) => p.name) : [])]) : Promise.resolve(),
          ['all', 'custom', 'custom-one'].includes(mode)
            ? searchNovelSources(keyword, mode === 'custom-one' ? mine.filter((s) => selectedNames.includes(s.id)) : mine, options) : Promise.resolve()
        ]);
      }
    } catch (error) { if (alive) statuses.set(mode, error instanceof Error ? error.message : String(error)); }
    finally { busy = false; if (alive) update(); }
  };
  const done = new Promise<void>((resolve) => {
    picker.onDidHide(() => { alive = false; resolve(); });
    picker.onDidAccept(() => {
      const item = picker.selectedItems[0];
      if (item?.results) { chosen = item.results; picker.hide(); return; }
      if (item?.action === 'status') {
        void vscode.window.showInformationMessage([...statuses].map(([name, state]) => `${name}：${state}`).join('\n') || '尚无来源完成搜索。', { modal: true });
      } else if (item?.action && !busy) {
        if (item.action === 'more') { page += 1; void run(selected.mode); }
        else void run(item.action);
      }
    });
  });
  picker.show();
  void run(selected.mode);
  await done;
  picker.dispose();
  if (!chosen?.length) return;
  const result = chosen.length === 1 ? chosen[0] : (await vscode.window.showQuickPick(chosen.map((r) => ({ label: r.provider,
    description: r.author, detail: `${r.url}${r.chapterCount ? ` · 已识别 ${r.chapterCount} 章` : ''}`, result: r })), { title: '选择阅读来源' }))?.result;
  if (result) await importResult(result);
}
