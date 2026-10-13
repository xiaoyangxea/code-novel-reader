import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import core from '../dist/core.js';

// Revalidate positive results: excerpt/series/author-metadata checks are test
// diagnostics, not changes to the production reader's parsing behavior.
const outputName = process.argv.find((arg) => arg.startsWith('--report='))?.slice(9) ?? 'search-matrix-latest.json';
if (!/^[\w.-]+\.json$/.test(outputName)) throw new Error('Invalid report filename');
const output = path.resolve('.vscode-test', outputName);
const report = JSON.parse(await readFile(output, 'utf8'));
const options = { timeoutMs: 15000, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
  proxy: await core.detectLocalProxy(), browserRendering: false };
const canonical = core.canonicalBookTitle;
const ordinal = (value) => Number(value.match(/^第\s*(\d+)\s*[章回]/)?.[1]) || undefined;
for (const record of report.queries) {
  for (const probe of record.probes.filter((item) => item.status === 'readable')) {
    const audit = { checkedAt: new Date().toISOString(), status: 'unverified' };
    probe.audit = audit;
    try {
      const catalog = await core.loadCatalogPreview(core.likelyCatalogUrl(probe.url) ?? probe.url, options);
      audit.catalogTitle = catalog.title;
      audit.catalogAuthor = catalog.author?.slice(0, 160);
      const first = catalog.chapters[0];
      const last = catalog.chapters.at(-1);
      audit.defaultFirstTitle = first.title;
      audit.catalogDescending = Boolean(ordinal(first.title) && ordinal(last.title) && ordinal(first.title) > ordinal(last.title));
      if (audit.catalogDescending) {
        const defaultChapter = await core.loadChapter(first.url, options);
        audit.defaultBodyCharacters = defaultChapter.content.length;
        audit.defaultShortTruncatedText = defaultChapter.content.length < 500 && /(?:\.{3}|…)\s*$/.test(defaultChapter.content);
      }
      const ref = audit.catalogDescending ? last : first;
      const chapter = await core.loadChapter(ref.url, options);
      audit.verifiedChapterUrl = ref.url;
      audit.chapterTitle = chapter.title;
      audit.bodyCharacters = chapter.content.length;
      audit.hasNextChapter = Boolean(chapter.nextUrl);
      audit.shortTruncatedText = chapter.content.length < 500 && /(?:\.{3}|…)\s*$/.test(chapter.content);
      audit.authorMetadataReliable = Boolean(catalog.author && catalog.author.length <= 80);
      audit.expectedAuthorMatched = Boolean(audit.authorMetadataReliable && record.expectedAuthor && catalog.author.includes(record.expectedAuthor));
      const queryTitle = canonical(core.siteSearchQuery(record.keyword));
      audit.exactTitleMatched = record.category === '作者' || canonical(catalog.title) === queryTitle
        || canonical(catalog.title) === queryTitle.replace(/(?:全[一二三四五六七八九十\d]+册|全集)$/, '')
        || canonical(catalog.title).replace(/(?:全[一二三四五六七八九十\d]+册|全集)$/, '') === queryTitle;
      audit.status = audit.shortTruncatedText ? 'excerpt_only' : 'chapter_fetched';
      audit.strictPass = Boolean(!audit.shortTruncatedText && !audit.catalogDescending && audit.exactTitleMatched
        && (!record.expectedAuthor || audit.expectedAuthorMatched));
    } catch (error) { audit.error = core.sourceFailureLabel(error.message).slice(0, 600); audit.strictPass = false; }
    console.log(JSON.stringify({ keyword: record.keyword, url: probe.url, ...audit }));
    await writeFile(output, JSON.stringify(report, null, 2), 'utf8');
  }
}
report.auditSummary = {
  strictPass: report.queries.filter((record) => record.probes.some((item) => item.audit?.strictPass)).map((record) => record.keyword),
  excerpts: report.queries.filter((record) => record.probes.some((item) => item.audit?.shortTruncatedText || item.audit?.defaultShortTruncatedText)).map((record) => record.keyword),
  descendingCatalogs: report.queries.filter((record) => record.probes.some((item) => item.audit?.catalogDescending)).map((record) => record.keyword),
  wrongTitleOrSeries: report.queries.filter((record) => record.probes.some((item) => item.audit && !item.audit.exactTitleMatched)).map((record) => record.keyword),
  unreliableAuthorMetadata: report.queries.filter((record) => record.probes.some((item) => item.audit && !item.audit.authorMetadataReliable)).map((record) => record.keyword)
};
await writeFile(output, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report.auditSummary));
