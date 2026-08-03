import * as iconv from 'iconv-lite';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, Dispatcher, fetch as undiciFetch, ProxyAgent } from 'undici';

export interface FetchOptions {
  timeoutMs: number;
  userAgent: string;
  referer?: string;
  proxy?: string;
}

interface DownloadedResponse {
  bytes: Buffer;
  contentType: string | null;
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

async function hostUsesFakeIp(hostname: string): Promise<boolean> {
  try {
    const addresses = await lookup(hostname, { all: true });
    return addresses.some((item) => isFakeIp(item.address));
  } catch {
    return false;
  }
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
        signal: controller.signal,
        headers: { Accept: 'application/dns-json' }
      });
      if (!response.ok) continue;
      const data = await response.json() as { Answer?: Array<{ type?: number; data?: string }> };
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

async function download(url: string, options: FetchOptions, dispatcher?: Dispatcher): Promise<DownloadedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await undiciFetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      dispatcher,
      headers: {
        'User-Agent': options.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
        ...(options.referer ? { Referer: options.referer } : {})
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return { bytes, contentType: response.headers.get('content-type') };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`请求超时（${options.timeoutMs}ms）: ${url}`);
    }
    const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
    const message = cause?.message || (error instanceof Error ? error.message : String(error));
    throw new Error(`请求失败${cause?.code ? ` [${cause.code}]` : ''}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHtml(url: string, options: FetchOptions): Promise<string> {
  const target = new URL(url);
  const proxyUrl = options.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  let dispatcher: Dispatcher | undefined;
  let usedDoh = false;
  try {
    if (proxyUrl) {
      dispatcher = new ProxyAgent(proxyUrl);
    } else if (await hostUsesFakeIp(target.hostname)) {
      const address = await resolveWithDoh(target.hostname, options.timeoutMs);
      if (address) {
        dispatcher = directAddressAgent(address);
        usedDoh = true;
      }
    }

    let result: DownloadedResponse;
    try {
      result = await download(url, options, dispatcher);
    } catch (firstError) {
      if (proxyUrl || usedDoh) throw firstError;
      const address = await resolveWithDoh(target.hostname, options.timeoutMs);
      if (!address) throw firstError;
      await dispatcher?.close();
      dispatcher = directAddressAgent(address);
      usedDoh = true;
      result = await download(url, options, dispatcher);
    }
    const charset = detectCharset(result.bytes, result.contentType);
    return iconv.decode(result.bytes, iconv.encodingExists(charset) ? charset : 'utf-8');
  } finally {
    await dispatcher?.close();
  }
}

export function resolveUrl(href: string | undefined, baseUrl: string): string | undefined {
  if (!href || href.startsWith('javascript:') || href === '#') {
    return undefined;
  }
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}
