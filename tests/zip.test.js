'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zip = require('../lib/zip');

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readEndOfCentralDirectory(archive) {
  for (let offset = archive.length - 22; offset >= 0; offset--) {
    const view = new DataView(archive.buffer, archive.byteOffset + offset);
    if (view.getUint32(0, true) === 0x06054b50) {
      return {
        offset: offset,
        entries: view.getUint16(10, true),
        size: view.getUint32(12, true),
        start: view.getUint32(16, true)
      };
    }
  }
  throw new Error('В архиве нет записи конца центрального каталога');
}

function readCentralDirectory(archive, end) {
  const records = [];
  let offset = end.start;
  while (offset < end.start + end.size) {
    const view = new DataView(archive.buffer, archive.byteOffset + offset);
    assert.equal(view.getUint32(0, true), 0x02014b50);
    const nameLength = view.getUint16(28, true);
    const extraLength = view.getUint16(30, true);
    const commentLength = view.getUint16(32, true);
    records.push({
      flags: view.getUint16(8, true),
      method: view.getUint16(10, true),
      crc: view.getUint32(16, true),
      compressedSize: view.getUint32(20, true),
      size: view.getUint32(24, true),
      localOffset: view.getUint32(42, true),
      name: new TextDecoder().decode(archive.subarray(offset + 46, offset + 46 + nameLength))
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return records;
}

test('считает CRC-32 по стандартному контрольному значению', function () {
  assert.equal(zip.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('пишет корректный архив с хранением, сжатием и кириллицей в путях', async function () {
  const text = 'строка страницы '.repeat(200);
  const writer = new zip.ZipWriter();
  writer.add('Папка/Страница/Страница.md', text, { compress: true });
  writer.add('Папка/Страница/attachments/схема.txt', 'маленький файл', { compress: false });
  const archive = await writer.build();

  const end = readEndOfCentralDirectory(archive);
  assert.equal(end.entries, 2);
  assert.equal(end.start + end.size, end.offset);

  const records = readCentralDirectory(archive, end);
  assert.deepEqual(records.map(function (record) { return record.name; }), [
    'Папка/Страница/Страница.md',
    'Папка/Страница/attachments/схема.txt'
  ]);

  for (const record of records) {
    // Флаг EFS: имя записано в UTF-8 и читается любым архиватором.
    assert.equal(record.flags & 0x0800, 0x0800);
    const view = new DataView(archive.buffer, archive.byteOffset + record.localOffset);
    assert.equal(view.getUint32(0, true), 0x04034b50);
    assert.equal(view.getUint16(26, true), new TextEncoder().encode(record.name).length);
  }

  const textRecord = records[0];
  assert.equal(textRecord.method, 8);
  assert.equal(textRecord.size, new TextEncoder().encode(text).length);
  assert.equal(textRecord.crc, zip.crc32(new TextEncoder().encode(text)));
  const packed = archive.subarray(
    textRecord.localOffset + 30 + new TextEncoder().encode(textRecord.name).length,
    textRecord.localOffset + 30 + new TextEncoder().encode(textRecord.name).length + textRecord.compressedSize
  );
  assert.equal(new TextDecoder().decode(await inflateRaw(packed)), text);

  const storedRecord = records[1];
  assert.equal(storedRecord.method, 0);
  assert.equal(zip.crc32(new TextEncoder().encode('маленький файл')), storedRecord.crc);
});

test('отказывается писать архив из слишком большого числа файлов', async function () {
  const writer = new zip.ZipWriter();
  for (let index = 0; index <= zip.ZipWriter.MAX_ENTRIES; index++) {
    writer.add('p' + index + '.md', 'x', { compress: false });
  }
  await assert.rejects(function () { return writer.build(); }, /65535/);
});
