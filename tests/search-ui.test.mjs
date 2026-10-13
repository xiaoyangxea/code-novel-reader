import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const modules = {
  state: `export const state = { snapshots: [], probes: [], imported: undefined };`,
  vscode: `
    import { state } from 'search-test:state';
    export const env = { openExternal: async () => true };
    export const Uri = { parse: (value) => value };
    export const workspace = { getConfiguration: () => ({ get: (_, fallback) => fallback }) };
    export const window = {
      showInputBox: async () => '三体',
      showQuickPick: async () => ({ mode: 'combined', names: [] }),
      createQuickPick: () => {
        let accept, hide;
        const picker = { selectedItems: [],
          onDidAccept: (fn) => { accept = fn; }, onDidHide: (fn) => { hide = fn; },
          show() {}, hide: () => hide(), dispose() {},
          set items(value) {
            state.snapshots.push(value.map(item => ({ label: item.label, detail: item.detail })));
            const ready = value.find(item => item.label === '三体（全集）' && item.detail?.includes('目录已识别'));
            if (ready) queueMicrotask(() => { picker.selectedItems = [ready]; accept(); });
          }
        }; return picker;
      }
    };`,
  adapters: `
    import { state } from 'search-test:state';
    export const likelyCatalogUrl = () => undefined;
    export const searchBooks = async () => ({ results: [], errors: [] });
    export const loadCatalogPreview = async (url) => {
      state.probes.push(url);
      return { title: url.endsWith('/original/') ? '三体（全集）' : '错误目录', author: '刘慈欣',
        chapters: [{ title: '第1章', url: url + '1' }, { title: '第2章', url: url + '2' }] };
    };`,
  web: `
    export const publicWebSearch = async (_, options) => {
      const item = (title, url) => ({ title, url, provider: '全网 · 百度', catalogStatus: 'unverified' });
      const results = [item('三体同人', 'https://novel.example/fan/'),
        item('三体商贸有限公司一审民事判决书', 'https://zh.wikisource.org/wiki/case'),
        item('三体(全集)全文免费阅读', 'https://novel.example/original/')];
      options.onSearchBatch(results, '全网 · 百度'); return results;
    };`
};
const built = await esbuild.build({
  stdin: { contents: "export { searchOnlineUI } from './src/search-ui'; export { state } from 'search-test:state';",
    resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'search-ui-test', setup(build) {
    build.onResolve({ filter: /^search-test:/ }, ({ path }) => ({ path: path.slice(12), namespace: 'search-test' }));
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'search-test' }));
    build.onResolve({ filter: /^\.\/(?:adapters|web-search)$/ }, ({ path, importer }) => {
      if (importer.endsWith('search-ui.ts')) return { path: path === './adapters' ? 'adapters' : 'web', namespace: 'search-test' };
    });
    build.onLoad({ filter: /.*/, namespace: 'search-test' }, ({ path }) => ({ contents: modules[path], loader: 'js' }));
  } }]
});
const runtime = new Module(path.resolve('tests/search-ui-runtime.cjs'));
runtime.filename = path.resolve('tests/search-ui-runtime.cjs');
runtime.paths = Module._nodeModulePaths(process.cwd());
runtime._compile(built.outputFiles[0].text, runtime.filename);

test('the actual search picker filters noise, probes the original first and imports the selected 三体', async () => {
  const { searchOnlineUI, state } = runtime.exports;
  await searchOnlineUI({}, { isBuiltInEnabled: () => false, getSources: () => [] },
    () => ({ timeoutMs: 15000, userAgent: 'test' }), async (item) => { state.imported = item; });
  assert.ok(state.snapshots.every((items) => !items.some((item) => item.label.includes('判决书'))));
  assert.equal(state.probes[0], 'https://novel.example/original/');
  assert.equal(state.imported.title, '三体（全集）');
  assert.equal(state.imported.author, '刘慈欣');
  assert.equal(state.imported.catalogStatus, 'verified');
  assert.equal(state.imported.url, 'https://novel.example/original/');
  assert.ok(state.snapshots.every((items) => !items.some((item) => item.label === '错误目录')));
});
