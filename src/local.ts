import * as path from 'node:path';
import * as cheerio from 'cheerio';
import * as iconv from 'iconv-lite';
import JSZip from 'jszip';
import { ChapterContent, ChapterRef } from './model';

export const maxLocalBookBytes = 64_000_000;
const maxEpubTextEntryBytes = 32_000_000;
const maxEpubExpandedTextBytes = 64_000_000;
const maxEpubCompressionRatio = 250;

export interface ParsedLocalBook {
  title: string;
  chapters: ChapterRef[];
  contents: ChapterContent[];
}

function assertLocalSize(bytes: Buffer): void {
  if (bytes.length > maxLocalBookBytes) throw new Error('本地小说文件超过 64 MB，已拒绝读取。');
}

export function validateEpubArchive(bytes: Buffer): void {
  assertLocalSize(bytes);
  const minimumEocd = 22;
  let eocd = -1;
  for (let offset = bytes.length - minimumEocd; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50
      && offset + minimumEocd + bytes.readUInt16LE(offset + 20) === bytes.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('EPUB ZIP 目录损坏或缺失。');
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0
    || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 EPUB。');
  }
  if (entryCount > 10_000 || centralOffset + centralSize > bytes.length) {
    throw new Error('EPUB ZIP 目录异常，已拒绝读取。');
  }
  let offset = centralOffset;
  let expandedTextBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('EPUB ZIP 中央目录损坏。');
    }
    const compressed = bytes.readUInt32LE(offset + 20);
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > bytes.length || compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new Error('EPUB ZIP 条目尺寸异常。');
    }
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (/\.(?:xhtml?|html?|xml|opf|ncx)$/i.test(name)) {
      if (uncompressed > maxEpubTextEntryBytes) throw new Error(`EPUB 正文条目过大：${name}`);
      if (uncompressed > 0 && (compressed === 0 || uncompressed / compressed > maxEpubCompressionRatio)) {
        throw new Error(`EPUB 条目压缩比异常，可能是压缩炸弹：${name}`);
      }
      expandedTextBytes += uncompressed;
      if (expandedTextBytes > maxEpubExpandedTextBytes) throw new Error('EPUB 正文展开后超过 64 MB。');
    }
    offset = next;
  }
}

function decodeText(bytes: Buffer): string {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return bytes.subarray(3).toString('utf8');
  }
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    return iconv.decode(bytes.subarray(2), 'utf16-le');
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return bytes.toString('utf8');
  } catch {
    return iconv.decode(bytes, 'gb18030');
  }
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const headingPattern = /^(?:\s*)(第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*[章回卷节篇部集][^\n]{0,60}|Chapter\s+\d+[^\n]{0,60}|序章[^\n]{0,60}|序言[^\n]{0,60}|楔子[^\n]{0,60}|引子[^\n]{0,60}|前言[^\n]{0,60}|后记[^\n]{0,60}|番外[^\n]{0,60}|尾声[^\n]{0,60})\s*$/gim;

export function parsePlainText(bytes: Buffer, filename: string): ParsedLocalBook {
  assertLocalSize(bytes);
  const text = normalizeText(decodeText(bytes));
  const matches: RegExpMatchArray[] = [];
  for (const match of text.matchAll(headingPattern)) {
    matches.push(match);
    if (matches.length >= 20_000) break;
  }
  const parts: Array<{ title: string; content: string }> = [];

  if (matches.length === 0) {
    parts.push({ title: '正文', content: text });
  } else {
    const first = matches[0];
    if (first && (first.index ?? 0) > 0) {
      const preface = text.slice(0, first.index).trim();
      if (preface.length > 30) {
        parts.push({ title: '前言', content: preface });
      }
    }
    matches.forEach((match, index) => {
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? text.length;
      const title = match[1]?.trim() || `第 ${index + 1} 章`;
      const bodyStart = start + match[0].length;
      parts.push({ title, content: text.slice(bodyStart, end).trim() });
    });
  }

  const title = path.basename(filename, path.extname(filename));
  return {
    title,
    chapters: parts.map((part, index) => ({ title: part.title, url: `local:${index}` })),
    contents: parts.map((part, index) => ({
      title: part.title,
      content: part.content,
      url: `local:${index}`
    }))
  };
}

function htmlToText(html: string): { title: string; content: string } {
  const $ = cheerio.load(html);
  $('script,style,noscript,nav,form,button').remove();
  $('br').replaceWith('\n');
  $('p,div,li,blockquote').each((_, node) => {
    $(node).append('\n');
  });
  const title = $('h1,h2,h3,title').first().text().trim();
  const rawText = $('body').length ? $('body').text() : $.root().text();
  const content = rawText
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\u00a0/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
  return { title, content };
}

function zipPath(base: string, relative: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(base), relative.split('#')[0] ?? ''));
}

export async function parseEpub(bytes: Buffer, filename: string): Promise<ParsedLocalBook> {
  validateEpubArchive(bytes);
  const zip = await JSZip.loadAsync(bytes);
  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  let opfPath: string | undefined;
  if (containerXml) {
    const $container = cheerio.load(containerXml, { xmlMode: true });
    opfPath = $container('rootfile').first().attr('full-path');
  }
  opfPath ??= Object.keys(zip.files).find((name) => name.toLowerCase().endsWith('.opf'));
  if (!opfPath) {
    throw new Error('EPUB 中找不到 OPF 清单。');
  }

  const opfXml = await zip.file(opfPath)?.async('string');
  if (!opfXml) {
    throw new Error('无法读取 EPUB 清单。');
  }
  const $opf = cheerio.load(opfXml, { xmlMode: true });
  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  $opf('manifest item').each((_, item) => {
    const id = $opf(item).attr('id');
    const href = $opf(item).attr('href');
    if (id && href) {
      manifest.set(id, {
        href,
        mediaType: $opf(item).attr('media-type') ?? '',
        properties: $opf(item).attr('properties') ?? ''
      });
    }
  });

  const navTitles = new Map<string, string>();
  const navItem = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'));
  if (navItem) {
    const navPath = zipPath(opfPath, navItem.href);
    const navHtml = await zip.file(navPath)?.async('string');
    if (navHtml) {
      const $nav = cheerio.load(navHtml);
      $nav('nav a[href]').each((_, anchor) => {
        const href = $nav(anchor).attr('href');
        if (href) {
          navTitles.set(zipPath(navPath, href), $nav(anchor).text().trim());
        }
      });
    }
  }

  const spineIds = $opf('spine itemref').toArray().map((item) => $opf(item).attr('idref')).filter((id): id is string => Boolean(id));
  const contents: ChapterContent[] = [];
  for (const id of spineIds) {
    const item = manifest.get(id);
    if (!item || !/(?:xhtml|html)/i.test(item.mediaType)) {
      continue;
    }
    const filePath = zipPath(opfPath, item.href);
    const html = await zip.file(filePath)?.async('string');
    if (!html) {
      continue;
    }
    const parsed = htmlToText(html);
    if (parsed.content.length < 20) {
      continue;
    }
    contents.push({
      title: navTitles.get(filePath) || parsed.title || `第 ${contents.length + 1} 章`,
      content: parsed.content,
      url: `local:${contents.length}`
    });
  }
  if (contents.length === 0) {
    throw new Error('EPUB 中没有可阅读的正文。');
  }
  const metadataTitle = $opf('metadata > dc\\:title, metadata > title').first().text().trim();
  const title = metadataTitle || path.basename(filename, path.extname(filename));
  return {
    title,
    chapters: contents.map((chapter, index) => ({ title: chapter.title, url: `local:${index}` })),
    contents
  };
}
