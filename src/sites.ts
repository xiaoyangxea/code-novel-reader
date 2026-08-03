export type SearchKind = 'html' | 'mediawiki' | 'zongheng';

export interface BuiltInSearchProvider {
  name: string;
  url: string;
  kind: SearchKind;
}

export interface SiteProfile {
  id: string;
  name: string;
  hosts: RegExp;
  contentSelectors: string[];
  catalogSelectors: string[];
  chapterTitleSelectors: string[];
  bookTitleSelectors: string[];
  authorSelectors?: string[];
  inferCatalogUrl?: (url: URL) => string | undefined;
  search?: BuiltInSearchProvider;
}

function parentDirectory(url: URL): string | undefined {
  if (!/\.s?html?$/i.test(url.pathname)) return undefined;
  url.pathname = url.pathname.replace(/[^/]+\.s?html?$/i, '');
  url.search = '';
  url.hash = '';
  return url.toString();
}

export const siteProfiles: SiteProfile[] = [
  {
    id: 'mayiwsk',
    name: '蚂蚁文学',
    hosts: /(?:^|\.)(?:mayiwsk\.com|mayiwxw\.cc)$/i,
    contentSelectors: ['#content'],
    catalogSelectors: ['#list'],
    chapterTitleSelectors: ['.bookname h1', 'h1'],
    bookTitleSelectors: ['#info h1', 'h1'],
    authorSelectors: ['#info p:first-of-type', 'meta[property="og:novel:author"]'],
    inferCatalogUrl: parentDirectory,
    search: {
      name: '蚂蚁文学',
      url: 'https://www.mayiwsk.com/modules/article/search.php?searchkey={keyword}',
      kind: 'html'
    }
  },
  {
    id: '69shuba',
    name: '69书吧',
    hosts: /(?:^|\.)(?:69shuba|69shu)\.(?:com|org|cc|cx)$/i,
    contentSelectors: ['.txtnav', '#content'],
    catalogSelectors: ['#catalog', '.catalog'],
    chapterTitleSelectors: ['.txtnav h1', '.booknav h1', 'h1'],
    bookTitleSelectors: ['meta[property="og:novel:book_name"]', '.booknav2 h1', 'h1'],
    authorSelectors: ['meta[property="og:novel:author"]', '.booknav2 p:first-of-type'],
    inferCatalogUrl: (url) => {
      if (/\/book\/\d+\.htm$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\.htm$/i, '/');
        return url.toString();
      }
      return parentDirectory(url);
    }
  },
  {
    id: 'zongheng',
    name: '纵横中文网',
    hosts: /(?:^|\.)zongheng\.com$/i,
    contentSelectors: ['.content', '.content-txt', '.reader_box .content', '#readerFt'],
    catalogSelectors: ['.chapter-list', '.chapter-con', '.volume-list', '.chapter-list-wrap', '.volume'],
    chapterTitleSelectors: ['.title_txtbox', '.reader_box h1', '.chapter-title', 'h1'],
    bookTitleSelectors: ['.book-info--title', '.book-name', '.book-info h1', 'h1'],
    authorSelectors: ['.au-name', '.book-info--author', '.book-info .writer'],
    inferCatalogUrl: (url) => {
      const match = url.pathname.match(/\/(?:chapter|book)\/(\d+)(?:\/\d+)?\.html/i);
      return match?.[1] ? `https://book.zongheng.com/showchapter/${match[1]}.html` : undefined;
    },
    search: {
      name: '纵横中文网',
      url: 'https://search.zongheng.com/search/book?keyword={keyword}&pageNo=1&pageNum=20',
      kind: 'zongheng'
    }
  },
  {
    id: '17k',
    name: '17K小说网',
    hosts: /(?:^|\.)17k\.com$/i,
    contentSelectors: ['.readAreaBox .p', '.readArea .p', '#chapterContent', '.chapterContent'],
    catalogSelectors: ['.Volume', '.volume', '.chapter_list', '.chapter-list'],
    chapterTitleSelectors: ['.readAreaBox h1', '.readArea h1', '.chapterTitle', 'h1'],
    bookTitleSelectors: ['.Info h1', '.bookInfo h1', 'h1'],
    authorSelectors: ['.AuthorName', '.author a', '.bookInfo .author'],
    inferCatalogUrl: (url) => {
      const match = url.pathname.match(/\/(?:chapter|book)\/(\d+)(?:\/\d+)?\.html/i);
      return match?.[1] ? `https://www.17k.com/list/${match[1]}.html` : undefined;
    }
  },
  {
    id: 'jjwxc',
    name: '晋江文学城',
    hosts: /(?:^|\.)jjwxc\.net$/i,
    contentSelectors: ['#noveltext', '.noveltext', '.readsmall'],
    catalogSelectors: ['#oneboolt', '#onebookt', '.chapterlist', '.cytable'],
    chapterTitleSelectors: ['.noveltitle', '#noveltitle', 'h2', 'h1'],
    bookTitleSelectors: ['.novelname', 'h1', 'title'],
    authorSelectors: ['.authorname', 'a[href*="authorid="]'],
    inferCatalogUrl: (url) => {
      if (!url.searchParams.has('novelid')) return undefined;
      url.searchParams.delete('chapterid');
      url.hash = '';
      return url.toString();
    }
  },
  {
    id: 'qidian',
    name: '起点中文网（公开章节）',
    hosts: /(?:^|\.)qidian\.com$/i,
    contentSelectors: ['.read-content', '.j_readContent', '.content-wrap .content'],
    catalogSelectors: ['.volume-wrap', '.catalog-content-wrap', '.volume'],
    chapterTitleSelectors: ['.j_chapterName', '.chapter-name', 'h1'],
    bookTitleSelectors: ['.book-info h1', '.book-name', 'h1'],
    authorSelectors: ['.writer', '.book-info .author']
  },
  {
    id: 'wikisource',
    name: '维基文库',
    hosts: /(?:^|\.)wikisource\.org$/i,
    contentSelectors: ['#mw-content-text .mw-parser-output', '.mw-parser-output'],
    catalogSelectors: ['#mw-content-text .mw-parser-output', '.mw-parser-output'],
    chapterTitleSelectors: ['#firstHeading', '.mw-page-title-main', 'h1'],
    bookTitleSelectors: ['#firstHeading', '.mw-page-title-main', 'h1'],
    authorSelectors: ['#ws-author', '.ws-author'],
    search: {
      name: '维基文库',
      url: 'https://zh.wikisource.org/w/api.php?action=query&list=search&srsearch={keyword}&format=json&origin=*',
      kind: 'mediawiki'
    }
  }
];

export function profileForUrl(rawUrl: string): SiteProfile | undefined {
  try {
    const host = new URL(rawUrl).hostname;
    return siteProfiles.find((profile) => profile.hosts.test(host));
  } catch {
    return undefined;
  }
}

export const builtInSearchProviders = siteProfiles.flatMap((profile) => profile.search ? [profile.search] : []);
