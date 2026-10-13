/** Accept bylines, not introductions, copyright notices or update metadata. */
export function cleanAuthor(raw?: string): string | undefined {
  if (!raw) return undefined;
  const value = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
    .replace(/^(?:作\s*者|著者|作家|Author)(?:\s*[:：]\s*|\s+)/i, '')
    .split(/\s*(?:最后更新|更新时间|更新[:：]|分类[:：]|类别[:：]|状态[:：]|字数[:：]|作品状态)/)[0]!
    .replace(/\s+(?:著|作者)$/, '').trim();
  if (!value || value.length > 60 || !/\p{L}/u.test(value) || /https?:|[<>\r\n]|本人获得|主角|情节|荣誉|故事讲述|作品包括|TA的作品|所写的小说|如果您|知识产权|自行上传|版权|本站|本网站|简介|^(?:类别|分类|更新|状态|点击|收藏)/i.test(value)) return undefined;
  return value;
}

/** Remove display/SEO suffixes, but retain sequel numbers and actual subtitles. */
export function canonicalBookTitle(raw: string): string {
  return raw.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .split(/[_|]|\s+[-—]\s+/)[0]!
    .replace(/\([^()]{1,32}\)(?=小说)/g, '')
    .replace(/(?:最新章节|全文免费阅读|全文阅读|在线阅读|章节目录|全部章节|无弹窗|完整版在线|小说全文|免费阅读).*$/, '')
    .replace(/\((?:全集|全[一二三四五六七八九十\d]+册|完结|完整版|[^()]*所著小说)\)/g, '')
    .replace(/(?:全集小说|全集|目录|小说)$/, '')
    .replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}
