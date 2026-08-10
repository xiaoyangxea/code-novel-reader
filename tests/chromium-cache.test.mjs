import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { brotliCompressSync } from 'node:zlib';
import { readChromiumCachedHtml, readChromiumCachedHtmlBatch } from '../dist/core.js';

const blockIndexMagic = 0xc103cac3;
const blockFileMagic = 0xc104cac3;
const simpleInitialMagic = 0xfcfb6d1ba7725c30n;
const simpleFinalMagic = 0xf4fa6f45970d41d8n;

function blockAddress(fileType, fileSelector, blockNumber = 0, blocks = 1) {
  return (0x80000000 | (fileType << 28) | ((blocks - 1) << 24) | (fileSelector << 16) | blockNumber) >>> 0;
}

function blockFile(entrySize, payload) {
  const result = Buffer.alloc(8192 + entrySize);
  result.writeUInt32LE(blockFileMagic, 0);
  result.writeUInt32LE(0x20000, 4);
  result.writeInt32LE(entrySize, 12);
  payload.copy(result, 8192);
  return result;
}

async function createBlockCache(root, url, html) {
  const directory = path.join(root, 'Default', 'Cache', 'Cache_Data');
  await mkdir(directory, { recursive: true });
  const body = brotliCompressSync(Buffer.from(html));
  assert.ok(body.length < 1024);
  const key = Buffer.from(`1/0/_dk_https://example.com https://example.com ${url}`);
  const entry = Buffer.alloc(256);
  entry.writeInt32LE(0, 20);
  entry.writeInt32LE(key.length, 32);
  entry.writeInt32LE(body.length, 44);
  entry.writeUInt32LE(blockAddress(3, 2), 60);
  key.copy(entry, 96);

  const index = Buffer.alloc(368 + 4);
  index.writeUInt32LE(blockIndexMagic, 0);
  index.writeUInt32LE(0x30000, 4);
  index.writeInt32LE(1, 8);
  index.writeInt32LE(1, 28);
  index.writeUInt32LE(blockAddress(2, 1), 368);
  await Promise.all([
    writeFile(path.join(directory, 'index'), index),
    writeFile(path.join(directory, 'data_0'), blockFile(36, Buffer.alloc(36))),
    writeFile(path.join(directory, 'data_1'), blockFile(256, entry)),
    writeFile(path.join(directory, 'data_2'), blockFile(1024, body))
  ]);
}

function simpleEof(streamSize) {
  const result = Buffer.alloc(24);
  result.writeBigUInt64LE(simpleFinalMagic, 0);
  result.writeUInt32LE(streamSize, 16);
  return result;
}

async function createSimpleCache(root, url, html, filename = '0123456789abcdef_0') {
  const directory = path.join(root, 'Default', 'Cache', 'Cache_Data');
  await mkdir(directory, { recursive: true });
  const key = Buffer.from(url, 'latin1');
  const body = brotliCompressSync(Buffer.from(html));
  const header = Buffer.alloc(24);
  header.writeBigUInt64LE(simpleInitialMagic, 0);
  header.writeUInt32LE(8, 8);
  header.writeUInt32LE(key.length, 12);
  const cacheFile = Buffer.concat([header, key, body, simpleEof(body.length), simpleEof(0)]);
  await writeFile(path.join(directory, filename), cacheFile);
}

test('reads an exact URL from a Chromium block-file cache and decompresses Brotli HTML', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'code-novel-block-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = 'https://example.com/book/1/2.html';
  const html = `<html><head><title>第二章</title></head><body><div id="content">${'正文。'.repeat(300)}</div></body></html>`;
  await createBlockCache(root, url, html);

  assert.equal(await readChromiumCachedHtml(root, url, 1_000_000), html);
  assert.equal(await readChromiumCachedHtml(root, 'https://example.com/book/1/3.html', 1_000_000), undefined);
});

test('reads Chromium simple-cache entries used on macOS and Linux', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'code-novel-simple-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = 'https://example.com/book/9/8.html';
  const html = `<html><head><title>第八章</title></head><body>${'内容。'.repeat(300)}</body></html>`;
  await createSimpleCache(root, url, html);

  assert.equal(await readChromiumCachedHtml(root, url, 1_000_000), html);
});

test('reads multiple exact URLs in one Chromium cache scan', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'code-novel-batch-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstUrl = 'https://example.com/book/9/1.html';
  const secondUrl = 'https://example.com/book/9/2.html';
  const firstHtml = `<html><body>${'第一页正文。'.repeat(200)}</body></html>`;
  const secondHtml = `<html><body>${'第二页正文。'.repeat(200)}</body></html>`;
  await createSimpleCache(root, firstUrl, firstHtml, '0123456789abcdef_0');
  await createSimpleCache(root, secondUrl, secondHtml, 'fedcba9876543210_0');

  const result = await readChromiumCachedHtmlBatch(root, [firstUrl, secondUrl], 1_000_000);
  assert.equal(result.get(firstUrl), firstHtml);
  assert.equal(result.get(secondUrl), secondHtml);
});

test('rejects malformed cache addresses without reading outside the cache file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'code-novel-bad-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = 'https://example.com/book/1/2.html';
  await createBlockCache(root, url, '<html><body>safe</body></html>');
  const directory = path.join(root, 'Default', 'Cache', 'Cache_Data');
  const index = Buffer.alloc(368 + 4);
  index.writeUInt32LE(blockIndexMagic, 0);
  index.writeInt32LE(1, 28);
  index.writeUInt32LE(blockAddress(2, 1, 65535), 368);
  await writeFile(path.join(directory, 'index'), index);

  assert.equal(await readChromiumCachedHtml(root, url, 1_000_000), undefined);
});
