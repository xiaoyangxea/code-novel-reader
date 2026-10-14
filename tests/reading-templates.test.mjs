import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import ts from 'typescript';
import core from '../dist/core.js';

const book = { id: 'test-book', title: '私有书名', kind: 'online', source: 'https://example.com/book/',
  chapters: [{ title: '私有章节名', url: 'https://example.com/book/1' }], addedAt: 0 };
const chapter = { ...book.chapters[0], content: '原创正文标记' };
const render = (id, text = chapter.content, hidden = false) => core.renderReaderLayout(book, chapter, text, 0, 0, 1, 72,
  { templateId: id, hideReadingMarkers: hidden });

test('all 16 long templates have distinct code, short headers and an exact body offset', () => {
  assert.equal(core.readingTemplates.length, 16);
  assert.equal(new Set(core.readingTemplates.map(t => t.id)).size, 16);
  assert.equal(new Set(core.readingTemplates.map(t => t.prefix)).size, 16);
  assert.equal(new Set(core.readingTemplates.map(t => t.suffix)).size, 16);
  for (const template of core.readingTemplates) {
    const layout = render(template.id);
    const lines = layout.content.trimEnd().split('\n');
    const codeLines = lines.filter(line => !line.trimStart().startsWith('//')).length;
    assert.ok(codeLines >= 115 && codeLines <= 125, `${template.id}: ${codeLines} code lines`);
    assert.ok(layout.bodyLine >= 15 && layout.bodyLine <= 25, template.id);
    assert.equal(lines[layout.bodyLine].trim(), '// 原创正文标记');
    assert.equal(layout.templateId, template.id);
  }
  assert.equal(render('missing-id').templateId, 'diagnostics');
});

test('generated TypeScript templates pass strict type checking without executing their code', () => {
  const files = new Map(core.readingTemplates.map(template => [path.resolve(`tests/template-${template.id}.ts`), render(template.id).content]));
  const options = { noEmit: true, strict: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  const source = host.getSourceFile.bind(host);
  host.readFile = filename => files.get(path.resolve(filename)) ?? read(filename);
  host.fileExists = filename => files.has(path.resolve(filename)) || exists(filename);
  host.getSourceFile = (filename, languageVersion, onError, createNew) => files.has(path.resolve(filename))
    ? ts.createSourceFile(filename, files.get(path.resolve(filename)), languageVersion, true)
    : source(filename, languageVersion, onError, createNew);
  const program = ts.createProgram([...files.keys()], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

test('novel text remains in line comments including CR and Unicode line separators', () => {
  const text = "原创正文\rthrow new Error('CR');\u2028throw new Error('LS');\u2029throw new Error('PS');\n/* */\u202e";
  for (const template of core.readingTemplates) {
    const { content } = render(template.id, text);
    assert.doesNotMatch(content, /[\r\u2028\u2029\u202e]/u);
    const source = ts.createSourceFile('display.ts', content, ts.ScriptTarget.ES2022, true);
    assert.equal(source.parseDiagnostics.length, 0);
    // Each suspicious line is commented, not a new executable statement.
    for (const line of content.split('\n').filter(line => line.includes("new Error('CR')") || line.includes("new Error('LS')") || line.includes("new Error('PS')"))) {
      assert.ok(line.trimStart().startsWith('//'));
    }
    assert.doesNotMatch(content, /\/\* \*\//);
  }
});

test('hidden reading markers remove metadata and hints but never change the novel body', () => {
  for (const template of core.readingTemplates) {
    const visible = render(template.id);
    const hidden = render(template.id, chapter.content, true);
    assert.match(visible.content, /私有书名/);
    assert.match(visible.content, /私有章节名/);
    assert.doesNotMatch(hidden.content, /私有书名|私有章节名|trace: chapter|navigation:|Ctrl\+Alt\+B/);
    assert.match(hidden.content, /原创正文标记/);
    assert.equal(hidden.bodyLine, visible.bodyLine);
  }
});

test('chapter mode cycles through all templates without immediate repeats and restores saved choices', () => {
  const selector = new core.ReadingTemplateSelector(undefined, () => 0.31);
  const chosen = Array.from({ length: 32 }, (_, i) => selector.choose('book', `chapter-${i}`, 'chapter'));
  for (let cycle = 0; cycle < 2; cycle++) assert.equal(new Set(chosen.slice(cycle * 16, (cycle + 1) * 16)).size, 16);
  for (let i = 1; i < chosen.length; i++) assert.notEqual(chosen[i], chosen[i - 1]);
  const revision = selector.revision;
  assert.equal(selector.choose('book', 'chapter-31', 'chapter'), chosen[31]);
  assert.equal(selector.revision, revision, 'page renders do not alter stored state');
  const restored = new core.ReadingTemplateSelector(selector.snapshot(), () => 0);
  assert.equal(restored.choose('book', 'chapter-12', 'chapter'), chosen[12]);
  assert.equal(restored.choose('book', 'chapter-31', 'chapter'), chosen[31]);
});

test('book and fixed modes are stable, explicit choices persist, random switches choose a different template', () => {
  const selector = new core.ReadingTemplateSelector(undefined, () => 0);
  const initial = selector.choose('book', 'one', 'book');
  assert.equal(selector.choose('book', 'two', 'book'), initial);
  selector.change('book', 'two', 'book', 'cache');
  assert.equal(selector.choose('book', 'three', 'book'), 'cache');
  assert.equal(selector.choose('other', 'one', 'fixed', 'metrics'), 'metrics');
  assert.equal(selector.choose('other', 'two', 'fixed', 'metrics'), 'metrics');
  assert.equal(selector.choose('other', 'two', 'fixed', 'invalid'), 'diagnostics');
  assert.notEqual(selector.change('other', 'two', 'fixed', undefined, 'diagnostics'), 'diagnostics');
  selector.change('chapter-book', 'one', 'chapter', 'retry');
  assert.equal(selector.choose('chapter-book', 'one', 'chapter'), 'retry');
  assert.notEqual(selector.change('chapter-book', 'one', 'chapter'), 'retry');
  assert.equal(core.readingTemplateMode('unknown'), 'chapter');
});

test('saved template state is bounded, validates IDs, uses hashed keys and can forget a removed book', () => {
  const selector = new core.ReadingTemplateSelector({ version: 1, remaining: ['invalid', 'cache', 'cache'],
    last: 'invalid', books: [[ '__proto__', { chapters: [] } ], null] }, () => 0);
  for (let i = 0; i < 120; i++) selector.choose(`book-${i}`, 'one', 'chapter');
  for (let i = 0; i < 100; i++) selector.choose('book-119', `https://example.com/${i}?private=value`, 'chapter');
  const snapshot = selector.snapshot();
  assert.equal(snapshot.books.length, 100);
  assert.equal(snapshot.books.at(-1)[1].chapters.length, 64);
  assert.doesNotMatch(JSON.stringify(snapshot), /https:|private=value/);
  selector.forget('book-119');
  assert.equal(selector.snapshot().books.length, 99);
  snapshot.books.length = 0;
  assert.equal(selector.snapshot().books.length, 99, 'snapshot is detached from live state');
});
