/**
 * Минимальный ZIP-архиватор без внешних зависимостей.
 *
 * Поддерживает метод store (0) и deflate (8) через CompressionStream.
 * Имена файлов пишутся в UTF-8 с выставленным флагом EFS (bit 11),
 * поэтому кириллица в путях корректно читается любым архиватором.
 *
 * Работает и в браузере (window.MDExporterZip), и в Node (module.exports).
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.MDExporterZip = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  // Форматы, которые уже сжаты: повторное deflate только тратит время.
  const INCOMPRESSIBLE = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|zip|gz|tgz|bz2|7z|rar|xz|jar|pdf|docx?|xlsx?|pptx?|odt|ods|odp|mp[34]|m4a|wav|ogg|ogv|mov|avi|mkv|webm|woff2?|ttf|otf|eot|so|dll|exe|dmg|iso)$/i;

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function toBytes(data) {
    if (data == null) return new Uint8Array(0);
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('Неподдерживаемый тип данных для записи в архив');
  }

  function normalizePath(path) {
    return String(path == null ? '' : path)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/{2,}/g, '/');
  }

  function dosDateTime(date) {
    const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
    let year = d.getFullYear();
    if (year < 1980) year = 1980;
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
    const day = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    return { time: time & 0xffff, date: day & 0xffff };
  }

  async function deflateRaw(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const buffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(buffer);
    } catch (e) {
      return null;
    }
  }

  function concat(chunks, totalLength) {
    const out = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  class ZipWriter {
    constructor() {
      this._entries = [];
      this._paths = new Set();
    }

    get size() {
      return this._entries.length;
    }

    /**
     * @param {string} path путь внутри архива
     * @param {Uint8Array|ArrayBuffer|string} data содержимое
     * @param {{date?: Date, compress?: boolean}} [options]
     */
    add(path, data, options) {
      const opts = options || {};
      const normalized = normalizePath(path);
      if (!normalized) throw new Error('Пустое имя файла в архиве');
      const bytes = toBytes(data);
      const compress = typeof opts.compress === 'boolean'
        ? opts.compress
        : !INCOMPRESSIBLE.test(normalized);
      this._entries.push({
        path: normalized,
        bytes: bytes,
        date: opts.date || new Date(),
        compress: compress
      });
      this._paths.add(normalized);
      return this;
    }

    has(path) {
      return this._paths.has(normalizePath(path));
    }

    /** @returns {Promise<Uint8Array>} готовый ZIP-архив */
    async build() {
      const chunks = [];
      const central = [];
      let offset = 0;

      for (const entry of this._entries) {
        const nameBytes = new TextEncoder().encode(entry.path);
        let method = 0;
        let data = entry.bytes;
        if (entry.compress && entry.bytes.length > 0) {
          const packed = await deflateRaw(entry.bytes);
          if (packed && packed.length < entry.bytes.length) {
            method = 8;
            data = packed;
          }
        }

        const { time, date } = dosDateTime(entry.date);
        const crc = crc32(entry.bytes);

        const local = new Uint8Array(30 + nameBytes.length);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, 0x0800, true);
        localView.setUint16(8, method, true);
        localView.setUint16(10, time, true);
        localView.setUint16(12, date, true);
        localView.setUint32(14, crc, true);
        localView.setUint32(18, data.length, true);
        localView.setUint32(22, entry.bytes.length, true);
        localView.setUint16(26, nameBytes.length, true);
        localView.setUint16(28, 0, true);
        local.set(nameBytes, 30);

        chunks.push(local, data);
        central.push({
          nameBytes: nameBytes,
          method: method,
          time: time,
          date: date,
          crc: crc,
          compressedSize: data.length,
          uncompressedSize: entry.bytes.length,
          offset: offset
        });
        offset += local.length + data.length;
      }

      const centralChunks = [];
      let centralSize = 0;
      for (const record of central) {
        const header = new Uint8Array(46 + record.nameBytes.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 20, true);
        view.setUint16(8, 0x0800, true);
        view.setUint16(10, record.method, true);
        view.setUint16(12, record.time, true);
        view.setUint16(14, record.date, true);
        view.setUint32(16, record.crc, true);
        view.setUint32(20, record.compressedSize, true);
        view.setUint32(24, record.uncompressedSize, true);
        view.setUint16(28, record.nameBytes.length, true);
        view.setUint16(30, 0, true);
        view.setUint16(32, 0, true);
        view.setUint16(34, 0, true);
        view.setUint16(36, 0, true);
        view.setUint32(38, 0, true);
        view.setUint32(42, record.offset, true);
        header.set(record.nameBytes, 46);
        centralChunks.push(header);
        centralSize += header.length;
      }

      const end = new Uint8Array(22);
      const endView = new DataView(end.buffer);
      endView.setUint32(0, 0x06054b50, true);
      endView.setUint16(4, 0, true);
      endView.setUint16(6, 0, true);
      endView.setUint16(8, central.length, true);
      endView.setUint16(10, central.length, true);
      endView.setUint32(12, centralSize, true);
      endView.setUint32(16, offset, true);
      endView.setUint16(20, 0, true);

      return concat(chunks.concat(centralChunks, [end]), offset + centralSize + end.length);
    }

    /** @returns {Promise<Blob>} */
    async buildBlob() {
      const bytes = await this.build();
      return new Blob([bytes], { type: 'application/zip' });
    }
  }

  return {
    ZipWriter: ZipWriter,
    crc32: crc32,
    normalizePath: normalizePath
  };
});
