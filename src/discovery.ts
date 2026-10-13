import * as vscode from 'vscode';
import { Dispatcher, fetch as undiciFetch, ProxyAgent } from 'undici';
import { SearchResult } from './model';
import { FetchOptions, readBodyLimited } from './net';
import { webSearchQuery } from './web-search';
import { isLikelyBookCandidate, isSearchNoise } from './search-utils';

const braveKeyName = 'codeNovel.braveSearchApiKey';

export async function hasDiscoveryKey(context: vscode.ExtensionContext): Promise<boolean> {
  return Boolean(await context.secrets.get(braveKeyName));
}

export async function configureDiscovery(context: vscode.ExtensionContext): Promise<void> {
  const existing = await context.secrets.get(braveKeyName);
  const action = existing
    ? await vscode.window.showQuickPick([
      { label: '$(key) 更换 Brave Search API Key', value: 'set' },
      { label: '$(trash) 删除 API Key', value: 'delete' },
      { label: '$(link-external) 打开 Brave Search API 页面', value: 'open' }
    ], { title: '网络发现设置' })
    : { value: 'set' };
  if (!action) return;
  if (action.value === 'open') {
    await vscode.env.openExternal(vscode.Uri.parse('https://brave.com/search/api/'));
    return;
  }
  if (action.value === 'delete') {
    await context.secrets.delete(braveKeyName);
    vscode.window.showInformationMessage('已删除网络发现 API Key。');
    return;
  }
  const key = await vscode.window.showInputBox({
    title: '配置网络发现',
    prompt: '输入你自己的 Brave Search API Key。搜索词会发送给 Brave。',
    password: true,
    ignoreFocusOut: true
  });
  if (!key) return;
  const normalized = key.trim();
  if (!/^[\x21-\x7e]{16,512}$/.test(normalized)) {
    throw new Error('API Key 格式不正确，不能包含空白、换行或控制字符。');
  }
  await context.secrets.store(braveKeyName, normalized);
  vscode.window.showInformationMessage('API Key 已安全保存到 VS Code SecretStorage。');
}

export async function discoverBooks(
  context: vscode.ExtensionContext,
  keyword: string,
  options: FetchOptions
): Promise<SearchResult[]> {
  const apiKey = await context.secrets.get(braveKeyName);
  if (!apiKey) throw new Error('尚未配置 Brave Search API Key，请先打开“书源管理 → 网络发现设置”。');
  const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
  const page = Math.min(Math.max(options.searchPage ?? 1, 1), 5);
  endpoint.searchParams.set('q', webSearchQuery(keyword, ((page - 1) % 3) + 1));
  endpoint.searchParams.set('count', '20');
  endpoint.searchParams.set('offset', String(Math.floor((page - 1) / 3)));
  endpoint.searchParams.set('search_lang', 'zh-hans');
  endpoint.searchParams.set('safesearch', 'moderate');
  const proxyUrl = options.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  let dispatcher: Dispatcher | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    if (proxyUrl) dispatcher = new ProxyAgent(proxyUrl);
    const response = await undiciFetch(endpoint, {
      redirect: 'error',
      dispatcher,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
        'User-Agent': options.userAgent
      }
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Brave Search API 返回 HTTP ${response.status}`);
    }
    if (!/application\/json/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw new Error('Brave Search API 返回了非 JSON 内容。');
    }
    const bytes = await readBodyLimited(response, 2_000_000, '搜索接口响应');
    const data = JSON.parse(bytes.toString('utf8')) as {
      query?: { more_results_available?: boolean };
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const results: SearchResult[] = (data.web?.results ?? []).flatMap((item) => {
      if (!item.title || !item.url) return [];
      let domain: string;
      try {
        const parsed = new URL(item.url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return [];
        domain = parsed.hostname;
      } catch {
        return [];
      }
      return [{
        title: item.title.replace(/<[^>]+>/g, ''),
        url: item.url,
        provider: `网络发现 · ${domain}`,
        latestChapter: item.description?.replace(/<[^>]+>/g, ''),
        summary: item.description?.replace(/<[^>]+>/g, '')
      }];
    }).filter((item) => isLikelyBookCandidate(item) && !isSearchNoise(item));
    options.onSearchBatch?.(results, '网络发现', undefined, Boolean(data.query?.more_results_available) && page < 5);
    return results;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('网络发现请求超时。');
    throw error;
  } finally {
    clearTimeout(timer);
    await dispatcher?.close();
  }
}
