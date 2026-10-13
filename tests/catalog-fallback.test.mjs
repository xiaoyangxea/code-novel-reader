import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const mocks = {
  state: 'export const state = { html: "", rendered: "", requests: 0, renders: 0, finalUrl: undefined, pages: undefined };',
  net: `export { resolveUrl, RateLimitedError } from './src/net';
    import { state } from 'catalog-test:state';
    export const fetchHtml = async (url, options) => { state.requests++; options.onFinalUrl?.(state.finalUrl ?? url); return state.pages?.[url] ?? state.html; };`,
  browser: `import { state } from 'catalog-test:state';
    export class BrowserVerificationRequiredError extends Error {}
    export class BrowserAutomationBlockedError extends Error {}
    export const isBrowserChallengeHtml = () => false;
    export const renderHtmlWithBrowser = async () => { state.renders++; return state.rendered; };
    export const renderHtmlBatchWithBrowser = async () => new Map();`
};
const built = await esbuild.build({ stdin: {
  contents: "export { loadCatalogPreview, loadChapter } from './src/adapters'; export { state } from 'catalog-test:state'; export { RestrictedChapterError } from './src/chapter-quality';",
  resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'catalog-fallback-double', setup(build) {
    build.onResolve({ filter: /^catalog-test:/ }, ({ path }) => ({ path: path.slice(13), namespace: 'catalog-test' }));
    build.onResolve({ filter: /^\.\/(?:net|browser)$/ }, ({ path, importer }) => {
      if (importer.endsWith('adapters.ts')) return { path: path.slice(2), namespace: 'catalog-test' };
    });
    build.onLoad({ filter: /.*/, namespace: 'catalog-test' }, ({ path }) => ({ contents: mocks[path], resolveDir: process.cwd(), loader: 'js' }));
  } }] });
const runtime = new Module(path.resolve('tests/catalog-fallback-runtime.cjs'));
runtime.filename = path.resolve('tests/catalog-fallback-runtime.cjs');
runtime.paths = Module._nodeModulePaths(process.cwd());
runtime._compile(built.outputFiles[0].text, runtime.filename);
const { state, loadCatalogPreview, loadChapter, RestrictedChapterError } = runtime.exports;
const options = { timeoutMs: 1000, userAgent: 'test', browserRendering: true };
const catalogHtml = '<h1>测试书</h1><div id="list"><a href="1.html">第一章 开始</a><a href="2.html">第二章 后续</a></div>';
const reset = () => Object.assign(state, { html: '<html><main id="app"></main></html>', rendered: catalogHtml, requests: 0, renders: 0, finalUrl: undefined, pages: undefined });

test('an empty static catalog triggers browser fallback and validates the rendered catalog', async () => {
  reset();
  const catalog = await loadCatalogPreview('https://novel.example/book/1/', options);
  assert.equal(catalog.chapters.length, 2);
  assert.equal(state.requests, 1);
  assert.equal(state.renders, 1);
});

test('browser-disabled or still-empty catalogs fail instead of being treated as successful', async () => {
  reset();
  await assert.rejects(loadCatalogPreview('https://novel.example/book/2/', { ...options, browserRendering: false }), /有效目录/);
  assert.equal(state.renders, 0);
  reset(); state.rendered = '<html><h1>仅介绍</h1></html>';
  await assert.rejects(loadCatalogPreview('https://empty.example/book/3/', options), /有效目录/);
  assert.equal(state.renders, 1);
});

test('relative chapter links follow a validated HTTP redirect destination, not the original host', async () => {
  reset(); state.html = catalogHtml; state.finalUrl = 'https://mirror.example/books/9/';
  const catalog = await loadCatalogPreview('https://redirect.example/book/4/', options);
  assert.equal(catalog.chapters[0].url, 'https://mirror.example/books/9/1.html');
  assert.equal(state.renders, 0);
});

test('restricted chapters are reported without trying a browser or caching a fragment', async () => {
  reset(); state.html = '<h1>第89章</h1><div id="article">' + '这是原创的测试摘要。'.repeat(15) + '...</div>';
  await assert.rejects(loadChapter('https://book.qq.com/book-read/695233/89', options), RestrictedChapterError);
  assert.equal(state.renders, 0);
});

test('next chapter mislabeled 下一页 is not merged into the current chapter or followed twenty times', async () => {
  reset();
  const first = '这是第一章的原创测试内容。'.repeat(20);
  const second = '这是第二章的原创测试内容。'.repeat(20);
  state.pages = {
    'https://paging.example/book/1.html': `<h1>第一章 开始</h1><div id="content">${first}</div><a href="2.html">下一页</a>`,
    'https://paging.example/book/2.html': `<h1>第二章 后续</h1><div id="content">${second}</div><a href="3.html">下一页</a>`
  };
  const result = await loadChapter('https://paging.example/book/1.html', { ...options, browserRendering: false });
  assert.equal(result.nextUrl, 'https://paging.example/book/2.html');
  assert.equal(result.content, first);
  assert.equal(state.requests, 2);
});
