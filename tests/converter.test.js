'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const converter = require('../lib/converter');

const LIMIT = converter.ZIP_ENTRY_PATH_LIMIT_BYTES;

// Граница Проводника Windows: архив с путями в 259 байт и больше не открывается.
const WINDOWS_LIMIT = 258;

function entryPath(page) {
  return page.segments.join('/') + '/' + page.fileName;
}

function attachmentPath(page, name) {
  return page.segments.join('/') + '/attachments/' + name;
}

function longTitle(prefix, chars) {
  return prefix + ' FSD FE ' + 'ф'.repeat(chars);
}

// Цепочка вложенных страниц глубиной depth, у каждой длинное название.
function chainTree(depth) {
  let node = null;
  for (let level = depth; level >= 1; level--) {
    node = {
      id: String(level),
      title: longTitle('2.6.2.' + level, 100),
      children: node ? [node] : []
    };
  }
  return node ? [node] : [];
}

test('не меняет имена страниц, если пути помещаются в лимит', function () {
  const planner = converter.createPathPlanner({ maxPathBytes: LIMIT });
  const pages = converter.planPageTree(
    { id: '100', title: '2.6.2.3 Ролевая модель' },
    [{
      id: '101',
      title: '2.6.2.3.1 [MVP] FSD Интеграция с Keycloak',
      children: [{ id: '102', title: '2.6.2.3.1.1 FE Вход в систему', children: [] }]
    }],
    planner
  );

  assert.equal(pages[0].segments[0], '2.6.2.3 Ролевая модель');
  assert.equal(pages[0].fileName, '2.6.2.3 Ролевая модель.md');
  assert.equal(pages[1].fileName, '2.6.2.3.1 [MVP] FSD Интеграция с Keycloak.md');
  assert.equal(pages[1].segments[1], '2.6.2.3.1 [MVP] FSD Интеграция с Keycloak');
  assert.equal(pages[2].fileName, '2.6.2.3.1.1 FE Вход в систему.md');
  assert.deepEqual(pages.map(function (page) { return entryPath(page); }), [
    '2.6.2.3 Ролевая модель/2.6.2.3 Ролевая модель.md',
    '2.6.2.3 Ролевая модель/2.6.2.3.1 [MVP] FSD Интеграция с Keycloak/2.6.2.3.1 [MVP] FSD Интеграция с Keycloak.md',
    '2.6.2.3 Ролевая модель/2.6.2.3.1 [MVP] FSD Интеграция с Keycloak/2.6.2.3.1.1 FE Вход в систему/2.6.2.3.1.1 FE Вход в систему.md'
  ]);
});

test('обрезает длинные названия так, чтобы пути внутри архива остались в лимите', function () {
  const planner = converter.createPathPlanner({ maxPathBytes: LIMIT });
  const pages = converter.planPageTree({ id: '100', title: longTitle('2.6.2.3', 100) }, chainTree(6), planner);

  assert.equal(pages.length, 7);
  for (const page of pages) {
    const path = entryPath(page);
    assert.ok(converter.utf8Length(path) <= LIMIT, 'путь в архиве длиннее лимита: ' + path);
    if (page.segments.length > 1) {
      // Папка страницы и ее файл по-прежнему называются одинаково.
      assert.equal(page.segments[page.segments.length - 1] + '.md', page.fileName);
    }
    assert.doesNotMatch(page.fileName, /^\.md$/, 'имя файла не должно схлопнуться');
  }
});

test('очень глубокое дерево остается в пределах, которые принимает Windows', function () {
  // На предельной глубине имена уже односимвольные, поэтому рост пути
  // замедляется и укладывается в границу Проводника (258 байт).
  const planner = converter.createPathPlanner({ maxPathBytes: LIMIT });
  const pages = converter.planPageTree({ id: '100', title: longTitle('2.6.2.3', 100) }, chainTree(20), planner);

  assert.equal(pages.length, 21);
  for (const page of pages) {
    const bytes = converter.utf8Length(entryPath(page));
    assert.ok(bytes <= WINDOWS_LIMIT, 'путь в архиве длиннее ' + WINDOWS_LIMIT + ' байт: ' + entryPath(page));
  }
});

test('разводит страницы с одинаковыми названиями в одной папке', function () {
  const planner = converter.createPathPlanner({ maxPathBytes: LIMIT });
  const title = longTitle('2.6.2.18.2', 100);
  const pages = converter.planPageTree(
    { id: '100', title: '2.6.2.18 Дашборды' },
    [
      { id: '101', title: title, children: [] },
      { id: '102', title: title, children: [] }
    ],
    planner
  );

  assert.notEqual(pages[1].segments[1], pages[2].segments[1]);
  assert.equal(pages[2].segments[1], pages[1].segments[1] + ' (2)');
  for (const page of pages) {
    assert.ok(converter.utf8Length(entryPath(page)) <= LIMIT, 'путь в архиве длиннее лимита: ' + entryPath(page));
  }
});

test('обрезает имена вложений, сохраняя расширение и место суффикса', function () {
  const planner = converter.createPathPlanner({ maxPathBytes: LIMIT, reserveAttachments: true });
  const pages = converter.planPageTree({ id: '100', title: longTitle('2.6.2.3', 100) }, chainTree(3), planner);
  const page = pages[pages.length - 1];
  const pagePathBytes = converter.utf8Length(page.segments.join('/'));
  const longAttachment = 'Схема взаимодействия сервисов для проверки длинного имени файла.png';

  const first = planner.attachmentName('attachments:' + page.id, pagePathBytes, longAttachment, '900');
  const second = planner.attachmentName('attachments:' + page.id, pagePathBytes, longAttachment, '901');

  assert.ok(first.length < longAttachment.length);
  assert.ok(first.endsWith('.png'), 'расширение файла должно остаться: ' + first);
  assert.equal(second, first.replace(/\.png$/, ' (2).png'));
  assert.ok(converter.utf8Length(attachmentPath(page, first)) <= LIMIT);
  assert.ok(converter.utf8Length(attachmentPath(page, second)) <= LIMIT);
});

test('в выгрузке одной страницы имена не обрезаются', function () {
  const planner = converter.createPathPlanner({ maxPathBytes: Infinity });
  const title = longTitle('2.6.2.3', 200);
  const pages = converter.planPageTree({ id: '100', title: title }, [], planner);

  assert.equal(pages[0].segments[0], converter.sanitizeFileName(title));
  assert.equal(converter.utf8Length(pages[0].segments[0]) > LIMIT, true);
  assert.equal(planner.shortened(), false);
});

test('сообщает о сокращении имен', function () {
  const shortPlanner = converter.createPathPlanner({ maxPathBytes: LIMIT });
  converter.planPageTree({ id: '100', title: 'Короткое название' }, [], shortPlanner);
  assert.equal(shortPlanner.shortened(), false);

  const longPlanner = converter.createPathPlanner({ maxPathBytes: LIMIT });
  converter.planPageTree({ id: '100', title: longTitle('2.6.2.3', 200) }, [], longPlanner);
  assert.equal(longPlanner.shortened(), true);
});

test('truncateToBytes не разрывает символы и убирает хвостовые точки и пробелы', function () {
  assert.equal(converter.truncateToBytes('абвгде', 6), 'абв');
  assert.equal(converter.truncateToBytes('абвгде', 7), 'абв');
  assert.equal(converter.truncateToBytes('абвгде', 1), 'а');
  assert.equal(converter.truncateToBytes('схема. ', 20), 'схема. ');
  assert.equal(converter.truncateToBytes('схема точка', 11), 'схема');
  assert.equal(converter.truncateToBytes('', 5), '');
  assert.equal(converter.utf8Length('абв'), 6);
  assert.equal(converter.utf8Length('🙂'), 4);
  assert.equal(converter.truncateToBytes('a🙂b', 5), 'a🙂');
});
