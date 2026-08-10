import * as iconv from 'iconv-lite';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, Dispatcher, fetch as undiciFetch, ProxyAgent } from 'undici';

const maxResponseBytes = 8_000_000;
const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
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
}

interface DownloadedResponse {
  bytes: Buffer;
  contentType: string | null;
  redirectUrl?: string;
}

export function assertSafeRemoteUrl(rawUrl: string): string {
  return validateRemoteTarget(rawUrl).toString();
}

export async function resolveSafeRemoteUrl(rawUrl: string, timeoutMs: number): Promise<{ url: string; address: string }> {
  const target = validateRemoteTarget(rawUrl);
  const address = await resolvePublicAddress(target, timeoutMs);
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
  return /^198\.(?:18|19)\./.test(address) || /^fdfe:dcba:9876:/i.test(address);
}

export function isBlockedNetworkAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  const family = isIP(normalized);
  return family === 4
    ? blockedAddresses.check(normalized, 'ipv4')
    : family === 6 && blockedAddresses.check(normalized, 'ipv6');
}

async function resolveWithDoh(hostname: string, timeoutMs: number): Promise<string | undefined> {
  const endpoints = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`
  ];
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5000));
    try {
      const response = await undiciFetch(endpoint, {
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'application/dns-json' }
      });
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      const data = JSON.parse((await readBodyLimited(response, 100_000, 'DNS 响应')).toString('utf8')) as {
        Answer?: Array<{ type?: number; data?: string }>;
      };
      const address = data.Answer?.find((answer) => answer.type === 1 && answer.data && isIP(answer.data) === 4)?.data;
      if (address) return address;
    } catch {
      // Try the next resolver.
    } finally {
      clearTimeout(timer);
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
      headers: {
        'User-Agent': options.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
        ...(hostHeader ? { Host: hostHeader } : {}),
        ...(options.referer ? { Referer: options.referer } : {})
      }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`HTTP ${response.status} 缺少重定向地址`);
      await response.body?.cancel();
      return { bytes: Buffer.alloc(0), contentType: null, redirectUrl: new URL(location, logicalUrl).toString() };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    validateRemoteTarget(logicalUrl);
    const bytes = await readBodyLimited(response, Math.min(options.maxBytes ?? maxResponseBytes, maxResponseBytes), '网页响应');
    return { bytes, contentType: response.headers.get('content-type') };
  } catch (error) {
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

async function resolvePublicAddress(target: URL, timeoutMs: number): Promise<string> {
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (isBlockedNetworkAddress(hostname)) throw new Error('目标地址属于本机、局域网或保留网段，已拒绝访问。');
    return hostname;
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (error) {
    throw new Error(`无法通过系统 DNS 安全解析目标域名：${error instanceof Error ? error.message : String(error)}`);
  }
  if (addresses.some((item) => isBlockedNetworkAddress(item.address) && !isFakeIp(item.address))) {
    throw new Error('目标域名解析到了本机、局域网或保留地址，已拒绝访问。');
  }
  const fakeIp = addresses.find((item) => isFakeIp(item.address));
  const address = fakeIp ? await resolveWithDoh(hostname, timeoutMs) : addresses[0]?.address;
  if (!address) throw new Error(`无法安全解析目标域名：${hostname}`);
  if (isBlockedNetworkAddress(address)) throw new Error('目标域名解析到了本机、局域网或保留地址，已拒绝访问。');
  return address;
}

function replaceHostname(url: URL, address: string): string {
  const pinned = new URL(url);
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return pinned.toString();
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
  const proxyUrl = options.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  let currentUrl = url;
  const deadline = Date.now() + options.timeoutMs;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const target = validateRemoteTarget(currentUrl);
    const address = await resolvePublicAddress(target, Math.max(deadline - Date.now(), 1));
    let dispatcher: Dispatcher;
    let requestUrl = currentUrl;
    let hostHeader: string | undefined;
    if (proxyUrl) {
      requestUrl = replaceHostname(target, address);
      hostHeader = target.host;
      dispatcher = new ProxyAgent({
        uri: proxyUrl,
        requestTls: target.protocol === 'https:' ? { servername: target.hostname.replace(/^\[|\]$/g, '') } : undefined
      });
    } else {
      dispatcher = directAddressAgent(address);
    }
    let result: DownloadedResponse;
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error(`请求超时（${options.timeoutMs}ms）: ${url}`);
      result = await download(requestUrl, currentUrl, { ...options, timeoutMs: remainingMs }, dispatcher, hostHeader);
    } finally {
      await dispatcher.close();
    }
    if (result.redirectUrl) {
      currentUrl = result.redirectUrl;
      continue;
    }
    const charset = detectCharset(result.bytes, result.contentType);
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
