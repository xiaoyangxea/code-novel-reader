import * as iconv from 'iconv-lite';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

const blockIndexMagic = 0xc103cac3;
const blockFileMagic = 0xc104cac3;
const blockIndexHeaderSize = 368;
const blockFileHeaderSize = 8192;
const entryStoreMetadataSize = 96;
const simpleInitialMagic = 0xfcfb6d1ba7725c30n;
const simpleFinalMagic = 0xf4fa6f45970d41d8n;
const maximumIndexBytes = 8_000_000;
const maximumIndexEntries = 1_000_000;
const maximumKeyBytes = 32_768;
const maximumCacheFiles = 50_000;

interface CacheAddress {
  raw: number;
  initialized: boolean;
  fileType: number;
  externalFileNumber: number;
  contiguousBlocks: number;
  fileSelector: number;
  blockNumber: number;
  reservedBits: number;
}

interface BlockFileInfo {
  entrySize: number;
  size: number;
}

interface EntryStore {
  next: CacheAddress;
  key: string;
  state: number;
  dataSizes: number[];
  dataAddresses: CacheAddress[];
}

function decodeAddress(value: number): CacheAddress {
  const unsigned = value >>> 0;
  return {
    raw: unsigned,
    initialized: (unsigned & 0x80000000) !== 0,
    fileType: (unsigned >>> 28) & 0x7,
    externalFileNumber: unsigned & 0x0fffffff,
    contiguousBlocks: 1 + ((unsigned >>> 24) & 0x3),
    fileSelector: (unsigned >>> 16) & 0xff,
    blockNumber: unsigned & 0xffff,
    reservedBits: unsigned & 0x0c000000
  };
}

function normalizedUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function urlFromCacheKey(key: string): string | undefined {
  const match = key.match(/(?:^|\s)(https?:\/\/\S+)$/i);
  return normalizedUrl(match?.[1] ?? key);
}

function checkedRange(buffer: Buffer, offset: number, length: number): Buffer {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
    || offset > buffer.length || length > buffer.length - offset) {
    throw new Error('Chromium 缓存记录超出文件边界。');
  }
  return buffer.subarray(offset, offset + length);
}

async function readSmallFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size > maximumBytes) throw new Error('Chromium 缓存文件大小异常。');
  return readFile(filePath);
}

class BlockCacheReader {
  private readonly blockFiles = new Map<number, BlockFileInfo>();

  constructor(private readonly directory: string, private readonly maximumBodyBytes: number) {}

  private async blockFileInfo(fileSelector: number, expectedFileType: number): Promise<BlockFileInfo> {
    const cached = this.blockFiles.get(fileSelector);
    if (cached) return cached;
    const filePath = path.join(this.directory, `data_${fileSelector}`);
    const handle = await open(filePath, 'r');
    try {
      const header = Buffer.alloc(80);
      const read = await handle.read(header, 0, header.length, 0);
      if (read.bytesRead !== header.length || header.readUInt32LE(0) !== blockFileMagic) {
        throw new Error('Chromium 块缓存文件头无效。');
      }
      const entrySize = header.readInt32LE(12);
      const expectedSize = expectedFileType === 2 ? 256 : expectedFileType === 3 ? 1024 : 4096;
      if (entrySize !== expectedSize) throw new Error('Chromium 块缓存记录尺寸无效。');
      const fileInfo = await handle.stat();
      if (!fileInfo.isFile() || fileInfo.size < blockFileHeaderSize) throw new Error('Chromium 块缓存文件已截断。');
      const result = { entrySize, size: fileInfo.size };
      this.blockFiles.set(fileSelector, result);
      return result;
    } finally {
      await handle.close();
    }
  }

  private async readAddress(address: CacheAddress, requestedBytes?: number): Promise<Buffer> {
    if (!address.initialized) throw new Error('Chromium 缓存地址未初始化。');
    const limit = requestedBytes ?? Math.max(this.maximumBodyBytes, maximumKeyBytes);
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > Math.max(this.maximumBodyBytes, maximumKeyBytes)) {
      throw new Error('Chromium 缓存记录尺寸无效。');
    }
    if (address.fileType === 0) {
      const filePath = path.join(this.directory, `f_${address.externalFileNumber.toString(16).padStart(6, '0')}`);
      const info = await stat(filePath);
      const length = requestedBytes ?? info.size;
      if (!info.isFile() || info.size < length || length > limit) throw new Error('Chromium 外部缓存文件尺寸无效。');
      const handle = await open(filePath, 'r');
      try {
        const result = Buffer.alloc(length);
        const read = await handle.read(result, 0, length, 0);
        if (read.bytesRead !== length) throw new Error('Chromium 外部缓存文件已截断。');
        return result;
      } finally {
        await handle.close();
      }
    }
    if (address.fileType < 2 || address.fileType > 4 || address.reservedBits !== 0) {
      throw new Error('Chromium 块缓存地址类型无效。');
    }
    const info = await this.blockFileInfo(address.fileSelector, address.fileType);
    const allocatedBytes = info.entrySize * address.contiguousBlocks;
    const length = requestedBytes ?? allocatedBytes;
    if (length > allocatedBytes || length > limit) throw new Error('Chromium 块缓存记录尺寸无效。');
    const offset = blockFileHeaderSize + info.entrySize * address.blockNumber;
    if (!Number.isSafeInteger(offset) || offset < blockFileHeaderSize || offset + length > info.size) {
      throw new Error('Chromium 块缓存地址超出文件边界。');
    }
    const handle = await open(path.join(this.directory, `data_${address.fileSelector}`), 'r');
    try {
      const result = Buffer.alloc(length);
      const read = await handle.read(result, 0, length, offset);
      if (read.bytesRead !== length) throw new Error('Chromium 块缓存记录已截断。');
      return result;
    } finally {
      await handle.close();
    }
  }

  private async readEntry(address: CacheAddress): Promise<EntryStore> {
    if (address.fileType !== 2 || address.reservedBits !== 0) throw new Error('Chromium 缓存条目地址无效。');
    const raw = await this.readAddress(address);
    if (raw.length < entryStoreMetadataSize) throw new Error('Chromium 缓存条目已截断。');
    const state = raw.readInt32LE(20);
    const keyLength = raw.readInt32LE(32);
    if (keyLength <= 0 || keyLength > maximumKeyBytes) throw new Error('Chromium 缓存键长度无效。');
    const longKeyAddress = decodeAddress(raw.readUInt32LE(36));
    const keyBytes = longKeyAddress.initialized
      ? await this.readAddress(longKeyAddress, keyLength)
      : checkedRange(raw, entryStoreMetadataSize, keyLength);
    const dataSizes = [0, 1, 2, 3].map((index) => raw.readInt32LE(40 + index * 4));
    if (dataSizes.some((size) => size < 0 || size > this.maximumBodyBytes)) {
      throw new Error('Chromium 缓存数据流尺寸无效。');
    }
    return {
      next: decodeAddress(raw.readUInt32LE(4)),
      key: keyBytes.toString('utf8'),
      state,
      dataSizes,
      dataAddresses: [0, 1, 2, 3].map((index) => decodeAddress(raw.readUInt32LE(56 + index * 4)))
    };
  }

  async responseBodies(targetUrls: ReadonlySet<string>): Promise<Map<string, Buffer>> {
    const bodies = new Map<string, Buffer>();
    const indexPath = path.join(this.directory, 'index');
    const index = await readSmallFile(indexPath, maximumIndexBytes);
    if (index.length < blockIndexHeaderSize || index.readUInt32LE(0) !== blockIndexMagic) return bodies;
    const tableLength = index.readInt32LE(28) || 0x10000;
    if (tableLength <= 0 || tableLength > maximumIndexEntries
      || blockIndexHeaderSize + tableLength * 4 > index.length) return bodies;
    const visited = new Set<number>();
    for (let indexPosition = 0; indexPosition < tableLength; indexPosition += 1) {
      let rawAddress = index.readUInt32LE(blockIndexHeaderSize + indexPosition * 4);
      while ((rawAddress & 0x80000000) !== 0 && !visited.has(rawAddress)) {
        visited.add(rawAddress);
        let entry: EntryStore;
        try {
          entry = await this.readEntry(decodeAddress(rawAddress));
        } catch {
          break;
        }
        const entryUrl = urlFromCacheKey(entry.key);
        if (entry.state === 0 && entryUrl && targetUrls.has(entryUrl) && !bodies.has(entryUrl)) {
          const bodySize = entry.dataSizes[1] ?? 0;
          const bodyAddress = entry.dataAddresses[1];
          if (bodySize > 0 && bodyAddress?.initialized) {
            bodies.set(entryUrl, await this.readAddress(bodyAddress, bodySize));
            if (bodies.size === targetUrls.size) return bodies;
          }
        }
        rawAddress = entry.next.initialized ? entry.next.raw : 0;
      }
    }
    return bodies;
  }
}

function simpleEof(buffer: Buffer, offset: number, size: 20 | 24): { flags: number; streamSize: number } | undefined {
  if (offset < 0 || offset + size > buffer.length || buffer.readBigUInt64LE(offset) !== simpleFinalMagic) return undefined;
  return { flags: buffer.readUInt32LE(offset + 8), streamSize: buffer.readUInt32LE(offset + 16) };
}

function simpleResponseBody(
  buffer: Buffer,
  targetUrls: ReadonlySet<string>
): { url: string; body: Buffer } | undefined {
  if (buffer.length < 64 || buffer.readBigUInt64LE(0) !== simpleInitialMagic) return undefined;
  const keyLength = buffer.readUInt32LE(12);
  if (keyLength <= 0 || keyLength > maximumKeyBytes) return undefined;
  for (const headerSize of [24, 20] as const) {
    const keyEnd = headerSize + keyLength;
    if (keyEnd > buffer.length) continue;
    const key = checkedRange(buffer, headerSize, keyLength).toString('latin1');
    const url = urlFromCacheKey(key);
    if (!url || !targetUrls.has(url)) continue;
    const streamZeroEofOffset = buffer.length - headerSize;
    const streamZeroEof = simpleEof(buffer, streamZeroEofOffset, headerSize);
    if (!streamZeroEof) continue;
    const hashSize = (streamZeroEof.flags & 2) !== 0 ? 32 : 0;
    const streamZeroStart = streamZeroEofOffset - hashSize - streamZeroEof.streamSize;
    const streamOneEofOffset = streamZeroStart - headerSize;
    const streamOneEof = simpleEof(buffer, streamOneEofOffset, headerSize);
    if (!streamOneEof || streamOneEofOffset < keyEnd) continue;
    const streamOneLength = streamOneEofOffset - keyEnd;
    if (streamOneLength <= 0) continue;
    return { url, body: checkedRange(buffer, keyEnd, streamOneLength) };
  }
  return undefined;
}

async function readSimpleCache(
  directory: string,
  targetUrls: ReadonlySet<string>,
  maximumBodyBytes: number
): Promise<Map<string, Buffer>> {
  const bodies = new Map<string, Buffer>();
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > maximumCacheFiles) return bodies;
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f]{16}_0$/i.test(entry.name)) continue;
    try {
      const buffer = await readSmallFile(path.join(directory, entry.name), maximumBodyBytes + maximumKeyBytes + 4096);
      const result = simpleResponseBody(buffer, targetUrls);
      if (result && result.body.length <= maximumBodyBytes) {
        bodies.set(result.url, result.body);
        if (bodies.size === targetUrls.size) return bodies;
      }
    } catch {
      // Cache files may be concurrently replaced while Chrome is writing them.
    }
  }
  return bodies;
}

function looksLikeHtml(buffer: Buffer): boolean {
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('latin1');
  return /<!doctype\s+html|<html\b|<head\b|<body\b/i.test(head);
}

function decompressResponse(buffer: Buffer, maximumBodyBytes: number): Buffer | undefined {
  if (buffer.length > maximumBodyBytes) return undefined;
  if (looksLikeHtml(buffer)) return buffer;
  const options = { maxOutputLength: maximumBodyBytes };
  const attempts: Array<() => Buffer> = [];
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) attempts.push(() => gunzipSync(buffer, options));
  attempts.push(() => brotliDecompressSync(buffer, options));
  attempts.push(() => inflateSync(buffer, options));
  for (const attempt of attempts) {
    try {
      const decoded = attempt();
      if (decoded.length <= maximumBodyBytes && looksLikeHtml(decoded)) return decoded;
    } catch {
      // Try the next content encoding.
    }
  }
  return undefined;
}

function decodeHtml(buffer: Buffer): string {
  const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('latin1');
  const declared = head.match(/<meta[^>]+charset\s*=\s*["']?([^"'\s/>;]+)/i)?.[1]
    ?? head.match(/<meta[^>]+content=["'][^"']*charset=([^"'\s;]+)/i)?.[1];
  const normalized = declared?.toLowerCase() === 'gb2312' || declared?.toLowerCase() === 'gbk'
    ? 'gb18030'
    : declared?.toLowerCase();
  let encoding = normalized;
  if (!encoding) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      encoding = 'utf-8';
    } catch {
      encoding = 'gb18030';
    }
  }
  return iconv.decode(buffer, iconv.encodingExists(encoding) ? encoding : 'utf-8');
}

function candidateCacheDirectories(root: string): string[] {
  return [
    root,
    path.join(root, 'Cache_Data'),
    path.join(root, 'Default', 'Cache'),
    path.join(root, 'Default', 'Cache', 'Cache_Data')
  ];
}

export async function readChromiumCachedHtmlBatch(
  cacheRoot: string,
  targetUrls: readonly string[],
  maximumBodyBytes: number
): Promise<Map<string, string>> {
  const normalizedTargets = new Set(targetUrls.flatMap((targetUrl) => {
    const normalized = normalizedUrl(targetUrl);
    return normalized ? [normalized] : [];
  }));
  const htmlByUrl = new Map<string, string>();
  if (normalizedTargets.size === 0 || maximumBodyBytes <= 0 || maximumBodyBytes > 8_000_000) return htmlByUrl;
  for (const directory of candidateCacheDirectories(path.resolve(cacheRoot))) {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const pending = new Set([...normalizedTargets].filter((targetUrl) => !htmlByUrl.has(targetUrl)));
      let compressed = new Map<string, Buffer>();
      if (entries.some((entry) => entry.isFile() && entry.name === 'data_0')
        && entries.some((entry) => entry.isFile() && entry.name === 'index')) {
        compressed = await new BlockCacheReader(directory, maximumBodyBytes).responseBodies(pending);
      } else if (entries.some((entry) => entry.isFile() && /^[0-9a-f]{16}_0$/i.test(entry.name))) {
        compressed = await readSimpleCache(directory, pending, maximumBodyBytes);
      }
      for (const [targetUrl, body] of compressed) {
        const decoded = decompressResponse(body, maximumBodyBytes);
        if (decoded) htmlByUrl.set(targetUrl, decodeHtml(decoded));
      }
      if (htmlByUrl.size === normalizedTargets.size) break;
    } catch {
      // The browser may still be updating its cache. Callers poll until timeout.
    }
  }
  return htmlByUrl;
}

export async function readChromiumCachedHtml(
  cacheRoot: string,
  targetUrl: string,
  maximumBodyBytes: number
): Promise<string | undefined> {
  const normalizedTarget = normalizedUrl(targetUrl);
  if (!normalizedTarget) return undefined;
  return (await readChromiumCachedHtmlBatch(cacheRoot, [normalizedTarget], maximumBodyBytes)).get(normalizedTarget);
}
