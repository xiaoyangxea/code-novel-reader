import assert from 'node:assert/strict';
import { test } from 'node:test';
import core from '../dist/core.js';

const result = (title, url = 'https://novel.example/book/1/', author) => ({ title, url, author, provider: 'test' });

test('三体 search rejects categories, legal documents, encyclopedia and unrelated pages', () => {
  const items = [result('玄幻小说', 'https://www.sudugu.cc/fenlei/1/1/'),
    result('刘文君、上海三体商贸有限公司等民间借贷纠纷一审民事判决书', 'https://zh.wikisource.org/wiki/case'),
    result('三体 - 百度百科', 'https://baike.baidu.com/item/三体/1'),
    result('三（汉语汉字）', 'https://dictionary.example/3'),
    result('三体电影预告', 'https://www.bilibili.com/video/1'),
    result('三体 (小说) - 三体wiki', 'https://santi.huijiwiki.com/wiki/三体'),
    result('三体', 'https://novel.example/book/1/', '刘慈欣')];
  assert.deepEqual(core.relevantSearchResults(items, '三体'), [items.at(-1)]);
  assert.deepEqual(core.parseSearchHtml('<li><a href="/fenlei/1/1/">玄幻小说</a></li>', 'https://www.sudugu.cc/search', '速读谷'), []);
});

test('accurate titles and complete editions rank before 三体 fan fiction, without dropping author searches', () => {
  const fan = result('人在三体：面壁之后我开创了收容会！', 'https://novel.example/book/2/');
  const complete = result('三体(全集)全文免费阅读,三体(全集)大结局无弹窗', 'https://novel.example/book/3/');
  const original = result('三体', 'https://novel.example/book/1/', '刘慈欣');
  assert.deepEqual(core.groupSearchResults([fan, complete, original], '三体').map((group) => group[0]), [complete, original, fan]);
  assert.deepEqual(core.relevantSearchResults([original, fan], '刘慈欣'), [original]);
  assert.equal(core.matchesSearchKeyword(original, '三体 刘慈欣'), true);
  assert.equal(core.matchesSearchKeyword(original, '三体 不同作者'), false);
});

test('Baidu extracts actual book destinations from mu metadata rather than opaque tracking URLs', () => {
  const html = `<div id="content_left">
    <div class="c-container" mu="https://novel.example/book/1/"><h3><a href="https://www.baidu.com/link?url=opaque">三体全集目录</a></h3></div>
    <div class="c-container" mu="http://127.0.0.1/private"><h3><a href="https://www.baidu.com/link?url=local">三体</a></h3></div>
    <div class="c-container" mu="https://baike.baidu.com/item/santi"><h3><a href="https://www.baidu.com/link?url=info">三体百科</a></h3></div>
    <div class="c-container"><h3><a href="https://www.baidu.com/link?url=unresolved">三体</a></h3></div>
    <div class="c-container" mu="https://novel.example/book/2/"><h3><a href="https://www.baidu.com/link?url=other">另一本小说目录</a></h3></div>
    <div class="c-container" mu="file:///secret"><h3><a href="https://www.baidu.com/link?url=file">三体</a></h3></div>
  </div>`;
  const parsed = core.parseWebSearchHtml(html, 'https://www.baidu.com/s?wd=test', 'baidu', '三体');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].url, 'https://novel.example/book/1/');
});

test('an engine returning unrelated results cannot report them as successful book matches', () => {
  const html = '<li class="b_algo"><h2><a href="https://example.com/unrelated">学生优惠领取教程</a></h2></li>';
  assert.equal(core.parseWebSearchHtml(html, 'https://cn.bing.com/search', 'bing').length, 1);
  assert.deepEqual(core.parseWebSearchHtml(html, 'https://cn.bing.com/search', 'bing', '三体'), []);
});
