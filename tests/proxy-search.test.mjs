import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import { fetch } from 'undici';
import core from '../dist/core.js';

async function localServer(handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  } };
}

test('ordinary proxy requests pin only CONNECT while retaining the logical Host', async () => {
  let authority;
  let requestText;
  const upstream = await localServer();
  upstream.server.on('connect', (request, socket) => {
    authority = request.url;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', (chunk) => {
      requestText = chunk.toString();
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
  });
  const agent = core.pinnedProxyAgent(upstream.url, '93.184.216.34');
  try {
    const response = await fetch('http://example.com/catalog?book=1', { dispatcher: agent });
    assert.equal(await response.text(), 'ok');
    assert.equal(authority, '93.184.216.34:80');
    assert.match(requestText, /host: example\.com/i);
    assert.match(requestText, /^GET \/catalog\?book=1 HTTP/);
  } finally { await agent.close(); await upstream.close(); }
});

test('browser relay forwards HTTP Host and raw CONNECT data, and rejects loopback', async () => {
  const requests = [];
  const upstream = await localServer((req, res) => {
    requests.push({ url: req.url, host: req.headers.host }); res.end('ok');
  });
  upstream.server.on('connect', (request, socket) => {
    requests.push({ url: request.url });
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', (chunk) => socket.end(`echo:${chunk.toString()}`));
  });
  const route = await core.createBrowserRoute({ proxy: upstream.url, timeoutMs: 1000, userAgent: 'test' },
    async (url) => ({ url, address: '93.184.216.34' }));
  const endpoint = new URL(route.args.find((arg) => arg.startsWith('--proxy-server=')).slice(15));
  const httpGet = (target) => new Promise((resolve, reject) => {
    http.get({ host: endpoint.hostname, port: endpoint.port, path: target }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  try {
    assert.equal(await httpGet('http://example.com/book/1'), 200);
    assert.deepEqual(requests[0], { url: 'http://93.184.216.34/book/1', host: 'example.com' });
    const echoed = await new Promise((resolve, reject) => {
      const request = http.request({ host: endpoint.hostname, port: endpoint.port, method: 'CONNECT', path: 'example.com:443' });
      request.on('connect', (response, socket) => {
        assert.equal(response.statusCode, 200);
        socket.once('data', (chunk) => { resolve(chunk.toString()); socket.destroy(); });
        socket.write('opaque-bytes');
      });
      request.on('error', reject); request.end();
    });
    assert.equal(echoed, 'echo:opaque-bytes');
    assert.equal(requests[1].url, '93.184.216.34:443');
    assert.equal(await httpGet('http://127.0.0.1/private'), 403);
    assert.equal(requests.length, 2);
    assert.ok(route.args.includes('--proxy-bypass-list=<-loopback>'));
    assert.ok(!route.args.includes('--no-proxy-server'));
  } finally { await route.close(); await upstream.close(); }
});

test('web search decodes tracking links without accepting private-network results', () => {
  const encoded = 'a1' + Buffer.from('https://novel.example/book/1/').toString('base64url');
  const html = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=${encoded}">测试小说</a></h2></li>
    <li class="b_algo"><h2><a href="http://127.0.0.1/secret">错误链接</a></h2></li>`;
  const results = core.parseWebSearchHtml(html, 'https://cn.bing.com/search', 'bing');
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://novel.example/book/1/');
  const ddg = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnovel.example%2Fbook%2F2%2F">目录</a>';
  assert.equal(core.parseWebSearchHtml(ddg, 'https://html.duckduckgo.com/', 'duckduckgo')[0].url, 'https://novel.example/book/2/');
});

test('catalog pagination and search cannot treat category navigation as books', () => {
  const html = '<a href="/fenlei/1/1/">分类</a><a href="/3383/p-2.html">下一页</a><a href="/4000/p-2.html">别的书</a>';
  assert.deepEqual(core.catalogPageUrls(html, 'https://www.sudugu.cc/3383/'), ['https://www.sudugu.cc/3383/p-2.html']);
  assert.deepEqual(core.parseSearchHtml('<a href="/sort/1_1/">玄幻魔法</a>', 'https://example.com/search', 'test'), []);
});

test('Clash detection reads only a top-level valid proxy port', () => {
  assert.equal(core.parseClashProxyPort('mixed-port: 7897\nsocks-port: 7898\n'), 7897);
  assert.equal(core.parseClashProxyPort('port: 7890\n'), 7890);
  assert.equal(core.parseClashProxyPort('mixed-port: 99999\n'), undefined);
  assert.equal(core.parseClashProxyPort('nodes:\n  mixed-port: 7897\n'), undefined);
  assert.equal(core.isBlockedNetworkAddress('2001:2::56'), true);
});

test('HTTP 429 cools down only the affected origin without repeating requests or disabling other sources', async () => {
  const authorities = [];
  const upstream = await localServer();
  upstream.server.on('connect', (request, socket) => {
    authorities.push(request.url);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end(request.url.startsWith('93.184.216.34:')
      ? 'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
      : 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
  });
  const options = { timeoutMs: 1000, userAgent: 'test', proxy: upstream.url };
  try {
    await assert.rejects(core.fetchHtml('http://93.184.216.34/search', options), core.RateLimitedError);
    await assert.rejects(core.fetchHtml('http://93.184.216.34/book/1', options), /限流冷却/);
    assert.equal(authorities.length, 1);
    assert.equal(await core.fetchHtml('http://93.184.216.35/search', options), 'ok');
    assert.equal(authorities.length, 2);
  } finally { await upstream.close(); }
});

test('author index expansion has a shared two-request budget and does not follow private or cross-origin book links', async () => {
  let calls = 0;
  const upstream = await localServer();
  upstream.server.on('connect', (_, socket) => {
    calls += 1;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => {
      const body = '<h1>唐家三少</h1><ul class="search-list"><li><a href="/book/1/">斗罗大陆</a></li><li><a href="http://127.0.0.1/book/1/">坏链接</a></li></ul>';
      socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body);
    });
  });
  const index = (address) => ({ title: '唐家三少的全部作品', url: `http://${address}/author/tang/`, provider: 'test', kind: 'author-index' });
  try {
    const options = { timeoutMs: 1000, userAgent: 'test', proxy: upstream.url };
    const budget = { remaining: 2 };
    const results = await core.expandAuthorIndexes(['93.184.216.36', '93.184.216.37', '93.184.216.38'].map(index), '唐家三少', options, budget);
    assert.equal(calls, 2);
    assert.equal(results.length, 2);
    assert.ok(results.every((item) => item.title === '斗罗大陆'));
    assert.equal(budget.remaining, 0);
    assert.deepEqual(await core.expandAuthorIndexes([index('93.184.216.38')], '唐家三少', { ...options, shouldContinue: () => false }), []);
    assert.equal(calls, 2);
  } finally { await upstream.close(); }
});

test('source status distinguishes local connectivity, TLS, verification and parsing failures', () => {
  assert.match(core.sourceFailureLabel('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'), /^证书校验失败/);
  assert.match(core.sourceFailureLabel('UND_ERR_CONNECT_TIMEOUT'), /^网络或代理连接失败/);
  assert.match(core.sourceFailureLabel('Cloudflare challenge'), /^需要验证/);
  assert.match(core.sourceFailureLabel('未识别目录'), /^解析未通过/);
});

test('browser proxy credentials stay off launch arguments and resolved private addresses are rejected', async () => {
  const authorizations = [];
  const upstream = await localServer((req, res) => {
    authorizations.push(req.headers['proxy-authorization']); res.end('ok');
  });
  const proxy = new URL(upstream.url);
  proxy.username = 'local-user'; proxy.password = 'local-secret';
  const route = await core.createBrowserRoute({ proxy: proxy.toString(), timeoutMs: 1000, userAgent: 'test' },
    async (url) => ({ url, address: url.includes('private.example') ? '10.0.0.1' : '93.184.216.34' }));
  const endpoint = new URL(route.args.find((arg) => arg.startsWith('--proxy-server=')).slice(15));
  const get = (target) => new Promise((resolve, reject) => {
    http.get({ host: endpoint.hostname, port: endpoint.port, path: target }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  try {
    assert.equal(await get('http://example.com/'), 200);
    assert.equal(authorizations[0], `Basic ${Buffer.from('local-user:local-secret').toString('base64')}`);
    assert.equal(await get('http://private.example/'), 403);
    assert.equal(authorizations.length, 1);
    assert.ok(!route.args.join(' ').includes('local-secret'));
  } finally { await route.close(); await route.close(); await upstream.close(); }
});
