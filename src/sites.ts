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
  catalogPageSelectors?: string[];
  catalogPageUrlPattern?: RegExp;
  maxCatalogPages?: number;
  catalogDelayMs?: number;
  sortCatalogByOrdinal?: boolean;
  largestCatalogContainer?: boolean;
  inferChapterPageUrl?: (url: URL, nextPage: number) => string | undefined;
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
    id: 'qidiy',
    name: '启迪小说',
    hosts: /(?:^|\.)qidiy\.com$/i,
    contentSelectors: ['#content'],
    catalogSelectors: ['ul.section-list'],
    chapterTitleSelectors: ['h1.title', 'h1:not(.logo)'],
    bookTitleSelectors: ['h1:not(.logo)', 'title'],
    authorSelectors: ['p'],
    largestCatalogContainer: true,
    catalogPageUrlPattern: /\/book\/\d+(?:_\d+)?\/?$/i,
    maxCatalogPages: 100,
    catalogDelayMs: 150,
    inferCatalogUrl: (url) => {
      const match = url.pathname.match(/\/book\/(\d+)(?:_\d+)?(?:\/.*)?$/i);
      return match?.[1] ? `${url.origin}/book/${match[1]}/` : undefined;
    },
    inferChapterPageUrl: (url, nextPage) => {
      const match = url.pathname.match(/^(\/book\/\d+\/[^/.]+)(?:\.html|\/\d+\.html)$/i);
      if (!match?.[1]) return undefined;
      url.pathname = nextPage <= 1 ? `${match[1]}.html` : `${match[1]}/${nextPage}.html`;
      url.search = '';
      url.hash = '';
      return url.toString();
    }
  },
  {
    id: 'kudushu',
    name: '苦读书',
    hosts: /(?:^|\.)kudushu\.org$/i,
    contentSelectors: ['#novelcontent', '.novelcontent', '#chaptercontent', '.chapter-content'],
    catalogSelectors: [
      '#chapterlist', '#catalog', '.chapterlist', '.chapter-list',
      '.cataloglist', '.catalog-list', '.article_list', '.chapter'
    ],
    chapterTitleSelectors: ['.nr_title', '.chapter-title', 'h1', 'h2'],
    bookTitleSelectors: ['.cataloginfo h1', '.book-info h1', '.book-title h1', '#info h1', 'h1'],
    authorSelectors: ['meta[property="og:novel:author"]', '.infotype p', '.book-info p'],
    catalogPageSelectors: ['select[name="pageselect"] option', '.pageselect option'],
    catalogPageUrlPattern: /\/html\/\d+\/asc-\d+\/?$/i,
    maxCatalogPages: 100,
    catalogDelayMs: 150,
    sortCatalogByOrdinal: true,
    inferCatalogUrl: (url) => {
      const desktop = url.pathname.match(/\/html\/\d+\/(\d+)(?:\/|$)/i);
      const mobile = url.pathname.match(/\/(?:book|html)\/(\d+)/i);
      const id = desktop?.[1] ?? mobile?.[1];
      return id ? `https://m.kudushu.org/book/${id}/` : undefined;
    },
    inferChapterPageUrl: (url, nextPage) => {
      const match = url.pathname.match(/^(\/html\/\d+\/\d+)(?:_\d+)?\/?$/i);
      if (!match?.[1]) return undefined;
      url.pathname = `${match[1]}${nextPage > 1 ? `_${nextPage}` : ''}/`;
      url.search = '';
      url.hash = '';
      return url.toString();
    },
    search: {
      name: '苦读书',
      url: 'https://m.kudushu.org/modules/article/search.php?searchkey={keyword}',
      kind: 'html'
    }
  },
  {
    id: 'sudugu',
    name: '速读谷',
    hosts: /(?:^|\.)sudugu\.org$/i,
    contentSelectors: ['.con'],
    catalogSelectors: ['#list'],
    chapterTitleSelectors: ['.submenu h1', 'h1'],
    bookTitleSelectors: ['.item h1 a', '.item h1', 'h1'],
    authorSelectors: ['.item p:nth-child(3) a', '.item .author'],
    catalogPageUrlPattern: /\/\d+\/(?:p-\d+\.html)?$/i,
    maxCatalogPages: 100,
    catalogDelayMs: 200,
    inferCatalogUrl: (url) => {
      const match = url.pathname.match(/^\/(\d+)(?:\/[^/]*)?\/?$/i);
      return match?.[1] ? `${url.origin}/${match[1]}/` : undefined;
    },
    search: {
      name: '速读谷',
      url: 'https://www.sudugu.org/i/sor.aspx?key={keyword}',
      kind: 'html'
    }
  },
  {
    id: 'shuhaige',
    name: '书海阁小说网',
    hosts: /(?:^|\.)shuhaige\.net$/i,
    contentSelectors: ['#content'],
    catalogSelectors: ['dl'],
    chapterTitleSelectors: ['.bookname h1', 'h1'],
    bookTitleSelectors: ['#info h1', '.book-info h1', 'h1'],
    authorSelectors: ['#info p:first-of-type', '.book-info p:first-of-type'],
    sortCatalogByOrdinal: true,
    inferCatalogUrl: parentDirectory
  },
  {
    id: 'xszj',
    name: '小说之家',
    hosts: /(?:^|\.)xszj\.org$/i,
    contentSelectors: ['#booktxt'],
    catalogSelectors: ['#content_1'],
    chapterTitleSelectors: ['#wrapper article h1', 'article h1', 'h1'],
    bookTitleSelectors: ['h1', 'title'],
    authorSelectors: ['.bookinfo p', '.info p'],
    catalogPageSelectors: ['#indexselect option'],
    catalogPageUrlPattern: /\/b\/\d+\/cs\/\d+\/?$/i,
    maxCatalogPages: 100,
    catalogDelayMs: 150,
    inferCatalogUrl: (url) => {
      const match = url.pathname.match(/\/b\/(\d+)(?:\/(?:c\/\d+|cs\/\d+))?\/?$/i);
      return match?.[1] ? `${url.origin}/b/${match[1]}/cs/1` : undefined;
    }
  },
  {
    id: 'ttkan',
    name: '天天看小说',
    hosts: /(?:^|\.)ttkan\.co$/i,
    contentSelectors: ['div.content'],
    catalogSelectors: ['.full_chapters'],
    chapterTitleSelectors: ['.title h1', 'h1'],
    bookTitleSelectors: ['meta[name="og:novel:book_name"]', 'h1', 'title'],
    authorSelectors: ['meta[name="og:novel:author"]', '.author'],
    inferCatalogUrl: (url) => {
      const match = url.pathname.match(/\/novel\/(?:chapters|pagea)\/([^/]+)/i);
      return match?.[1] ? `${url.origin}/novel/chapters/${match[1].replace(/_\d+\.html$/i, '')}` : undefined;
    }
  },
  {
    id: 'biquge365',
    name: '笔趣阁365',
    hosts: /(?:^|\.)biquge365\.net$/i,
    contentSelectors: ['#txt'],
    catalogSelectors: ['.menu .border ul'],
    chapterTitleSelectors: ['#neirong h1', 'h1'],
    bookTitleSelectors: ['.xinxi h1', 'h1', 'title'],
    authorSelectors: ['.xinxi .author', '.xinxi span'],
    catalogPageUrlPattern: /\/shu\/\d+(?:_\d+)?\/?$/i,
    maxCatalogPages: 100,
    inferCatalogUrl: (url) => {
      const mobile = url.pathname.match(/\/shu\/(\d+)(?:_\d+)?\/?$/i);
      if (mobile?.[1]) return `${url.origin}/shu/${mobile[1]}/`;
      const desktop = url.pathname.match(/\/(?:book|newbook)\/(\d+)\/?$/i);
      return desktop?.[1] ? `https://www.biquge365.net/newbook/${desktop[1]}/` : parentDirectory(url);
    }
  },
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
