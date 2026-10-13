import core from '../dist/core.js';

// Read-only live regression check; log titles/counts, never chapter body text.
const keyword = process.argv[2] || '三体';
if (keyword.length > 100 || /[\u0000-\u001f\u007f]/.test(keyword)) throw new Error('Invalid keyword');
const options = { timeoutMs: 15000,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
  proxy: await core.detectLocalProxy(), browserRendering: false,
  onSearchBatch: (items, provider, error) => console.log(JSON.stringify({ provider, count: items.length, error,
    titles: items.map((item) => item.title) })) };
const web = await core.publicWebSearch(keyword, options).catch((error) => {
  console.log(JSON.stringify({ error: error.message })); return [];
});
const candidates = core.rankedSearchCandidates(web, keyword, 200);
console.log(JSON.stringify({ keyword, candidates: candidates.map((item) => ({ title: item.title, url: item.url })) }));
if (process.argv.includes('--probe')) {
  let cursor = 0;
  const shortlist = candidates.slice(0, 4);
  const worker = async () => { while (cursor < shortlist.length) {
    const item = shortlist[cursor++];
    try {
      const catalog = await core.loadCatalogPreview(core.likelyCatalogUrl(item.url) ?? item.url, { ...options, timeoutMs: 7000 });
      if (!core.matchesSearchKeyword({ title: catalog.title, author: catalog.author, url: item.url, provider: item.provider }, keyword)) throw new Error('目录标题或作者与搜索词不匹配');
      const chapter = await core.loadChapter(catalog.chapters[0].url, { ...options, timeoutMs: 7000 });
      console.log(JSON.stringify({ url: item.url, title: catalog.title, author: catalog.author,
        chapters: catalog.chapters.length, bodyCharacters: chapter.content.length, status: 'chapter_fetched' }));
    } catch (error) { console.log(JSON.stringify({ url: item.url, status: 'unverified', error: error.message })); }
  } };
  await Promise.all([worker(), worker()]);
}
