'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const importer = require('../lib/markdown-importer');

const fence = '```';

test('skips exported front matter and matching page heading, nests code inside Expand', function () {
  const markdown = [
    '---',
    'title: "API page"',
    'source: "https://example.test/pages/1"',
    '---',
    '# API page',
    '',
    'SQL example:',
    '',
    fence + 'sql',
    'select 1;',
    fence
  ].join('\n');

  const result = importer.parseMarkdown(markdown, { pageTitle: 'API page' });
  assert.match(result.storage, /ac:name="expand"/);
  assert.match(result.storage, /<ac:parameter ac:name="title">Раскрыть<\/ac:parameter>/);
  assert.match(result.storage, /<ac:structured-macro ac:name="code">/);
  assert.match(result.storage, /<ac:parameter ac:name="title">Блок кода<\/ac:parameter>/);
  assert.match(result.storage, /<ac:parameter ac:name="language">sql<\/ac:parameter>/);
  assert.match(result.storage, /<!\[CDATA\[select 1;\]\]>/);
  assert.doesNotMatch(result.storage, /<h1>API page<\/h1>/);
  assert.equal(result.frontMatterTitle, 'API page');
});

test('keeps a fenced code block inside details in one Expand', function () {
  const markdown = [
    '<details>',
    '<summary>Пример JSON</summary>',
    '',
    fence + 'json',
    '{"accountArrest": true}',
    fence,
    '</details>'
  ].join('\n');
  const result = importer.parseMarkdown(markdown);
  assert.equal((result.storage.match(/ac:name="expand"/g) || []).length, 1);
  assert.equal((result.storage.match(/ac:name="code"/g) || []).length, 1);
  assert.match(result.storage, /<ac:parameter ac:name="title">Пример JSON<\/ac:parameter>/);
  assert.match(result.storage, /<ac:rich-text-body><ac:structured-macro ac:name="code">/);
});

test('routes PlantUML code fences to the PlantUML macro', function () {
  const markdown = ['# Diagram', '', fence + 'plantuml', '@startuml', 'Alice -> Bob: call', '@enduml', fence].join('\n');
  const result = importer.parseMarkdown(markdown, { pageTitle: 'Different page' });
  assert.match(result.storage, /ac:name="plantuml"/);
  assert.match(result.storage, /<!\[CDATA\[@startuml\nAlice -> Bob: call\n@enduml\]\]>/);
  assert.doesNotMatch(result.storage, /ac:name="expand"/);
});

test('escapes XML text and safely splits CDATA terminators in code', function () {
  const markdown = [fence + 'sql', "select '<tag>' & ']]>';", fence].join('\n');
  const result = importer.parseMarkdown(markdown);
  assert.match(result.storage, /<!\[CDATA\[select '<tag>' & ']]]]><!\[CDATA\[>';\]\]>/);
});

test('converts common Markdown blocks and strips unsafe link schemes', function () {
  const markdown = [
    '## Heading',
    '',
    '**bold** and *italic* with [safe](https://example.test) and [unsafe](javascript:alert(1)).',
    '',
    '- first',
    '- second',
    '',
    '| Key | Value |',
    '| --- | --- |',
    '| a | b |'
  ].join('\n');
  const result = importer.parseMarkdown(markdown);
  assert.match(result.storage, /<h2>Heading<\/h2>/);
  assert.match(result.storage, /<strong>bold<\/strong>/);
  assert.match(result.storage, /<em>italic<\/em>/);
  assert.match(result.storage, /<a href="https:\/\/example\.test">safe<\/a>/);
  assert.doesNotMatch(result.storage, /href="javascript:/i);
  assert.match(result.storage, /unsafe/);
  assert.match(result.storage, /<ul><li>first<\/li><li>second<\/li><\/ul>/);
  assert.match(result.storage, /<table>/);
  assert.match(result.storage, /<th><p>Key<\/p><\/th>/);
});

test('converts Markdown horizontal rules to Confluence separators', function () {
  const result = importer.parseMarkdown(['Before', '', '---', '', '* * *', '', '___'].join('\n'));
  assert.equal((result.storage.match(/<hr \/>/g) || []).length, 3);
  assert.doesNotMatch(result.storage, /<p>(?:---|\* \* \*|___)<\/p>/);
});

test('supports Markdown tables without outer pipes and preserves hard line breaks', function () {
  const result = importer.parseMarkdown([
    'Left | Right',
    '--- | ---',
    'a | b',
    '',
    'first line  ',
    'second line'
  ].join('\n'));
  assert.match(result.storage, /<td><p>a<\/p><\/td><td><p>b<\/p><\/td>/);
  assert.match(result.storage, /first line<br \/>second line/);
});

test('skips multiline HTML comments without importing their contents', function () {
  const result = importer.parseMarkdown(['Before', '', '<!-- note', 'ignore this text', '-->', '', 'After'].join('\n'));
  assert.match(result.storage, /Before/);
  assert.match(result.storage, /After/);
  assert.doesNotMatch(result.storage, /ignore this text/);
});

test('rejects excessive Markdown block nesting with a readable error', function () {
  const nestedQuote = Array(110).fill('>').join(' ') + ' text';
  assert.throws(function () {
    importer.parseMarkdown(nestedQuote);
  }, /слишком глубокая вложенность Markdown/i);
});

test('rejects oversized input and Markdown without content', function () {
  assert.throws(function () {
    importer.parseMarkdown('x'.repeat(importer.MAX_MARKDOWN_LENGTH + 1));
  }, /2 МБ/);
  assert.throws(function () {
    importer.parseMarkdown('---\ntitle: Empty\n---\n');
  }, /не найдено содержимое/);
});
