/**
 * zip.js —— 极简 ZIP 打包器（纯本地、无依赖）
 *
 * .docx 本质是一个 ZIP 容器，Word 完全接受「不压缩（STORE）」的条目，
 * 因此这里只需要 CRC32 + 严格对齐的头部结构，无需引入任何压缩库，
 * 也就不需要网络、不需要额外权限。
 */
(() => {
  'use strict';

  const DSMD = (globalThis.__DSMD__ || (globalThis.__DSMD__ = {}));

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // UTF-8 编码：手写实现，不依赖 TextEncoder，保证在页面/内容脚本/测试环境行为一致
  function utf8(str) {
    const text = String(str == null ? '' : str);
    const out = [];
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          code = 0x10000 + ((code - 0xD800) << 10) + (next - 0xDC00);
          i++;
        }
      }
      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xC0 | (code >> 6), 0x80 | (code & 63));
      } else if (code < 0x10000) {
        out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      } else {
        out.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      }
    }
    return new Uint8Array(out);
  }

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  /**
   * 打包为 ZIP（STORE 方式）
   * @param {Array<{name: string, data: Uint8Array|string}>} entries
   * @returns {Uint8Array}
   */
  function zipStore(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xFFFF;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    for (const entry of entries) {
      const nameBytes = utf8(entry.name);
      const data = typeof entry.data === 'string' ? utf8(entry.data) : entry.data;
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);      // 本地文件头签名
      lv.setUint16(4, 20, true);              // 解压所需版本
      lv.setUint16(6, 0x0800, true);          // 文件名按 UTF-8 编码
      lv.setUint16(8, 0, true);               // 压缩方式：0 = 不压缩
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);    // 压缩后大小
      lv.setUint32(22, data.length, true);    // 原始大小
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);              // 扩展字段长度
      local.set(nameBytes, 30);

      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);      // 中央目录签名
      cv.setUint16(4, 20, true);              // 创建版本
      cv.setUint16(6, 20, true);              // 解压所需版本
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);              // 扩展字段
      cv.setUint16(32, 0, true);              // 注释
      cv.setUint16(34, 0, true);              // 磁盘号
      cv.setUint16(36, 0, true);              // 内部属性
      cv.setUint32(38, 0, true);              // 外部属性
      cv.setUint32(42, offset, true);         // 本地头偏移
      central.set(nameBytes, 46);
      centralParts.push(central);

      offset += local.length + data.length;
    }

    const centralSize = centralParts.reduce((n, c) => n + c.length, 0);

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);        // 中央目录结束记录
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return concat(localParts.concat(centralParts, [end]));
  }

  // base64 → 字节：图片以 data URL 读入后，写进 .docx 的 media 或 .zip 的图片条目时用。
  // 手写解码，不依赖 atob，保证内容脚本 / Node 测试环境行为一致。
  const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function base64Decode(input) {
    const text = String(input == null ? '' : input).replace(/\s+/g, '');
    const out = [];
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '=') break;
      const v = B64_ALPHABET.indexOf(ch);
      if (v < 0) continue;
      buffer = ((buffer << 6) | v) & 0x1FFFFFF;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buffer >> bits) & 0xFF);
      }
    }
    return new Uint8Array(out);
  }

  DSMD.zip = { zipStore, crc32, utf8, base64Decode };
})();
