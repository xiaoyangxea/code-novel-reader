import * as http from 'node:http';
import * as https from 'node:https';
import type { Duplex } from 'node:stream';
import { assertSafeRemoteUrl, isBlockedNetworkAddress, resolveSafeRemoteUrl, type FetchOptions } from './net';
import { effectiveProxy } from './proxy';

export interface BrowserRoute { args: string[]; close(): Promise<void>; }

/** A local CONNECT relay pins each destination before handing it to the user's proxy. */
export async function createBrowserRoute(options: FetchOptions, resolveTarget = resolveSafeRemoteUrl): Promise<BrowserRoute> {
  const rawProxy = effectiveProxy(options.proxy);
  if (!rawProxy) return { args: ['--no-proxy-server'], close: async () => undefined };
  const proxy = new URL(rawProxy);
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('浏览器代理仅支持 HTTP/HTTPS 混合端口，请在 codeNovel.proxy 中填写对应地址。');
  const transport = proxy.protocol === 'https:' ? https : http;
  const credentials = proxy.username || proxy.password
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : undefined;
  const sockets = new Set<Duplex>();
  const requests = new Set<http.ClientRequest>();
  let closed = false;
  const resolved = new Map<string, Promise<string>>();
  const addressFor = (url: string) => {
    assertSafeRemoteUrl(url);
    const hostname = new URL(url).hostname;
    let pending = resolved.get(hostname);
    if (!pending) {
      if (resolved.size >= 128) throw new Error('浏览器请求的主机数量超过上限。');
      pending = resolveTarget(url, options.timeoutMs, rawProxy).then((item) => {
        if (isBlockedNetworkAddress(item.address)) throw new Error('拒绝浏览器访问私网地址。');
        return item.address;
      });
      resolved.set(hostname, pending);
    }
    return pending;
  };
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  };
  const headers = () => credentials ? { 'Proxy-Authorization': credentials } : {};
  const server = http.createServer({ maxHeaderSize: 16_384 }, (incoming, outgoing) => {
    if (sockets.size > 64) { outgoing.writeHead(503).end(); return; }
    void (async () => {
      const url = new URL(incoming.url ?? '');
      if (url.protocol !== 'http:' || url.username || url.password) throw new Error('不支持的代理请求。');
      const address = await addressFor(url.toString());
      if (closed || outgoing.destroyed) return;
      const pinned = new URL(url);
      pinned.hostname = address.includes(':') ? `[${address}]` : address;
      const forwarded: http.OutgoingHttpHeaders = { ...incoming.headers, host: url.host };
      delete forwarded['proxy-authorization'];
      if (credentials) forwarded['proxy-authorization'] = credentials;
      delete forwarded['proxy-connection'];
      const request = transport.request({ hostname: proxy.hostname.replace(/^\[|\]$/g, ''),
        port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), method: incoming.method,
        path: pinned.toString(), headers: forwarded, timeout: options.timeoutMs }, (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      });
      requests.add(request);
      request.once('close', () => requests.delete(request));
      request.on('timeout', () => request.destroy(new Error('代理超时')));
      request.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      outgoing.on('close', () => request.destroy());
      incoming.pipe(request);
    })().catch(() => { if (!outgoing.headersSent) outgoing.writeHead(403); outgoing.end(); });
  });
  server.on('connection', (socket) => track(socket));
  server.on('connect', (incoming, client, head) => {
    if (sockets.size > 64) { client.end('HTTP/1.1 503 Unavailable\r\n\r\n'); return; }
    void (async () => {
      const url = new URL(`https://${incoming.url}/`);
      if (url.username || url.password || !url.hostname) throw new Error('无效 CONNECT 目标。');
      const address = await addressFor(url.toString());
      if (closed || client.destroyed) return;
      const target = `${address.includes(':') ? `[${address}]` : address}:${url.port || '443'}`;
      const request = transport.request({ hostname: proxy.hostname.replace(/^\[|\]$/g, ''),
        port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: target,
        headers: { Host: target, ...headers() }, timeout: options.timeoutMs });
      requests.add(request);
      request.once('close', () => requests.delete(request));
      request.on('connect', (response, tunnel, upstreamHead) => {
        if (response.statusCode !== 200 || client.destroyed) { tunnel.destroy(); client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
        track(tunnel);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) tunnel.write(head);
        if (upstreamHead.length) client.write(upstreamHead);
        client.pipe(tunnel); tunnel.pipe(client);
        client.once('close', () => tunnel.destroy());
        tunnel.once('close', () => client.destroy());
      });
      request.on('timeout', () => request.destroy(new Error('代理超时')));
      request.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
      client.once('close', () => request.destroy());
      request.end();
    })().catch(() => client.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', () => undefined);
  const endpoint = server.address();
  if (!endpoint || typeof endpoint === 'string') throw new Error('无法创建浏览器代理。');
  return {
    args: [`--proxy-server=http://127.0.0.1:${endpoint.port}`, '--proxy-bypass-list=<-loopback>', '--disable-quic'],
    close: async () => {
      if (closed) return;
      closed = true;
      for (const request of requests) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
