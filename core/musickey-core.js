/* ============================================================
 * musickey-core.js —— 音钥 MusicKey 纯前端核心引擎
 * ------------------------------------------------------------
 * 全部在浏览器本地运行，不上传任何文件。
 * 移植自 Python 项目 music-key（MIT 许可，算法参考 unlock-music
 * 等公开资料），并内置酷狗公钥表的 LZMA1 解码器。
 *
 * 导出全局对象 MusicKeyCore：
 *   lzma1Decompress(input, size?)      LZMA1 解压（酷狗密钥表）
 *   sniffContainer(head)               识别音频容器
 *   decodeFile(bytes, name, opts)      Promise<DecodeResult> 按格式解密
 *   makeZip(files)                     生成 store 方式 ZIP
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 基础工具 ---------------- */

  function bytesToU8(b) {
    if (b instanceof Uint8Array) return b;
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    if (Array.isArray(b)) return Uint8Array.from(b);
    throw new Error('不支持的字节类型');
  }

  function concatBytes(parts) {
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], off);
      off += parts[i].length;
    }
    return out;
  }

  /* base64 → Uint8Array（宽容模式：忽略空白，自动补位） */
  var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_LOOKUP = (function () {
    var t = new Int16Array(128);
    for (var i = 0; i < 128; i++) t[i] = -1;
    for (var j = 0; j < 64; j++) t[B64_CHARS.charCodeAt(j)] = j;
    return t;
  })();

  function b64ToBytes(str) {
    var vals = [];
    var i;
    for (i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 128 && B64_LOOKUP[c] >= 0) vals.push(B64_LOOKUP[c]);
    }
    var outLen = Math.floor(vals.length * 3 / 4);
    var out = new Uint8Array(outLen);
    var o = 0;
    for (i = 0; i + 3 < vals.length; i += 4) {
      var n = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6) | vals[i + 3];
      out[o++] = (n >> 16) & 0xFF;
      out[o++] = (n >> 8) & 0xFF;
      out[o++] = n & 0xFF;
    }
    // 尾部不足 4 字符（含带 '=' 补齐的情况）
    var rem = vals.length % 4;
    if (rem >= 2) {
      var nn = vals[i] << 18;
      if (rem >= 2) nn |= vals[i + 1] << 12;
      if (rem >= 3) nn |= vals[i + 2] << 6;
      out[o++] = (nn >> 16) & 0xFF;
      if (rem >= 3) out[o++] = (nn >> 8) & 0xFF;
    }
    return out;
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      } else if (c < 0xD800 || c >= 0xE000) {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else {
        i++;
        var c2 = str.charCodeAt(i);
        var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
    }
    return Uint8Array.from(out);
  }

  function utf8String(bytes) {
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }

  /* 小端/大端整数读写 */
  function le32(u8, off) {
    return (u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24)) >>> 0;
  }
  function be32(u8, off) {
    return ((u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]) >>> 0;
  }
  function be64hi(u8, off) { return be32(u8, off); }
  function be64lo(u8, off) { return be32(u8, off + 4); }

  function xorBytes(data, key, keyLen) {
    var out = new Uint8Array(data.length);
    for (var i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % keyLen];
    return out;
  }

  function toHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
    return s;
  }

  /* ---------------- 容器嗅探 ---------------- */

  var KNOWN_CONTAINERS = { flac: 1, mp3: 1, ogg: 1, m4a: 1, wav: 1 };
  var OUT_EXT = { flac: 'flac', mp3: 'mp3', ogg: 'ogg', m4a: 'm4a', wav: 'wav' };

  function sniffContainer(head) {
    if (head.length >= 4 && head[0] === 0x66 && head[1] === 0x4C && head[2] === 0x61 && head[3] === 0x43) return 'flac';
    if (head.length >= 4 && head[0] === 0x4F && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) return 'ogg';
    if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return 'mp3';
    if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) {
      if (head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45) return 'wav';
    }
    if (head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return 'm4a';
    if (head.length >= 2 && head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) return 'mp3';
    return 'bin';
  }

  /* ---------------- AES（WebCrypto 优先，内置 AES-128 回退） ---------------- */

  var subtle = null;
  try {
    subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;
  } catch (e) { subtle = null; }

  /* 内置 AES-128 实现（用于 WebCrypto 不支持 AES-ECB 的环境） */
  var AES = (function () {
    var exp = new Uint8Array(512), log = new Uint8Array(256);
    var x = 1, i;
    for (i = 0; i < 255; i++) {
      exp[i] = x; log[x] = i;
      x ^= (x << 1) ^ ((x & 0x80) ? 0x11B : 0);
      x &= 0xFF;
    }
    for (i = 255; i < 512; i++) exp[i] = exp[i - 255];
    function gmul(a, b) { if (!a || !b) return 0; return exp[log[a] + log[b]]; }
    function rotl8(v, n) { n = n || 1; return ((v << n) | (v >>> (8 - n))) & 0xFF; }
    var sbox = new Uint8Array(256), invSbox = new Uint8Array(256);
    for (var v = 0; v < 256; v++) {
      var s = v === 0 ? 0 : exp[255 - log[v]];
      sbox[v] = s ^ rotl8(s) ^ rotl8(s, 2) ^ rotl8(s, 3) ^ rotl8(s, 4) ^ 0x63;
    }
    for (v = 0; v < 256; v++) invSbox[sbox[v]] = v;

    function keyExpand(key) {
      var w = new Uint8Array(176);
      for (var i = 0; i < 16; i++) w[i] = key[i];
      var rcon = 1;
      for (i = 4; i < 44; i++) {
        if (i % 4 === 0) {
          // RotWord + SubWord + Rcon
          var a0 = sbox[w[(i - 1) * 4 + 1]] ^ rcon;
          var a1 = sbox[w[(i - 1) * 4 + 2]];
          var a2 = sbox[w[(i - 1) * 4 + 3]];
          var a3 = sbox[w[(i - 1) * 4]];
          rcon = gmul(rcon, 2);
          w[i * 4] = w[(i - 4) * 4] ^ a0;
          w[i * 4 + 1] = w[(i - 4) * 4 + 1] ^ a1;
          w[i * 4 + 2] = w[(i - 4) * 4 + 2] ^ a2;
          w[i * 4 + 3] = w[(i - 4) * 4 + 3] ^ a3;
        } else {
          w[i * 4] = w[(i - 4) * 4] ^ w[(i - 1) * 4];
          w[i * 4 + 1] = w[(i - 4) * 4 + 1] ^ w[(i - 1) * 4 + 1];
          w[i * 4 + 2] = w[(i - 4) * 4 + 2] ^ w[(i - 1) * 4 + 2];
          w[i * 4 + 3] = w[(i - 4) * 4 + 3] ^ w[(i - 1) * 4 + 3];
        }
      }
      return w;
    }

    function addRoundKey(s, w, round) {
      for (var i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
    }
    function subBytes(s) { for (var i = 0; i < 16; i++) s[i] = sbox[s[i]]; }
    function invSubBytes(s) { for (var i = 0; i < 16; i++) s[i] = invSbox[s[i]]; }
    function shiftRows(s) {
      var t;
      t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
      t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
      t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
    }
    function invShiftRows(s) {
      var t;
      t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
      t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
      t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
    }
    function xtime(v) { return gmul(v, 2); }
    function mixColumns(s) {
      for (var c = 0; c < 16; c += 4) {
        var a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
        s[c] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
        s[c + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
        s[c + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
        s[c + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
      }
    }
    function invMixColumns(s) {
      for (var c = 0; c < 16; c += 4) {
        var a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
        s[c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
        s[c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
        s[c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
        s[c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
      }
    }

    function encryptBlock(w, s) {
      var i;
      addRoundKey(s, w, 0);
      for (i = 1; i < 10; i++) { subBytes(s); shiftRows(s); mixColumns(s); addRoundKey(s, w, i); }
      subBytes(s); shiftRows(s); addRoundKey(s, w, 10);
    }
    function decryptBlock(w, s) {
      var i;
      addRoundKey(s, w, 10);
      for (i = 9; i >= 1; i--) { invShiftRows(s); invSubBytes(s); addRoundKey(s, w, i); invMixColumns(s); }
      invShiftRows(s); invSubBytes(s); addRoundKey(s, w, 0);
    }

    function ecbDecrypt(key, data) {
      var w = keyExpand(key);
      var out = new Uint8Array(data.length);
      var s = new Uint8Array(16);
      for (var off = 0; off < data.length; off += 16) {
        for (var j = 0; j < 16; j++) s[j] = data[off + j];
        decryptBlock(w, s);
        out.set(s, off);
      }
      // PKCS7 去填充
      if (out.length) {
        var pad = out[out.length - 1];
        if (pad >= 1 && pad <= 16) out = out.subarray(0, out.length - pad);
      }
      return out;
    }
    function ecbEncrypt(key, data) {
      var w = keyExpand(key);
      var out = new Uint8Array(data.length);
      var s = new Uint8Array(16);
      for (var off = 0; off < data.length; off += 16) {
        for (var j = 0; j < 16; j++) s[j] = data[off + j];
        encryptBlock(w, s);
        out.set(s, off);
      }
      return out;
    }

    return { ecbDecrypt: ecbDecrypt, ecbEncrypt: ecbEncrypt };
  })();

  function aesEcbDecrypt(keyBytes, data) {
    var key = bytesToU8(keyBytes);
    var ct = bytesToU8(data);
    if (subtle) {
      return subtle.importKey('raw', key, { name: 'AES-ECB' }, false, ['decrypt']).then(function (k) {
        return subtle.decrypt({ name: 'AES-ECB' }, k, ct);
      }).then(function (pt) {
        return new Uint8Array(pt);
      }).catch(function () {
        return AES.ecbDecrypt(key, ct);
      });
    }
    return Promise.resolve(AES.ecbDecrypt(key, ct));
  }

  /* ---------------- QMC v1 ---------------- */

  var KEY_LEN = 128;
  var QMC1_BOUNDARY = 0x7FFF;

  function xorKeyStream(data, key) {
    if (!data.length) return data;
    var out = new Uint8Array(data.length);
    var kl = key.length;
    for (var i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % kl];
    return out;
  }

  function qmc1Transform(data, key, offsetStart) {
    offsetStart = offsetStart || 0;
    var out = new Uint8Array(data.length);
    var pos = offsetStart;
    var index = 0;
    var total = data.length;
    var keyBuf = bytesToU8(key);
    while (index < total) {
      var phase, take;
      if (pos <= QMC1_BOUNDARY) {
        take = Math.min(QMC1_BOUNDARY + 1 - pos, total - index);
        phase = pos % KEY_LEN;
      } else {
        phase = (pos % QMC1_BOUNDARY) % KEY_LEN;
        take = Math.min(QMC1_BOUNDARY - (pos % QMC1_BOUNDARY), total - index);
      }
      var base;
      if (phase) {
        base = new Uint8Array(KEY_LEN);
        base.set(keyBuf.subarray(phase), 0);
        base.set(keyBuf.subarray(0, phase), KEY_LEN - phase);
      } else {
        base = keyBuf;
      }
      var chunk = data.subarray(index, index + take);
      var dec = xorKeyStream(chunk, base);
      out.set(dec, index);
      index += take;
      pos += take;
    }
    return out;
  }

  /* ---------------- Tencent TEA ---------------- */

  var TEA_DELTA = 0x9E3779B9;
  var TEA_ROUNDS = 16;
  var TEA_SALT_LEN = 2;
  var TEA_ZERO_LEN = 7;

  function teaMix(value, s, k1, k2) {
    var left = (((value << 4) & 0xFFFFFFFF) + k1) >>> 0;
    var right = ((value >>> 5) + k2) >>> 0;
    var mid = ((s + value) & 0xFFFFFFFF) >>> 0;
    return (left ^ mid ^ right) >>> 0;
  }

  /* 解密一个 64 位块，返回 [hi, lo] */
  function teaDecryptBlock32(hi, lo, words) {
    var s = (TEA_DELTA * TEA_ROUNDS) & 0xFFFFFFFF;
    var i;
    for (i = 0; i < TEA_ROUNDS; i++) {
      lo = ((lo - teaMix(hi, s, words[2], words[3])) & 0xFFFFFFFF) >>> 0;
      hi = ((hi - teaMix(lo, s, words[0], words[1])) & 0xFFFFFFFF) >>> 0;
      s = ((s - TEA_DELTA) & 0xFFFFFFFF) >>> 0;
    }
    return [hi, lo];
  }

  function teaCbcDecrypt(ciphertext, key16) {
    var ct = bytesToU8(ciphertext);
    if (ct.length % 8 !== 0 || ct.length < 10) throw new Error('TEA: 非法密文长度 ' + ct.length);
    // TEA 密钥 words 来自 key16（16 字节，大端 4×32）
    var keyWords = [
      (key16[0] << 24) | (key16[1] << 16) | (key16[2] << 8) | key16[3],
      (key16[4] << 24) | (key16[5] << 16) | (key16[6] << 8) | key16[7],
      (key16[8] << 24) | (key16[9] << 16) | (key16[10] << 8) | key16[11],
      (key16[12] << 24) | (key16[13] << 16) | (key16[14] << 8) | key16[15]
    ];
    // 上面 words 是无用代码（用于对齐），修正：ct 本身是密文，不需要从这里取 key
    var ivPrevHi = 0, ivPrevLo = 0;
    var ivCurHi = 0, ivCurLo = 0;
    var plain = new Uint8Array(ct.length);
    var outOff = 0;
    for (var start = 0; start < ct.length; start += 8) {
      var bHi = be32(ct, start);
      var bLo = be32(ct, start + 4);
      var mixedHi = (bHi ^ ivCurHi) >>> 0;
      var mixedLo = (bLo ^ ivCurLo) >>> 0;
      var next = teaDecryptBlock32(mixedHi, mixedLo, keyWords);
      var nHi = (next[0] ^ ivPrevHi) >>> 0;
      var nLo = (next[1] ^ ivPrevLo) >>> 0;
      plain[outOff++] = (nHi >>> 24) & 0xFF;
      plain[outOff++] = (nHi >>> 16) & 0xFF;
      plain[outOff++] = (nHi >>> 8) & 0xFF;
      plain[outOff++] = nHi & 0xFF;
      plain[outOff++] = (nLo >>> 24) & 0xFF;
      plain[outOff++] = (nLo >>> 16) & 0xFF;
      plain[outOff++] = (nLo >>> 8) & 0xFF;
      plain[outOff++] = nLo & 0xFF;
      ivPrevHi = bHi; ivPrevLo = bLo;
      ivCurHi = next[0]; ivCurLo = next[1];
    }
    var pad = plain[0] & 0b111;
    var bodyStart = 1 + pad + TEA_SALT_LEN;
    var bodyEnd = ct.length - TEA_ZERO_LEN;
    for (var k = bodyEnd; k < ct.length; k++) {
      if (plain[k] !== 0) throw new Error('TEA: 尾部校验失败');
    }
    return plain.subarray(bodyStart, bodyEnd);
  }

  /* ---------------- QMC v2 EKey ---------------- */

  // base64.b64encode(b"QQMusic EncV2,Key:") 的结果（文件里 EKey v2 的文本前缀）
  var EKEY_V2_PREFIX_TEXT = 'UVFNdXNpYyBFbmNWMixLZXk6';
  var EKEY_V2_PREFIX_LEN = EKEY_V2_PREFIX_TEXT.length;
  var EKEY_V2_PREFIX_B64 = utf8Bytes(EKEY_V2_PREFIX_TEXT);
  var EKEY_V2_KEY1 = Uint8Array.from([0x33, 0x38, 0x36, 0x5A, 0x4A, 0x59, 0x21, 0x40, 0x23, 0x2A, 0x24, 0x25, 0x5E, 0x26, 0x29, 0x28]);
  var EKEY_V2_KEY2 = Uint8Array.from([0x2A, 0x2A, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25, 0x26, 0x5E, 0x61, 0x31, 0x63, 0x5A, 0x2C, 0x54]);

  function simpleKey8() {
    var out = new Uint8Array(8);
    for (var index = 0; index < 8; index++) {
      var v = Math.fround(106.0 + Math.fround(index * Math.fround(0.1)));
      var value = Math.abs(Math.tan(v));
      var scaled = Math.fround(Math.fround(value) * 100.0);
      out[index] = Math.max(0, Math.min(Math.trunc(scaled), 255));
    }
    return out;
  }
  var SIMPLE_KEY = simpleKey8();

  function ekeyV1(ekeyBytes) {
    // 输入可能是 base64 字符串，也可能是 base64 文本字节（EncV2 内层）
    var text = typeof ekeyBytes === 'string' ? ekeyBytes : utf8String(ekeyBytes);
    var decoded = b64ToBytes(text);
    if (decoded.length < 8) throw new Error('EKey v1: 解码后不足 8 字节');
    var header = decoded.subarray(0, 8);
    var cipher = decoded.subarray(8);
    var teaKey = new Uint8Array(16);
    for (var i = 0; i < 8; i++) {
      teaKey[i * 2] = SIMPLE_KEY[i];
      teaKey[i * 2 + 1] = header[i];
    }
    var dec = teaCbcDecrypt(cipher, teaKey);
    var out = new Uint8Array(8 + dec.length);
    out.set(header, 0);
    out.set(dec, 8);
    return out;
  }

  function deriveMasterKey(ekeyStr) {
    // 与 Python 一致：ekeyStr 是 footer 里的 base64 文本。
    // v2 形如 b64("QQMusic EncV2,Key:") + b64(双层TEA密文)；v1 直接是 b64(header+TEA密文)。
    if (ekeyStr.length >= EKEY_V2_PREFIX_LEN && ekeyStr.indexOf(EKEY_V2_PREFIX_TEXT) === 0) {
      var payload = b64ToBytes(ekeyStr.substring(EKEY_V2_PREFIX_LEN));
      payload = teaCbcDecrypt(payload, EKEY_V2_KEY1);
      payload = teaCbcDecrypt(payload, EKEY_V2_KEY2);
      var zero = -1;
      for (var j = 0; j < payload.length; j++) {
        if (payload[j] === 0) { zero = j; break; }
      }
      // 内层是 v1 的 base64 文本字节
      return ekeyV1(zero === -1 ? payload : payload.subarray(0, zero));
    }
    return ekeyV1(ekeyStr);
  }

  /* ---------------- QMC v2 流密码 ---------------- */

  var MAP_LEN = 128;
  var MAP_MAGIC = 71214;
  var RC4_FIRST_SEGMENT = 0x80;
  var RC4_SEGMENT = 0x1400;
  var RC4_STREAM_CACHE = RC4_SEGMENT + 512;

  function compressKey(longKey) {
    var length = longKey.length;
    var out = new Uint8Array(MAP_LEN);
    for (var index = 0; index < MAP_LEN; index++) {
      var idx = (index * index + MAP_MAGIC) % length;
      var shift = (idx + 4) % 8;
      out[index] = ((longKey[idx] << shift) | (longKey[idx] >>> shift)) & 0xFF;
    }
    return out;
  }

  function qmc2Hash(key) {
    var hashValue = 1;
    for (var i = 0; i < key.length; i++) {
      var value = key[i];
      if (value === 0) continue;
      var nextValue = ((hashValue * value) & 0xFFFFFFFF) >>> 0;
      if (nextValue === 0 || nextValue <= hashValue) break;
      hashValue = nextValue;
    }
    return hashValue;
  }

  function segmentKey(segId, seed, hashValue) {
    if (seed === 0) return 0;
    var denominator = (segId + 1) * seed;
    return Math.floor(hashValue / denominator * 100.0);
  }

  function makeQmc2Stream(masterKey) {
    if (!masterKey || !masterKey.length) throw new Error('主密钥为空');
    if (masterKey.length <= 300) return new MapStream(masterKey);
    return new Rc4Stream(masterKey);
  }

  function MapStream(masterKey) {
    this.key = compressKey(masterKey);
  }
  MapStream.prototype.decrypt = function (data, offset) {
    return qmc1Transform(data, this.key, offset || 0);
  };

  function Rc4Stream(masterKey) {
    this.key = Uint8Array.from(masterKey);
    var length = this.key.length;
    var state = new Uint8Array(length);
    for (var i = 0; i < length; i++) state[i] = i & 0xFF;
    var j = 0, t;
    for (var idx = 0; idx < length; idx++) {
      j = (j + state[idx] + this.key[idx % length]) % length;
      t = state[idx]; state[idx] = state[j]; state[j] = t;
    }
    this.state = state;
    this.n = length;
    this._i = 0;
    this._j = 0;
    this.hash = qmc2Hash(this.key);
    var cache = new Uint8Array(RC4_STREAM_CACHE);
    for (var c = 0; c < RC4_STREAM_CACHE; c++) cache[c] = this._nextByte();
    this.keyStream = cache;
  }
  Rc4Stream.prototype._nextByte = function () {
    var n = this.n;
    this._i = (this._i + 1) % n;
    this._j = (this._j + this.state[this._i]) % n;
    var t = this.state[this._i];
    this.state[this._i] = this.state[this._j];
    this.state[this._j] = t;
    return this.state[(this.state[this._i] + this.state[this._j]) % n];
  };
  Rc4Stream.prototype.decrypt = function (data, offset) {
    var out = new Uint8Array(data.length);
    out.set(data);
    var n = this.key.length;
    var total = out.length;
    var pos = offset || 0;
    var start = 0;
    var j, p;
    if (pos < RC4_FIRST_SEGMENT) {
      var take0 = Math.min(RC4_FIRST_SEGMENT - pos, total);
      for (j = 0; j < take0; j++) {
        p = pos + j;
        out[j] ^= this.key[segmentKey(p, this.key[p % n], this.hash) % n];
      }
      start += take0;
      pos += take0;
    }
    while (start < total) {
      var segId = Math.floor(pos / RC4_SEGMENT);
      var blockOff = pos % RC4_SEGMENT;
      var seed = this.key[segId % n];
      var skip = segmentKey(segId, seed, this.hash) & 0x1FF;
      var take = Math.min(RC4_SEGMENT - blockOff, total - start);
      var stream = this.keyStream.subarray(skip + blockOff, skip + blockOff + take);
      for (j = 0; j < take; j++) out[start + j] ^= stream[j];
      start += take;
      pos += take;
    }
    return out;
  };

  /* ---------------- NCM 密钥流 ---------------- */

  function ncmStreamBytes(key) {
    var sbox = new Uint8Array(256);
    for (var i = 0; i < 256; i++) sbox[i] = i;
    var j = 0, t;
    var keyLen = key.length;
    for (var index = 0; index < 256; index++) {
      j = (j + sbox[index] + key[index % keyLen]) & 0xFF;
      t = sbox[index]; sbox[index] = sbox[j]; sbox[j] = t;
    }
    var box = new Uint8Array(256);
    for (var k = 0; k < 256; k++) {
      box[k] = sbox[(sbox[k] + sbox[(k + sbox[k]) & 0xFF]) & 0xFF];
    }
    return box;
  }

  function xorNcm(audio, box, startOffset) {
    var out = new Uint8Array(audio.length);
    for (var i = 0; i < audio.length; i++) {
      out[i] = audio[i] ^ box[(startOffset + i + 1) & 0xFF];
    }
    return out;
  }

  /* ---------------- KGM ---------------- */

  var KGM_MAGIC = Uint8Array.from([0x7C, 0xD5, 0x32, 0xEB, 0x86, 0x02, 0x7F, 0x4B, 0xA8, 0xAF, 0xA6, 0x8E, 0x0F, 0xFF, 0x99, 0x14]);
  var VPR_MAGIC = Uint8Array.from([0x05, 0x28, 0xBC, 0x96, 0xE9, 0xE4, 0x5A, 0x43, 0x91, 0xAA, 0xBD, 0xD0, 0x7A, 0xF5, 0x36, 0x31]);
  var KGM_HEADER_LEN = 1024;
  var OWN_KEY_LEN = 17;
  var KGM_BLOCK = 16;

  var MEND_TABLE = Uint8Array.from([
    0xB8, 0xD5, 0x3D, 0xB2, 0xE9, 0xAF, 0x78, 0x8C, 0x83, 0x33, 0x71, 0x51, 0x76, 0xA0, 0xCD, 0x37,
    0x2F, 0x3E, 0x35, 0x8D, 0xA9, 0xBE, 0x98, 0xB7, 0xE7, 0x8C, 0x22, 0xCE, 0x5A, 0x61, 0xDF, 0x68,
    0x69, 0x89, 0xFE, 0xA5, 0xB6, 0xDE, 0xA9, 0x77, 0xFC, 0xC8, 0xBD, 0xBD, 0xE5, 0x6D, 0x3E, 0x5A,
    0x36, 0xEF, 0x69, 0x4E, 0xBE, 0xE1, 0xE9, 0x66, 0x1C, 0xF3, 0xD9, 0x02, 0xB6, 0xF2, 0x12, 0x9B,
    0x44, 0xD0, 0x6F, 0xB9, 0x35, 0x89, 0xB6, 0x46, 0x6D, 0x73, 0x82, 0x06, 0x69, 0xC1, 0xED, 0xD7,
    0x85, 0xC2, 0x30, 0xDF, 0xA2, 0x62, 0xBE, 0x79, 0x2D, 0x62, 0x62, 0x3D, 0x0D, 0x7E, 0xBE, 0x48,
    0x89, 0x23, 0x02, 0xA0, 0xE4, 0xD5, 0x75, 0x51, 0x32, 0x02, 0x53, 0xFD, 0x16, 0x3A, 0x21, 0x3B,
    0x16, 0x0F, 0xC3, 0xB2, 0xBB, 0xB3, 0xE2, 0xBA, 0x3A, 0x3D, 0x13, 0xEC, 0xF6, 0x01, 0x45, 0x84,
    0xA5, 0x70, 0x0F, 0x93, 0x49, 0x0C, 0x64, 0xCD, 0x31, 0xD5, 0xCC, 0x4C, 0x07, 0x01, 0x9E, 0x00,
    0x1A, 0x23, 0x90, 0xBF, 0x88, 0x1E, 0x3B, 0xAB, 0xA6, 0x3E, 0xC4, 0x73, 0x47, 0x10, 0x7E, 0x3B,
    0x5E, 0xBC, 0xE3, 0x00, 0x84, 0xFF, 0x09, 0xD4, 0xE0, 0x89, 0x0F, 0x5B, 0x58, 0x70, 0x4F, 0xFB,
    0x65, 0xD8, 0x5C, 0x53, 0x1B, 0xD3, 0xC8, 0xC6, 0xBF, 0xEF, 0x98, 0xB0, 0x50, 0x4F, 0x0F, 0xEA,
    0xE5, 0x83, 0x58, 0x8C, 0x28, 0x2C, 0x84, 0x67, 0xCD, 0xD0, 0x9E, 0x47, 0xDB, 0x27, 0x50, 0xCA,
    0xF4, 0x63, 0x63, 0xE8, 0x97, 0x7F, 0x1B, 0x4B, 0x0C, 0xC2, 0xC1, 0x21, 0x4C, 0xCC, 0x58, 0xF5,
    0x94, 0x52, 0xA3, 0xF3, 0xD3, 0xE0, 0x68, 0xF4, 0x00, 0x23, 0xF3, 0x5E, 0x0A, 0x7B, 0x93, 0xDD,
    0xAB, 0x12, 0xB2, 0x13, 0xE8, 0x84, 0xD7, 0xA7, 0x9F, 0x0F, 0x32, 0x4C, 0x55, 0x1D, 0x04, 0x36,
    0x52, 0xDC, 0x03, 0xF3, 0xF9, 0x4E, 0x42, 0xE9, 0x3D, 0x61, 0xEF, 0x7C, 0xB6, 0xB3, 0x93, 0x50
  ]);

  function scramble(value) {
    return value ^ ((value & 0x0F) << 4);
  }
  var SCRAMBLE_TABLE = (function () {
    var t = new Uint8Array(256);
    for (var i = 0; i < 256; i++) t[i] = scramble(i);
    return t;
  })();

  var _kgmPubKey = null;
  var _kgmPubKeyPromise = null;

  /* LZMA1 解压酷狗公钥表（在 lzma1Decompress 中实现） */
  function getKgmPubKey() {
    if (_kgmPubKey) return Promise.resolve(_kgmPubKey);
    if (_kgmPubKeyPromise) return _kgmPubKeyPromise;
    _kgmPubKeyPromise = new Promise(function (resolve, reject) {
      try {
        var compressed = b64ToBytes(global.MUSICKEY_KUGOU_KEY_B64);
        var key = lzma1Decompress(compressed);
        _kgmPubKey = key;
        resolve(key);
      } catch (e) {
        reject(e);
      }
    });
    return _kgmPubKeyPromise;
  }

  function kgmDecryptChunk(chunk, position, ownKey, pubKey) {
    var out = new Uint8Array(chunk.length);
    var mendLen = MEND_TABLE.length;
    for (var i = 0; i < chunk.length; i++) {
      var globalIndex = position + i;
      var packed = chunk[i] ^ ownKey[globalIndex % OWN_KEY_LEN];
      var publicByte = pubKey[(globalIndex / KGM_BLOCK) | 0];
      out[i] = SCRAMBLE_TABLE[packed] ^ SCRAMBLE_TABLE[publicByte ^ MEND_TABLE[globalIndex % mendLen]];
    }
    return out;
  }

  function decodeKgm(bytes, name) {
    if (bytes.length < KGM_HEADER_LEN + KGM_BLOCK) throw new Error(name + ': 文件过短');
    var magic = bytes.subarray(0, 16);
    var isKgm = true, isVpr = true, i;
    for (i = 0; i < 16; i++) {
      if (magic[i] !== KGM_MAGIC[i]) isKgm = false;
      if (magic[i] !== VPR_MAGIC[i]) isVpr = false;
    }
    if (!isKgm && !isVpr) throw new Error(name + ': 不是 KGM/VPR 文件');
    var audioOffset = le32(bytes, 0x10);
    var cryptoVersion = le32(bytes, 0x14);
    if (cryptoVersion === 5) throw new Error(name + ': KGG(v5) 需要客户端密钥库，暂不支持');
    if (audioOffset < KGM_HEADER_LEN || audioOffset > bytes.length) throw new Error(name + ': KGM 音频偏移非法');
    var ownKey = new Uint8Array(OWN_KEY_LEN);
    ownKey.set(bytes.subarray(0x1C, 0x2C), 0);
    ownKey[16] = 0;
    var audio = bytes.subarray(audioOffset);
    var audioTotal = audio.length;
    var blockCount = Math.ceil(audioTotal / KGM_BLOCK);
    return getKgmPubKey().then(function (pubKey) {
      if (blockCount > pubKey.length) throw new Error(name + ': 公钥耗尽（文件过大或损坏）');
      var out = new Uint8Array(audioTotal);
      var pos = 0;
      var CH = 1024 * 1024;
      while (pos < audioTotal) {
        var n = Math.min(CH, audioTotal - pos);
        out.set(kgmDecryptChunk(audio.subarray(pos, pos + n), pos, ownKey, pubKey), pos);
        pos += n;
      }
      return out;
    });
  }

  /* ---------------- KWM ---------------- */

  var KWM_HEADER_LEN = 1024;
  var KWM_KEY_LEN = 32;

  function kwmTryKey(data, key) {
    var probe = new Uint8Array(data.length);
    for (var i = 0; i < data.length; i++) probe[i] = data[i] ^ key[i & (KWM_KEY_LEN - 1)];
    var start = 0;
    while (start < probe.length && probe[start] === 0) start++;
    return sniffContainer(probe.subarray(start, start + 64));
  }

  function kwmRecoverKey(body) {
    var candidates = [];
    var prev = body.subarray(0, KWM_KEY_LEN);
    var n = Math.floor(body.length / KWM_KEY_LEN);
    var i;
    for (i = 1; i < n; i++) {
      var chunk = body.subarray(i * KWM_KEY_LEN, (i + 1) * KWM_KEY_LEN);
      var same = true;
      for (var k = 0; k < KWM_KEY_LEN; k++) {
        if (chunk[k] !== prev[k]) { same = false; break; }
      }
      if (same) candidates.push(chunk);
      prev = chunk;
    }
    if (prev && prev.length >= KWM_KEY_LEN) {
      var rotated = new Uint8Array(KWM_KEY_LEN);
      rotated.set(prev.subarray(KWM_KEY_LEN / 2), 0);
      rotated.set(prev.subarray(0, KWM_KEY_LEN / 2), KWM_KEY_LEN / 2);
      candidates.push(rotated);
    }
    var probeLen = Math.min(4096, body.length);
    for (i = 0; i < candidates.length; i++) {
      if (kwmTryKey(body.subarray(0, probeLen), candidates[i]) !== 'bin') return candidates[i];
    }
    var limit = Math.min(64, n);
    for (i = 0; i < limit; i++) {
      var key2 = body.subarray(i * KWM_KEY_LEN, (i + 1) * KWM_KEY_LEN);
      if (kwmTryKey(body.subarray(0, probeLen), key2) !== 'bin') return key2;
    }
    return candidates.length ? candidates[0] : new Uint8Array(KWM_KEY_LEN);
  }

  function decodeKwm(bytes, name) {
    if (bytes.length < KWM_HEADER_LEN + KWM_KEY_LEN * 2) throw new Error(name + ': 文件过短');
    var body = bytes.subarray(KWM_HEADER_LEN);
    var key = kwmRecoverKey(body);
    var out = new Uint8Array(body.length);
    for (var i = 0; i < body.length; i++) out[i] = body[i] ^ key[i & (KWM_KEY_LEN - 1)];
    return out;
  }

  /* ---------------- QMC ---------------- */

  var V1_STATIC_KEY = Uint8Array.from([
    0xC3, 0x4A, 0xD6, 0xCA, 0x90, 0x67, 0xF7, 0x52, 0xD8, 0xA1, 0x66, 0x62, 0x9F, 0x5B, 0x09, 0x00,
    0xC3, 0x5E, 0x95, 0x23, 0x9F, 0x13, 0x11, 0x7E, 0xD8, 0x92, 0x3F, 0xBC, 0x90, 0xBB, 0x74, 0x0E,
    0xC3, 0x47, 0x74, 0x3D, 0x90, 0xAA, 0x3F, 0x51, 0xD8, 0xF4, 0x11, 0x84, 0x9F, 0xDE, 0x95, 0x1D,
    0xC3, 0xC6, 0x09, 0xD5, 0x9F, 0xFA, 0x66, 0xF9, 0xD8, 0xF0, 0xF7, 0xA0, 0x90, 0xA1, 0xD6, 0xF3,
    0xC3, 0xF3, 0xD6, 0xA1, 0x90, 0xA0, 0xF7, 0xF0, 0xD8, 0xF9, 0x66, 0xFA, 0x9F, 0xD5, 0x09, 0xC6,
    0xC3, 0x1D, 0x95, 0xDE, 0x9F, 0x84, 0x11, 0xF4, 0xD8, 0x51, 0x3F, 0xAA, 0x90, 0x3D, 0x74, 0x47,
    0xC3, 0x0E, 0x74, 0xBB, 0x90, 0xBC, 0x3F, 0x92, 0xD8, 0x7E, 0x11, 0x13, 0x9F, 0x23, 0x95, 0x5E,
    0xC3, 0x00, 0x09, 0x5B, 0x9F, 0x62, 0x66, 0xA1, 0xD8, 0x52, 0xF7, 0x67, 0x90, 0xCA, 0xD6, 0x4A
  ]);

  var V1_EXTS = {
    '.tkm': 1, '.bkcmp3': 1, '.bkcm4a': 1, '.bkcflac': 1, '.bkcwav': 1,
    '.bkcape': 1, '.bkcogg': 1, '.bkcwma': 1, '.666c6163': 1, '.6d7033': 1,
    '.6f6767': 1, '.6d3461': 1, '.776176': 1
  };
  var V2_EXTS = {
    '.mflac': 1, '.mflac0': 1, '.mgg': 1, '.mgg0': 1, '.mgg1': 1, '.mggl': 1,
    '.mmp4': 1, '.qmcflac': 1, '.qmcogg': 1, '.qmc0': 1, '.qmc2': 1, '.qmc3': 1,
    '.qmc4': 1, '.qmc6': 1, '.qmc8': 1
  };
  var MAX_EKEY_LEN = 0x500;
  var MUSICEX_BLOCK = 0xC0;
  var FOOTER_SAMPLE = 4096;

  function isBase64Text(bytes) {
    if (!bytes.length) return false;
    var B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    for (var i = 0; i < bytes.length; i++) {
      if (B.indexOf(String.fromCharCode(bytes[i])) === -1) return false;
    }
    return true;
  }

  function readUtf16le(data) {
    var result = '';
    for (var index = 0; index < data.length - 1; index += 2) {
      var lo = data[index], hi = data[index + 1];
      if (lo === 0 && hi === 0) break;
      if (hi === 0 && lo > 0 && lo < 128) result += String.fromCharCode(lo);
      else break;
    }
    return result;
  }

  /* 返回 {size, ekey, kind, ...} 或 null */
  function parseQmcFooter(tail) {
    if (tail.length < 8) return null;
    var endsWith = function (s) {
      var sb = utf8Bytes(s);
      if (tail.length < sb.length) return false;
      for (var i = 0; i < sb.length; i++) {
        if (tail[tail.length - sb.length + i] !== sb[i]) return false;
      }
      return true;
    };
    if (endsWith('STag')) {
      var body = tail.subarray(0, tail.length - 4);
      var payload = body.subarray(0, body.length - 4);
      var sizeBytes = body.subarray(body.length - 4);
      var payloadLen = be32(sizeBytes, 0);
      if (payload.length < payloadLen) throw new Error('STag 长度不一致');
      var parts = utf8String(payload.subarray(payload.length - payloadLen)).split(',');
      if (parts.length !== 3 || parts[1] !== '2' || !/^\d+$/.test(parts[0])) throw new Error('STag 内容非法');
      return { size: payloadLen + 8, ekey: null, kind: 'STag', resource_id: parseInt(parts[0], 10), mid: parts[2] };
    }
    if (endsWith('QTag')) {
      var body2 = tail.subarray(0, tail.length - 4);
      var payload2 = body2.subarray(0, body2.length - 4);
      var sizeBytes2 = body2.subarray(body2.length - 4);
      var payloadLen2 = be32(sizeBytes2, 0);
      if (payload2.length < payloadLen2) throw new Error('QTag 长度不一致');
      var parts2 = utf8String(payload2.subarray(payload2.length - payloadLen2)).split(',');
      if (parts2.length !== 3 || parts2[2] !== '2' || !/^\d+$/.test(parts2[1])) throw new Error('QTag 内容非法');
      if (!isBase64Text(utf8Bytes(parts2[0]))) throw new Error('QTag EKey 非法');
      return { size: payloadLen2 + 8, ekey: parts2[0], kind: 'QTag', resource_id: parseInt(parts2[1], 10) };
    }
    if (endsWith('musicex\x00')) {
      var payload3 = tail.subarray(0, tail.length - 8);
      if (payload3.length < 4) throw new Error('MusicEx 过短');
      var data3 = payload3.subarray(0, payload3.length - 4);
      var versionBytes = payload3.subarray(payload3.length - 4);
      if (le32(versionBytes, 0) !== 1) throw new Error('MusicEx 版本不支持');
      if (data3.length < 4) throw new Error('MusicEx 过短');
      var lenBytes = data3.subarray(data3.length - 4);
      var payloadLen3 = le32(lenBytes, 0);
      if (payloadLen3 !== MUSICEX_BLOCK) throw new Error('MusicEx 长度非法 0x' + payloadLen3.toString(16));
      var inner = data3.subarray(data3.length - (payloadLen3 - 0x10));
      var mid = readUtf16le(inner.subarray(12, 12 + 60));
      var mediaFilename = readUtf16le(inner.subarray(12 + 60, 12 + 60 + 100));
      return { size: MUSICEX_BLOCK + 12, ekey: null, kind: 'MusicEx', mid: mid, media_filename: mediaFilename };
    }
    // PcV1Legacy：尾 4 字节小端长度
    var payload4 = tail.subarray(0, tail.length - 4);
    var sizeBytes4 = tail.subarray(tail.length - 4);
    var payloadLen4 = le32(sizeBytes4, 0);
    if (payloadLen4 > MAX_EKEY_LEN) return null;
    if (payload4.length < payloadLen4) throw new Error('PcV1Legacy 长度不一致');
    var ekeyBytes = payload4.subarray(payload4.length - payloadLen4);
    var zero = -1;
    for (var z = 0; z < ekeyBytes.length; z++) {
      if (ekeyBytes[z] === 0) { zero = z; break; }
    }
    if (zero !== -1) ekeyBytes = ekeyBytes.subarray(0, zero);
    if (!isBase64Text(ekeyBytes)) throw new Error('PcV1Legacy EKey 非法');
    return { size: payloadLen4 + 4, ekey: utf8String(ekeyBytes), kind: 'PcV1Legacy' };
  }

  function readQmcFooter(bytes) {
    if (bytes.length < 12) return null;
    var tail = bytes.subarray(Math.max(0, bytes.length - FOOTER_SAMPLE));
    return parseQmcFooter(tail);
  }

  function decodeQmcV1(bytes, name) {
    var out = qmc1Transform(bytes, V1_STATIC_KEY, 0);
    return out;
  }

  function decodeQmcV2(bytes, name, manualEkey) {
    var footer = null;
    try { footer = readQmcFooter(bytes); } catch (e) { footer = null; }
    if (!footer) {
      // 尝试静态 v1
      var head = qmc1Transform(bytes.subarray(0, 64), V1_STATIC_KEY, 0);
      if (sniffContainer(head) !== 'bin') return decodeQmcV1(bytes, name);
      throw new Error(name + ': 未找到 QMC 尾包或静态密钥特征');
    }
    var ekey = footer.ekey || manualEkey || null;
    if (!ekey) {
      throw new Error(name + ': ' + footer.kind + ' 类型无内嵌密钥，请在页面手动填写 EKey');
    }
    var master;
    try {
      master = deriveMasterKey(ekey);
    } catch (e) {
      throw new Error(name + ': EKey 解析失败（' + e.message + '）');
    }
    var stream = makeQmc2Stream(master);
    var audioLength = bytes.length - footer.size;
    if (audioLength <= 0) throw new Error(name + ': QMC 音频长度非法');
    var audio = bytes.subarray(0, audioLength);
    return stream.decrypt(audio, 0);
  }

  /* ---------------- NCM ---------------- */

  var NCM_MAGIC = 'CTENFDAM';
  var NCM_CORE_KEY = utf8Bytes('hzHRAmso5kInbaxW');
  var NCM_META_KEY = utf8Bytes("#14ljk_!\\]&0U<'(");
  var NCM_META_PREFIX = utf8Bytes("163 key(Don't modify):");

  function ncmParseMeta(blob) {
    var prefix = NCM_META_PREFIX;
    if (blob.length < prefix.length) return { tags: {}, format: '' };
    for (var i = 0; i < prefix.length; i++) {
      if (blob[i] !== prefix[i]) return { tags: {}, format: '' };
    }
    var payload;
    try {
      payload = b64ToBytes(utf8String(blob.subarray(prefix.length)));
    } catch (e) {
      return { tags: {}, format: '' };
    }
    var plain;
    try {
      // 同步路径：这里需要 AES，但 WebCrypto 是异步的。
      // 由外部（decodeNcm）先完成 meta 解密再调用本函数。
      throw new Error('placeholder');
    } catch (e) {
      return { tags: {}, format: '' };
    }
  }

  async function decodeNcm(bytes, name) {
    if (bytes.length < 0x2C) throw new Error(name + ': 文件过短，不是合法的 NCM');
    for (var m = 0; m < 8; m++) {
      if (bytes[m] !== NCM_MAGIC.charCodeAt(m)) throw new Error(name + ': 不是合法的 NCM 文件');
    }
    var off = 10;
    var keyLen = le32(bytes, off); off += 4;
    if (keyLen <= 0 || keyLen > 1 << 20) throw new Error(name + ': NCM 密钥长度非法');
    var keyBlob = new Uint8Array(keyLen);
    for (var i = 0; i < keyLen; i++) keyBlob[i] = bytes[off + i] ^ 0x64;
    off += keyLen;

    var keyPlain, rc4Key;
    try {
      keyPlain = await aesEcbDecrypt(NCM_CORE_KEY, keyBlob);
      rc4Key = keyPlain.subarray(17);
    } catch (e) {
      throw new Error(name + ': NCM 核心密钥解密失败');
    }
    if (!rc4Key.length) throw new Error(name + ': NCM 核心密钥为空');

    var metaLen = le32(bytes, off); off += 4;
    var metaBlob = new Uint8Array(0);
    if (metaLen) {
      if (metaLen > 64 << 20) throw new Error(name + ': NCM 元数据过大');
      metaBlob = new Uint8Array(metaLen);
      for (var j = 0; j < metaLen; j++) metaBlob[j] = bytes[off + j] ^ 0x63;
      off += metaLen;
    }

    var tags = {}, metaFormat = '';
    if (metaBlob.length >= NCM_META_PREFIX.length) {
      var isPrefix = true;
      for (var p = 0; p < NCM_META_PREFIX.length; p++) {
        if (metaBlob[p] !== NCM_META_PREFIX[p]) { isPrefix = false; break; }
      }
      if (isPrefix) {
        try {
          var payloadB64 = utf8String(metaBlob.subarray(NCM_META_PREFIX.length));
          var payload = b64ToBytes(payloadB64);
          var plainMeta = await aesEcbDecrypt(NCM_META_KEY, payload);
          var plainStr = utf8String(plainMeta);
          if (plainStr.indexOf('music:') === 0) {
            var data = JSON.parse(plainStr.slice(6));
            if (typeof data.musicName === 'string') tags.title = data.musicName;
            var artists = data.artist || [];
            if (Array.isArray(artists) && artists.length && Array.isArray(artists[0]) && artists[0].length) {
              tags.artist = String(artists[0][0]);
            }
            if (typeof data.album === 'string') tags.album = data.album;
            if (typeof data.format === 'string') metaFormat = data.format.toLowerCase();
          }
        } catch (e) { /* 元数据解析失败不影响解密 */ }
      }
    }

    off += 5; // 固定间隙
    var cover = null;
    if (off + 8 <= bytes.length) {
      var imageSpace = le32(bytes, off);
      var imageSize = le32(bytes, off + 4);
      off += 8;
      if (imageSize && imageSize <= 128 << 20 && off + imageSize <= bytes.length) {
        cover = bytes.subarray(off, off + imageSize);
      }
      // subarray 读取不推进游标，封面数据 + 冗余空间共 imageSpace 字节
      off += imageSpace;
    }
    var audioOffset = off;
    var audio = bytes.subarray(audioOffset);
    if (!audio.length) throw new Error(name + ': 音频流为空');
    var box = ncmStreamBytes(rc4Key);
    // NCM 音频第 i 字节使用 box[(i+1)&0xFF]（xorNcm 内部已加 1）
    var decoded = xorNcm(audio, box, 0);
    var container = KNOWN_CONTAINERS[metaFormat] ? metaFormat : sniffContainer(decoded.subarray(0, 64));
    return { container: container, tags: tags, cover: cover, payload: decoded, source: 'ncm' };
  }

  /* ---------------- 主入口：按扩展名/魔数识别并解密 ---------------- */

  function exportedVariants(name) {
    var lower = name.toLowerCase();
    var all = [];
    var i;
    for (var k in V1_EXTS) all.push(k);
    for (var k2 in V2_EXTS) all.push(k2);
    all.push('.ncm', '.kgm', '.kgma', '.vpr', '.kgm.flac', '.vpr.flac', '.kwm');
    all.sort(function (a, b) { return b.length - a.length; });
    for (i = 0; i < all.length; i++) {
      if (lower.endsWith(all[i])) return all[i];
    }
    return '';
  }

  function decodeFile(bytes, name, opts) {
    opts = opts || {};
    var ext = exportedVariants(name);
    var head = bytes.subarray(0, 16);
    var i;
    function magicEq(m) {
      for (var k = 0; k < m.length; k++) if (head[k] !== m[k]) return false;
      return true;
    }
    var kind = ext ? (V1_EXTS[ext] ? 'qmc-v1' : V2_EXTS[ext] ? 'qmc-v2' : ext === '.ncm' ? 'ncm' : (ext === '.kgm' || ext === '.kgma' || ext === '.vpr' || ext === '.kgm.flac' || ext === '.vpr.flac') ? 'kgm' : ext === '.kwm' ? 'kwm' : '') : '';
    if (!kind) {
      if (bytes.length >= 8 && utf8String(bytes.subarray(0, 8)) === NCM_MAGIC) kind = 'ncm';
      else if (magicEq(KGM_MAGIC) || magicEq(VPR_MAGIC)) kind = 'kgm';
      else {
        var tail = bytes.subarray(Math.max(0, bytes.length - FOOTER_SAMPLE));
        try {
          if (bytes.length >= 12 && parseQmcFooter(tail) !== null) kind = 'qmc-v2';
        } catch (e) { kind = ''; }
      }
    }
    if (!kind) throw new Error(name + ': 无法识别的加密格式');

    var result;
    switch (kind) {
      case 'ncm':
        return decodeNcm(bytes, name);
      case 'qmc-v1':
        result = { container: '', payload: decodeQmcV1(bytes, name), tags: {}, cover: null, source: 'qmc-v1' };
        break;
      case 'qmc-v2':
        result = { container: '', payload: decodeQmcV2(bytes, name, opts.ekey || null), tags: {}, cover: null, source: 'qmc-v2' };
        break;
      case 'kgm':
        return decodeKgm(bytes, name).then(function (out) {
          return { container: sniffContainer(out.subarray(0, 64)), payload: out, tags: {}, cover: null, source: 'kgm' };
        });
      case 'kwm':
        result = { container: '', payload: decodeKwm(bytes, name), tags: {}, cover: null, source: 'kwm' };
        break;
      default:
        throw new Error(name + ': 无法识别的加密格式');
    }
    result.container = sniffContainer(result.payload.subarray(0, 64));
    return Promise.resolve(result);
  }

  /* ---------------- 标签写入：MP3 (ID3v2.3) / FLAC ---------------- */

  function imageMime(cover) {
    return (cover.length >= 4 && cover[0] === 0x89 && cover[1] === 0x50 && cover[2] === 0x4E && cover[3] === 0x47)
      ? 'image/png' : 'image/jpeg';
  }

  function syncsafe(n) {
    return Uint8Array.from([(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F]);
  }

  /* UTF-16 LE（含 BOM）文本帧 —— ID3v2.3 编码 1，正确支持中文 */
  function utf16leBytes(text) {
    var out = [];
    var i;
    for (i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      out.push(code & 0xFF, (code >>> 8) & 0xFF);
    }
    return new Uint8Array(out);
  }

  function id3TextFrame(id, text) {
    if (!text) return null;
    var utf16 = utf16leBytes(text);
    var content = new Uint8Array(2 + utf16.length); // FF FE + UTF-16LE
    content[0] = 0xFF; content[1] = 0xFE;
    content.set(utf16, 2);
    var frame = new Uint8Array(4 + 4 + 2 + 1 + content.length);
    frame.set(utf8Bytes(id), 0);
    var size = 1 + content.length;
    frame[4] = (size >>> 24) & 0xFF;
    frame[5] = (size >>> 16) & 0xFF;
    frame[6] = (size >>> 8) & 0xFF;
    frame[7] = size & 0xFF;
    frame[8] = 0;
    frame[9] = 0;
    frame[10] = 1; // 编码：UTF-16 with BOM
    frame.set(content, 11);
    return frame;
  }

  function id3ApicFrame(cover) {
    var mime = utf8Bytes(imageMime(cover));
    var desc = utf8Bytes('cover');
    var contentLen = 1 + mime.length + 1 + 4 + 1 + desc.length + 1 + cover.length;
    var frame = new Uint8Array(10 + contentLen);
    frame.set(utf8Bytes('APIC'), 0);
    frame[4] = (contentLen >>> 24) & 0xFF;
    frame[5] = (contentLen >>> 16) & 0xFF;
    frame[6] = (contentLen >>> 8) & 0xFF;
    frame[7] = contentLen & 0xFF;
    frame[8] = 0;
    frame[9] = 0;
    var o = 10;
    frame[o++] = 0; // 文本编码
    frame.set(mime, o); o += mime.length;
    frame[o++] = 0; // mime 结束
    frame[o++] = 3; // 封面类型
    frame[o++] = 0; // 描述编码字节（描述为空）
    frame[o++] = 0; // 描述终止
    frame.set(cover, o);
    return frame;
  }

  function stripExistingId3(data) {
    if (data.length >= 10 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
      var size = ((data[6] & 0x7F) << 21) | ((data[7] & 0x7F) << 14) | ((data[8] & 0x7F) << 7) | (data[9] & 0x7F);
      var total = 10 + size;
      if (total <= data.length) return data.subarray(total);
    }
    return data;
  }

  function embedMp3Tags(payload, tags, cover) {
    var frames = [];
    var f;
    f = id3TextFrame('TIT2', tags.title); if (f) frames.push(f);
    f = id3TextFrame('TPE1', tags.artist); if (f) frames.push(f);
    f = id3TextFrame('TALB', tags.album); if (f) frames.push(f);
    if (cover && cover.length) frames.push(id3ApicFrame(cover));
    if (!frames.length) return payload;
    var bodyLen = 0, i;
    for (i = 0; i < frames.length; i++) bodyLen += frames[i].length;
    var tag = new Uint8Array(10 + bodyLen);
    tag.set(utf8Bytes('ID3'), 0);
    tag[3] = 3; tag[4] = 0; // ID3v2.3
    tag[5] = 0;
    var ss = syncsafe(bodyLen);
    tag.set(ss, 6);
    var off = 10;
    for (i = 0; i < frames.length; i++) {
      tag.set(frames[i], off);
      off += frames[i].length;
    }
    var audio = stripExistingId3(payload);
    var out = new Uint8Array(tag.length + audio.length);
    out.set(tag, 0);
    out.set(audio, tag.length);
    return out;
  }

  /* FLAC：插入 VORBIS_COMMENT(4) 与 PICTURE(6) 元数据块（紧随 STREAMINFO 之后） */
  function flacMetaHeader(type, dataLen) {
    var h = new Uint8Array(4);
    h[0] = type & 0x7F;
    h[1] = (dataLen >>> 16) & 0xFF;
    h[2] = (dataLen >>> 8) & 0xFF;
    h[3] = dataLen & 0xFF;
    return h;
  }

  function vorbisCommentBlock(tags) {
    var vendor = utf8Bytes('MusicKey');
    var comments = [];
    var keys = [['title', tags.title], ['artist', tags.artist], ['album', tags.album]];
    for (var i = 0; i < keys.length; i++) {
      if (keys[i][1]) comments.push(utf8Bytes(keys[i][0] + '=' + keys[i][1]));
    }
    var len = 4 + vendor.length + 4;
    for (var j = 0; j < comments.length; j++) len += 4 + comments[j].length;
    var block = new Uint8Array(len);
    var o = 0;
    block[o++] = vendor.length & 0xFF; block[o++] = (vendor.length >> 8) & 0xFF;
    block[o++] = (vendor.length >> 16) & 0xFF; block[o++] = (vendor.length >>> 24) & 0xFF;
    block.set(vendor, o); o += vendor.length;
    block[o++] = comments.length & 0xFF; block[o++] = (comments.length >> 8) & 0xFF;
    block[o++] = (comments.length >> 16) & 0xFF; block[o++] = (comments.length >>> 24) & 0xFF;
    for (var k = 0; k < comments.length; k++) {
      var cl = comments[k].length;
      block[o++] = cl & 0xFF; block[o++] = (cl >> 8) & 0xFF;
      block[o++] = (cl >> 16) & 0xFF; block[o++] = (cl >>> 24) & 0xFF;
      block.set(comments[k], o); o += cl;
    }
    return block;
  }

  function flacPictureBlock(cover) {
    var mime = utf8Bytes(imageMime(cover));
    var desc = utf8Bytes('');
    var dataLen = 4 + 4 + mime.length + 4 + desc.length + 4 + 4 + 4 + 4 + 4 + cover.length;
    var block = new Uint8Array(dataLen);
    var o = 0;
    block[o++] = 0; block[o++] = 0; block[o++] = 0; block[o++] = 3; // picture type=3（大端）
    // FLAC PICTURE 块内所有长度字段均为大端（与 VORBIS_COMMENT 的小端不同）
    var ml = mime.length;
    block[o++] = (ml >>> 24) & 0xFF; block[o++] = (ml >>> 16) & 0xFF;
    block[o++] = (ml >>> 8) & 0xFF; block[o++] = ml & 0xFF;
    block.set(mime, o); o += mime.length;
    block[o++] = 0; block[o++] = 0; block[o++] = 0; block[o++] = 0; // desc len=0
    block[o++] = 0; block[o++] = 0; block[o++] = 0; block[o++] = 0; // width
    block[o++] = 0; block[o++] = 0; block[o++] = 0; block[o++] = 0; // height
    block[o++] = 0; block[o++] = 0; block[o++] = 0; block[o++] = 0; // depth
    block[o++] = 0; block[o++] = 0; block[o++] = 0; block[o++] = 0; // colors
    var dl = cover.length;
    block[o++] = (dl >>> 24) & 0xFF; block[o++] = (dl >>> 16) & 0xFF;
    block[o++] = (dl >>> 8) & 0xFF; block[o++] = dl & 0xFF;
    block.set(cover, o);
    return block;
  }

  function embedFlacTags(payload, tags, cover) {
    if (payload.length < 4 || payload[0] !== 0x66 || payload[1] !== 0x4C || payload[2] !== 0x61 || payload[3] !== 0x43) {
      return payload;
    }
    var blocks = [];
    var off = 4;
    var extra = [];
    while (off < payload.length) {
      var isLast = (payload[off] & 0x80) !== 0;
      var type = payload[off] & 0x7F;
      var len = (payload[off + 1] << 16) | (payload[off + 2] << 8) | payload[off + 3];
      var header = payload.subarray(off, off + 4);
      var body = payload.subarray(off + 4, off + 4 + len);
      if (type === 0) {
        blocks.push({ header: header, body: body, type: 0 });
      } else {
        extra.push({ header: header, body: body, type: type });
      }
      off += 4 + len;
      if (isLast) break;
    }
    var newBlocks = [blocks[0]];
    var hasTags = !!(tags && (tags.title || tags.artist || tags.album));
    if (hasTags) {
      newBlocks.push({ header: flacMetaHeader(4, 0), body: vorbisCommentBlock(tags), type: 4 });
    }
    if (cover && cover.length) {
      newBlocks.push({ header: flacMetaHeader(6, 0), body: flacPictureBlock(cover), type: 6 });
    }
    for (var i = 0; i < extra.length; i++) newBlocks.push(extra[i]);
    var parts = [payload.subarray(0, 4)];
    var total = 0;
    var metas = [];
    for (var b = 0; b < newBlocks.length; b++) {
      var meta = newBlocks[b];
      // FLAC 最后一个元数据块必须置 last 标志，其后即为音频帧
      var isLastBlock = (b === newBlocks.length - 1);
      var h = new Uint8Array(4);
      h[0] = (meta.type & 0x7F) | (isLastBlock ? 0x80 : 0);
      h[1] = (meta.body.length >>> 16) & 0xFF;
      h[2] = (meta.body.length >>> 8) & 0xFF;
      h[3] = meta.body.length & 0xFF;
      metas.push(h);
      metas.push(meta.body);
    }
    parts.push(concatBytes(metas));
    if (off < payload.length) parts.push(payload.subarray(off));
    return concatBytes(parts);
  }

  /* ---------------- 简单 ZIP（store 方式） ---------------- */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* files: [{name, data(Uint8Array)}] → Uint8Array (zip, store) */
  function makeZip(files) {
    var parts = [];
    var central = [];
    var offset = 0;
    var i;
    for (i = 0; i < files.length; i++) {
      var nameBytes = utf8Bytes(files[i].name);
      var data = files[i].data;
      var crc = crc32(data);
      var local = new Uint8Array(30 + nameBytes.length);
      local[0] = 0x50; local[1] = 0x4B; local[2] = 0x03; local[3] = 0x04;
      local[4] = 20; local[5] = 0;      // 版本 2.0
      local[6] = 0; local[7] = 0x08;     // 通用标志：bit11=1 文件名用 UTF-8（否则 Windows 按 GBK 解会乱码）
      local[8] = 0; local[9] = 0;       // store
      local[10] = 0; local[11] = 0;
      local[12] = 0; local[13] = 0;
      local[14] = 0; local[15] = 0;
      local[14] = crc & 0xFF; local[15] = (crc >>> 8) & 0xFF;
      local[16] = (crc >>> 16) & 0xFF; local[17] = (crc >>> 24) & 0xFF;
      var dl = data.length;
      local[18] = dl & 0xFF; local[19] = (dl >>> 8) & 0xFF;
      local[20] = (dl >>> 16) & 0xFF; local[21] = (dl >>> 24) & 0xFF;
      local[22] = dl & 0xFF; local[23] = (dl >>> 8) & 0xFF;
      local[24] = (dl >>> 16) & 0xFF; local[25] = (dl >>> 24) & 0xFF;
      local[26] = nameBytes.length & 0xFF; local[27] = (nameBytes.length >>> 8) & 0xFF;
      local[28] = 0; local[29] = 0; // 无扩展字段
      local.set(nameBytes, 30);
      parts.push(local, data);
      var ch = new Uint8Array(46 + nameBytes.length);
      ch[0] = 0x50; ch[1] = 0x4B; ch[2] = 0x01; ch[3] = 0x02;
      ch[4] = 20; ch[5] = 0;
      ch[6] = 20; ch[7] = 0;
      ch[8] = 0; ch[9] = 0x08;       // 通用标志：bit11=1 文件名 UTF-8（与本地头一致）
      ch[10] = 0; ch[11] = 0;
      ch[12] = 0; ch[13] = 0;
      ch[14] = 0; ch[15] = 0;
      ch[16] = crc & 0xFF; ch[17] = (crc >>> 8) & 0xFF;
      ch[18] = (crc >>> 16) & 0xFF; ch[19] = (crc >>> 24) & 0xFF;
      ch[20] = dl & 0xFF; ch[21] = (dl >>> 8) & 0xFF;
      ch[22] = (dl >>> 16) & 0xFF; ch[23] = (dl >>> 24) & 0xFF;
      ch[24] = dl & 0xFF; ch[25] = (dl >>> 8) & 0xFF;
      ch[26] = (dl >>> 16) & 0xFF; ch[27] = (dl >>> 24) & 0xFF;
      ch[28] = nameBytes.length & 0xFF; ch[29] = (nameBytes.length >>> 8) & 0xFF;
      ch[30] = 0; ch[31] = 0; ch[32] = 0; ch[33] = 0;
      ch[34] = 0; ch[35] = 0;
      ch[36] = 0; ch[37] = 0; ch[38] = 0; ch[39] = 0;
      ch[40] = 0; ch[41] = 0;
      ch[42] = offset & 0xFF; ch[43] = (offset >>> 8) & 0xFF;
      ch[44] = (offset >>> 16) & 0xFF; ch[45] = (offset >>> 24) & 0xFF;
      ch.set(nameBytes, 46);
      central.push(ch);
      offset += local.length + data.length;
    }
    var centralSize = 0;
    for (i = 0; i < central.length; i++) centralSize += central[i].length;
    var eocd = new Uint8Array(22);
    eocd[0] = 0x50; eocd[1] = 0x4B; eocd[2] = 0x05; eocd[3] = 0x06;
    eocd[4] = 0; eocd[5] = 0;
    eocd[6] = 0; eocd[7] = 0;
    eocd[8] = files.length & 0xFF; eocd[9] = (files.length >>> 8) & 0xFF;
    eocd[10] = files.length & 0xFF; eocd[11] = (files.length >>> 8) & 0xFF;
    eocd[12] = centralSize & 0xFF; eocd[13] = (centralSize >>> 8) & 0xFF;
    eocd[14] = (centralSize >>> 16) & 0xFF; eocd[15] = (centralSize >>> 24) & 0xFF;
    eocd[16] = offset & 0xFF; eocd[17] = (offset >>> 8) & 0xFF;
    eocd[18] = (offset >>> 16) & 0xFF; eocd[19] = (offset >>> 24) & 0xFF;
    eocd[20] = 0; eocd[21] = 0;
    for (i = 0; i < central.length; i++) parts.push(central[i]);
    parts.push(eocd);
    return concatBytes(parts);
  }

  /* ============================================================
   * LZMA1 解码器（参考 LzmaSpec.cpp，Igor Pavlov，public domain）
   * 输入：.lzma（FORMAT_ALONE）完整数据，输出：Uint8Array
   * ============================================================ */

  function lzma1Decompress(input) {
    var src = bytesToU8(input);
    if (src.length < 13) throw new Error('LZMA: 数据过短');

    var props = src[0];
    if (props >= 9 * 5 * 5) throw new Error('LZMA: 属性非法');
    var lc = props % 9;
    var d = Math.floor(props / 9);
    var pb = Math.floor(d / 5);
    var lp = d % 5;

    var dictSizeInProps = le32(src, 1);
    var dictSize = dictSizeInProps;
    if (dictSize < 1 << 12) dictSize = 1 << 12;

    var unpackSize = 0;
    var unpackSizeDefined = false;
    for (var u = 0; u < 8; u++) {
      var b = src[5 + u];
      if (b !== 0xFF) unpackSizeDefined = true;
      unpackSize |= b << (8 * u);
    }

    /* 范围解码器 */
    var inPos = 13;
    var range = 0xFFFFFFFF;
    var code = 0;
    var initByte = src[inPos++];
    var i;
    for (i = 0; i < 4; i++) code = ((code << 8) | src[inPos++]) >>> 0;
    var corrupted = false;
    if (initByte !== 0 || code === range) corrupted = true;

    function normalize() {
      if (range < 0x1000000) {
        range = (range << 8) >>> 0;
        code = ((code << 8) | (inPos < src.length ? src[inPos++] : 0)) >>> 0;
      }
    }

    var PROB_INIT = 1024;

    function decodeBit(probs, idx) {
      var v = probs[idx];
      var bound = ((range >>> 11) * v) >>> 0;
      var symbol;
      if (code < bound) {
        v += ((2048 - v) >> 5) >>> 0;
        range = bound;
        symbol = 0;
      } else {
        v -= v >> 5;
        code = (code - bound) >>> 0;
        range = (range - bound) >>> 0;
        symbol = 1;
      }
      probs[idx] = v & 0xFFFF;
      normalize();
      return symbol;
    }

    function decodeDirectBits(numBits) {
      var res = 0;
      do {
        range = (range >>> 1) >>> 0;
        code = (code - range) >>> 0;
        var t = (0 - ((code >>> 31))) >>> 0;
        code = (code + (range & t)) >>> 0;
        if (code === range) corrupted = true;
        normalize();
        res = (res << 1) >>> 0;
        res = (res + t + 1) >>> 0;
      } while (--numBits);
      return res;
    }

    function bitTreeDecode(probs, base, numBits) {
      var m = 1;
      for (var i = 0; i < numBits; i++) m = (m << 1) + decodeBit(probs, base + m);
      return (m - (1 << numBits)) >>> 0;
    }

    function bitTreeReverseDecode(probs, base, numBits) {
      var m = 1;
      var symbol = 0;
      for (var i = 0; i < numBits; i++) {
        var bit = decodeBit(probs, base + m);
        m = (m << 1) + bit;
        symbol |= (bit << i);
      }
      return symbol >>> 0;
    }

    var numPosStates = 1 << pb;
    var numPosStatesMax = 1 << 4;
    var kNumLenToPosStates = 4;
    var kNumAlignBits = 4;
    var kEndPosModelIndex = 14;
    var kNumFullDistances = 1 << (kEndPosModelIndex >> 1);
    var kMatchMinLen = 2;
    var kNumStates = 12;

    /* 概率数组（Uint16Array） */
    function makeProbs(n) {
      var p = new Uint16Array(n);
      for (var i = 0; i < n; i++) p[i] = PROB_INIT;
      return p;
    }

    // 字面量概率：0x300 << (lc + lp)
    var litProbs = makeProbs(0x300 << (lc + lp));
    // isMatch: kNumStates * numPosStatesMax
    var isMatch = makeProbs(kNumStates * numPosStatesMax);
    var isRep = makeProbs(kNumStates);
    var isRepG0 = makeProbs(kNumStates);
    var isRepG1 = makeProbs(kNumStates);
    var isRepG2 = makeProbs(kNumStates);
    var isRep0Long = makeProbs(kNumStates * numPosStatesMax);
    // posSlot: 4 个 6 位 bit tree，每个 64 probs
    var posSlot = makeProbs(kNumLenToPosStates * 64);
    // posDecoders: 1 + kNumFullDistances - kEndPosModelIndex = 1 + 128 - 14 = 115
    var posDecoders = makeProbs(1 + kNumFullDistances - kEndPosModelIndex);
    // align: 16
    var align = makeProbs(16);

    /* 长度解码器（两个：match 与 rep） */
    function makeLenCoder() {
      return {
        choice: PROB_INIT,
        choice2: PROB_INIT,
        low: makeProbs(numPosStatesMax * 8),
        mid: makeProbs(numPosStatesMax * 8),
        high: makeProbs(256)
      };
    }
    var lenCoder = makeLenCoder();
    var repLenCoder = makeLenCoder();

    /* 输出 */
    var out;
    if (unpackSizeDefined) {
      out = new Uint8Array(unpackSize);
    } else {
      out = new Uint8Array(Math.max(1 << 20, dictSize * 2));
    }
    var outPos = 0;

    function putByte(b) {
      if (outPos >= out.length) {
        if (unpackSizeDefined) throw new Error('LZMA: 输出超出预期大小');
        var bigger = new Uint8Array(out.length * 2);
        bigger.set(out);
        out = bigger;
      }
      out[outPos++] = b;
    }
    function getByte(dist) {
      return out[outPos - dist];
    }

    function decodeLiteral(state, rep0) {
      var prevByte = 0;
      if (outPos > 0) prevByte = out[outPos - 1];
      var symbol = 1;
      var litState = (((outPos & ((1 << lp) - 1)) << lc) + (prevByte >> (8 - lc))) >>> 0;
      var probsBase = 0x300 * litState;
      if (state >= 7) {
        var matchByte = out[outPos - rep0 - 1];
        do {
          var matchBit = (matchByte >> 7) & 1;
          matchByte = (matchByte << 1) & 0xFF;
          var bit = decodeBit(litProbs, probsBase + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) {
        symbol = (symbol << 1) | decodeBit(litProbs, probsBase + symbol);
      }
      putByte((symbol - 0x100) & 0xFF);
    }

    function decodeDistance(len) {
      var lenState = len;
      if (lenState > kNumLenToPosStates - 1) lenState = kNumLenToPosStates - 1;
      var posSlotVal = bitTreeDecode(posSlot, lenState * 64, 6);
      if (posSlotVal < 4) return posSlotVal;
      var numDirectBits = ((posSlotVal >> 1) - 1) >>> 0;
      var dist = ((2 | (posSlotVal & 1)) << numDirectBits) >>> 0;
      if (posSlotVal < kEndPosModelIndex) {
        dist = (dist + bitTreeReverseDecode(posDecoders, (dist - posSlotVal) >>> 0, numDirectBits)) >>> 0;
      } else {
        dist = (dist + (decodeDirectBits(numDirectBits - kNumAlignBits) << kNumAlignBits)) >>> 0;
        dist = (dist + bitTreeReverseDecode(align, 0, kNumAlignBits)) >>> 0;
      }
      return dist;
    }

    function updateStateLiteral(state) {
      if (state < 4) return 0;
      if (state < 10) return state - 3;
      return state - 6;
    }
    function updateStateMatch(state) { return state < 7 ? 7 : 10; }
    function updateStateRep(state) { return state < 7 ? 8 : 11; }
    function updateStateShortRep(state) { return state < 7 ? 9 : 11; }

    var rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
    var state = 0;
    var remaining = unpackSizeDefined ? unpackSize : -1;

    function decodeChoiceBit(coder, which) {
      var v = which === 0 ? coder.choice : coder.choice2;
      var bound = ((range >>> 11) * v) >>> 0;
      var symbol;
      if (code < bound) {
        v += ((2048 - v) >> 5) >>> 0;
        range = bound;
        symbol = 0;
      } else {
        v -= v >> 5;
        code = (code - bound) >>> 0;
        range = (range - bound) >>> 0;
        symbol = 1;
      }
      if (which === 0) coder.choice = v & 0xFFFF;
      else coder.choice2 = v & 0xFFFF;
      normalize();
      return symbol;
    }
    function decodeLen2(coder, posState) {
      if (decodeChoiceBit(coder, 0) === 0) {
        return bitTreeDecode(coder.low, posState * 8, 3);
      }
      if (decodeChoiceBit(coder, 1) === 0) {
        return 8 + bitTreeDecode(coder.mid, posState * 8, 3);
      }
      return 16 + bitTreeDecode(coder.high, 0, 8);
    }

    var guard = 0;
    var MAX_GUARD = unpackSizeDefined ? (unpackSize + 16) : (1 << 28);

    while (true) {
      if (++guard > MAX_GUARD + 1024) throw new Error('LZMA: 解码循环超限');
      var posState = outPos & (numPosStates - 1);
      if (unpackSizeDefined && remaining === 0) break;

      var isMatchBit = decodeBit(isMatch, (state << 4) + posState);
      if (isMatchBit === 0) {
        if (unpackSizeDefined && remaining === 0) throw new Error('LZMA: 多余数据');
        decodeLiteral(state, rep0);
        state = updateStateLiteral(state);
        if (remaining > 0) remaining--;
        continue;
      }

      var len;
      var isRepBit = decodeBit(isRep, state);
      if (isRepBit !== 0) {
        if (outPos === 0) throw new Error('LZMA: 无效的重复匹配');
        var isRepG0Bit = decodeBit(isRepG0, state);
        if (isRepG0Bit === 0) {
          var isRep0LongBit = decodeBit(isRep0Long, (state << 4) + posState);
          if (isRep0LongBit === 0) {
            state = updateStateShortRep(state);
            putByte(getByte(rep0 + 1));
            if (remaining > 0) remaining--;
            continue;
          }
        } else {
          var dist2;
          if (decodeBit(isRepG1, state) === 0) {
            dist2 = rep1;
          } else {
            if (decodeBit(isRepG2, state) === 0) {
              dist2 = rep2;
            } else {
              dist2 = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist2;
        }
        len = decodeLen2(repLenCoder, posState);
        state = updateStateRep(state);
      } else {
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        len = decodeLen2(lenCoder, posState);
        state = updateStateMatch(state);
        rep0 = decodeDistance(len);
        if (rep0 === 0xFFFFFFFF) {
          if (code === 0) break;
          throw new Error('LZMA: 结束标记异常');
        }
        // 距离必须指向已输出的字节（复制使用 GetByte(rep0+1)）
        if (rep0 + 1 > outPos) throw new Error('LZMA: 距离越界');
        if (rep0 >= dictSize) throw new Error('LZMA: 距离超字典');
      }
      len += kMatchMinLen;
      var toCopy = len;
      if (unpackSizeDefined && remaining < toCopy) {
        toCopy = remaining;
      }
      for (var c = 0; c < toCopy; c++) {
        putByte(getByte(rep0 + 1));
      }
      if (unpackSizeDefined) remaining -= toCopy;
    }

    if (unpackSizeDefined && outPos !== unpackSize) {
      throw new Error('LZMA: 输出大小不符 (' + outPos + ' != ' + unpackSize + ')');
    }
    if (unpackSizeDefined) return out;
    return out.subarray(0, outPos);
  }

  /* ---------------- 导出 ---------------- */

  var MusicKeyCore = {
    lzma1Decompress: lzma1Decompress,
    sniffContainer: sniffContainer,
    decodeFile: decodeFile,
    decodeNcm: decodeNcm,
    decodeQmcV1: decodeQmcV1,
    decodeQmcV2: decodeQmcV2,
    decodeKgm: decodeKgm,
    decodeKwm: decodeKwm,
    deriveMasterKey: deriveMasterKey,
    embedMp3Tags: embedMp3Tags,
    embedFlacTags: embedFlacTags,
    makeZip: makeZip,
    getKgmPubKey: getKgmPubKey,
    b64ToBytes: b64ToBytes,
    utf8Bytes: utf8Bytes,
    utf8String: utf8String,
    toHex: toHex,
    qmc1Transform: qmc1Transform,
    makeQmc2Stream: makeQmc2Stream,
    ncmStreamBytes: ncmStreamBytes,
    parseQmcFooter: parseQmcFooter,
    teaCbcDecrypt: teaCbcDecrypt,
    teaDecryptBlock32: teaDecryptBlock32,
    simpleKey8: simpleKey8,
    aesEcbDecrypt: aesEcbDecrypt,
    OUT_EXT: OUT_EXT,
    KNOWN_CONTAINERS: KNOWN_CONTAINERS
  };

  global.MusicKeyCore = MusicKeyCore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MusicKeyCore;
  }
})(typeof window !== 'undefined' ? window : globalThis);
