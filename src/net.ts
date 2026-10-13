import * as iconv from 'iconv-lite';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, Dispatcher, fetch as undiciFetch, Pool, ProxyAgent } from 'undici';
import type { SearchResult } from './model';
import { effectiveProxy } from './proxy';

const maxResponseBytes = 8_000_000;
const requestCooldowns = new Map<string, number>();
export class RateLimitedError extends Error {
  constructor(message: string) { super(message); this.name = 'RateLimitedError'; }
}
const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['2001:2::', 48],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv6');

export interface FetchOptions {
  timeoutMs: number;
  userAgent: string;
  referer?: string;
  proxy?: string;
  maxBytes?: number;
  browserRendering?: boolean;
  browserExecutable?: string;
  browserDataDirectory?: string;
  browserTimeoutMs?: number;
  onProgress?: (message: string) => void;
  searchPage?: number;
  shouldContinue?: () => boolean;
  onSearchBatch?: (results: SearchResult[], provider: string, error?: string, hasMore?: boolean) => void;
  method?: 'GET' | 'POST';
  form?: Record<string, string>;
  charset?: 'utf-8' | 'gbk' | 'gb18030';
  onFinalUrl?: (url: string) => void;
  allowsUrl?: (url: string) => boolean;
}

interface DownloadedResponse {
  bytes: Buffer;
  contentType: string | null;
  redirectUrl?: string;
  redirectStatus?: number;
}

export function encodeSearchForm(form: Record<string, string>, charset: 'utf-8' | 'gbk' | 'gb18030' = 'utf-8'): string {
  const entries = Object.entries(form);
  if (entries.length > 20 || entries.some(([key, value]) => key.length > 100 || typeof value !== 'string' || value.length > 500
    || /^(?:cookie|authorization|password|token|secret)$/i.test(key))) throw new Error('搜索表单字段过多、过长或包含凭据。');
  const encode = (value: string) => [...iconv.encode(value, charset)].map((byte) =>
    /[A-Za-z0-9_.~-]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('');
  return entries.map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
}

export function assertSafeRemoteUrl(rawUrl: string): string {
  return validateRemoteTarget(rawUrl).toString();
}

export async function resolveSafeRemoteUrl(rawUrl: string, timeoutMs: number, proxy?: string): Promise<{ url: string; address: string }> {
  const target = validateRemoteTarget(rawUrl);
  const address = await resolvePublicAddress(target, timeoutMs, effectiveProxy(proxy));
  return { url: target.toString(), address };
}

function validateRemoteTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('只允许不含账号信息的 HTTP/HTTPS 地址。');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) > 0 && isBlockedNetworkAddress(host))) {
    throw new Error('不允许访问本机或局域网地址。');
  }
  return url;
}

function detectCharset(bytes: Buffer, contentType: string | null): string {
  const header = contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  if (header) {
    return normalizeCharset(header);
  }

  const head = bytes.subarray(0, Math.min(bytes.length, 8192)).toString('latin1');
  const meta = head.match(/<meta[^>]+charset\s*=\s*["']?([^"'\s/>;]+)/i)?.[1]
    ?? head.match(/<meta[^>]+content=["'][^"']*charset=([^"'\s;]+)/i)?.[1];
  if (meta) {
    return normalizeCharset(meta);
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    return 'gb18030';
  }
}

function normalizeCharset(value: string): string {
  const charset = value.trim().toLowerCase();
  if (charset === 'gb2312' || charset === 'gbk') {
    return 'gb18030';
  }
  return charset;
}

function isFakeIp(address: string): boolean {
  return /^198\.(?:18|19)\./.test(address) || /^fdfe:dcba:9876:/i.test(address) || /^2001:2:/i.test(address);
}

export function isBlockedNetworkAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  const family = isIP(normalized);
  return family === 4
    ? blockedAddresses.check(normalized, 'ipv4')
    : family === 6 && blockedAddresses.check(normalized, 'ipv6');
}

async function resolveWithDoh(hostname: string, timeoutMs: number, proxy?: string): Promise<string | undefined> {
  const endpoints = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`
  ];
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5000));
    const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
    try {
      const response = await undiciFetch(endpoint, {
        redirect: 'error',
        signal: controller.signal,
        dispatcher,
        headers: { Accept: 'application/dns-json' }
      });
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      const data = JSON.parse((await readBodyLimited(response, 100_000, 'DNS 响应')).toString('utf8')) as {
        Answer?: Array<{ type?: number; data?: string }>;
      };
      const addresses = data.Answer?.flatMap((answer) => answer.type === 1 && answer.data && isIP(answer.data) === 4 ? [answer.data] : []) ?? [];
      if (addresses.some(isBlockedNetworkAddress)) continue;
      const address = addresses[0];
      if (address) return address;
    } catch {
      // Try the next resolver.
    } finally {
      clearTimeout(timer);
      await dispatcher?.close();
    }
  }
  return undefined;
}

function directAddressAgent(address: string): Agent {
  const family = isIP(address);
  return new Agent({
    connect: {
      lookup: ((_: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (lookupOptions?.all) {
          callback(null, [{ address, family }]);
        } else {
          callback(null, address, family);
        }
      }) as never
    }
  });
}

async function download(
  requestUrl: string,
  logicalUrl: string,
  options: FetchOptions,
  dispatcher?: Dispatcher,
  hostHeader?: string
): Promise<DownloadedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await undiciFetch(requestUrl, {
      redirect: 'manual',
      signal: controller.signal,
      dispatcher,
      method: options.method ?? 'GET',
      body: options.method === 'POST' && options.form ? encodeSearchForm(options.form, options.charset) : undefined,
      headers: {
        'User-Agent': options.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
        ...(hostHeader ? { Host: hostHeader } : {}),
        ...(options.referer ? { Referer: options.referer } : {}),
        ...(options.method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
      }
    });
    if (response.status === 429) {
      const retry = response.headers.get('retry-after') ?? '';
      const requested = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      const delay = Number.isFinite(requested) ? Math.min(Math.max(requested, 1000), 300_000) : 60_000;
      if (requestCooldowns.size >= 128) requestCooldowns.delete(requestCooldowns.keys().next().value!);
      requestCooldowns.set(new URL(logicalUrl).origin, Date.now() + delay);
      await response.body?.cancel();
      throw new RateLimitedError(`HTTP 429：站点限制请求频率，将暂停该来源 ${Math.ceil(delay / 1000)} 秒。`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`HTTP ${response.status} 缺少重定向地址`);
      await response.body?.cancel();
      return { bytes: Buffer.alloc(0), contentType: null, redirectUrl: new URL(location, logicalUrl).toString(), redirectStatus: response.status };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    validateRemoteTarget(logicalUrl);
    const bytes = await readBodyLimited(response, Math.min(options.maxBytes ?? maxResponseBytes, maxResponseBytes), '网页响应');
    return { bytes, contentType: response.headers.get('content-type') };
  } catch (error) {
    if (error instanceof RateLimitedError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`请求超时（${options.timeoutMs}ms）: ${logicalUrl}`);
    }
    const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
    const message = cause?.message || (error instanceof Error ? error.message : String(error));
    throw new Error(`请求失败${cause?.code ? ` [${cause.code}]` : ''}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

const publicDnsCache = new Map<string, { address: string; expires: number }>();

async function resolvePublicAddress(target: URL, timeoutMs: number, proxy?: string): Promise<string> {
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (isBlockedNetworkAddress(hostname)) throw new Error('目标地址属于本机、局域网或保留网段，已拒绝访问。');
    return hostname;
  }
  const cached = publicDnsCache.get(hostname);
  if (cached && cached.expires > Date.now()) return cached.address;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (error) {
    if (!proxy) throw new Error(`无法通过系统 DNS 安全解析目标域名：${error instanceof Error ? error.message : String(error)}`);
    addresses = [];
  }
  if (addresses.some((item) => isBlockedNetworkAddress(item.address) && !isFakeIp(item.address))) {
    throw new Error('目标域名解析到了本机、局域网或保留地址，已拒绝访问。');
  }
  const fakeIp = addresses.find((item) => isFakeIp(item.address));
  const address = fakeIp || !addresses.length ? await resolveWithDoh(hostname, timeoutMs, proxy) : addresses[0]?.address;
  if (!address) throw new Error(`无法安全解析目标域名：${hostname}`);
  if (isBlockedNetworkAddress(address)) throw new Error('目标域名解析到了本机、局域网或保留地址，已拒绝访问。');
  if (publicDnsCache.size >= 256) publicDnsCache.delete(publicDnsCache.keys().next().value!);
  publicDnsCache.set(hostname, { address, expires: Date.now() + 60_000 });
  return address;
}

export function pinnedProxyAgent(proxy: string, address: string): ProxyAgent {
  // Keep the logical URL intact (Host, TLS identity and redirects). Pin only
  // the proxy's CONNECT destination, rather than rewriting the fetch URL to an IP.
  return new ProxyAgent({ uri: proxy, clientFactory: (origin, options) => new Pool(origin, options).compose((dispatch) => (request, handler) => {
      if (request.method === 'CONNECT') {
        const target = new URL(`https://${request.path}`);
        return dispatch({ ...request, path: `${address.includes(':') ? `[${address}]` : address}:${target.port || '443'}` }, handler);
      }
      return dispatch(request, handler);
    }) });
}

export async function readBodyLimited(
  response: { body: unknown; headers: { get(name: string): string | null } },
  limit: number,
  label: string
): Promise<Buffer> {
  type LimitedBody = {
    cancel(): Promise<void>;
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
      releaseLock(): void;
    };
  };
  const body = response.body as LimitedBody | null;
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await body?.cancel();
    throw new Error(`${label}超过 ${Math.ceil(limit / 1_000_000)} MB，已停止读取。`);
  }
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`${label}超过 ${Math.ceil(limit / 1_000_000)} MB，已停止读取。`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function fetchHtml(url: string, options: FetchOptions): Promise<string> {
  const proxyUrl = effectiveProxy(options.proxy);
  let currentUrl = url;
  let requestOptions = options;
  const deadline = Date.now() + options.timeoutMs;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    if (options.allowsUrl && !options.allowsUrl(currentUrl)) throw new Error('请求被书源声明的域名范围拒绝。');
    const target = validateRemoteTarget(currentUrl);
    const cooldown = requestCooldowns.get(target.origin) ?? 0;
    if (cooldown > Date.now()) throw new RateLimitedError(`该来源正在限流冷却，请在 ${Math.ceil((cooldown - Date.now()) / 1000)} 秒后重试。`);
    requestCooldowns.delete(target.origin);
    const address = await resolvePublicAddress(target, Math.max(deadline - Date.now(), 1), proxyUrl);
    let dispatcher: Dispatcher;
    let requestUrl = currentUrl;
    let hostHeader: string | undefined;
    if (proxyUrl) {
      dispatcher = pinnedProxyAgent(proxyUrl, address);
    } else {
      dispatcher = directAddressAgent(address);
    }
    let result: DownloadedResponse;
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error(`请求超时（${options.timeoutMs}ms）: ${url}`);
      result = await download(requestUrl, currentUrl, { ...requestOptions, timeoutMs: remainingMs }, dispatcher, hostHeader);
    } finally {
      await dispatcher.close();
    }
    if (result.redirectUrl) {
      if (requestOptions.method === 'POST') {
        if ([301, 302, 303].includes(result.redirectStatus ?? 0)) requestOptions = { ...requestOptions, method: 'GET', form: undefined };
        else if (new URL(result.redirectUrl).origin !== new URL(currentUrl).origin) throw new Error('拒绝将搜索表单跨域重定向。');
      }
      currentUrl = result.redirectUrl;
      continue;
    }
    const charset = detectCharset(result.bytes, result.contentType);
    options.onFinalUrl?.(currentUrl);
    return iconv.decode(result.bytes, iconv.encodingExists(charset) ? charset : 'utf-8');
  }
  throw new Error('网页重定向超过 5 次，已停止访问。');
}

export function resolveUrl(href: string | undefined, baseUrl: string): string | undefined {
  if (!href || href.startsWith('javascript:') || href === '#') {
    return undefined;
  }
  try {
    const url = new URL(href, baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
