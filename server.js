/* ============================================================
 * MusicKey 服务端降级解密（零依赖，仅用 Node.js 内置模块）
 * ------------------------------------------------------------
 * 启动：node server.js
 * 端口：优先 fixedPort（若配置且空闲），否则从 startPort 开始扫描
 * 目录：
 *   update/<clientId>/<jobId>/    —— 上传的原始文件（含文件夹结构）
 *   download/<clientId>/<jobId>/  —— 解密输出文件（含文件夹结构）
 *   download/<clientId>/<jobId>.zip —— 打包好的 ZIP
 *   logs/                         —— 日志文件
 * 流程：
 *   POST /upload/:jobId   → 单文件逐个上传
 *   GET  /status/:jobId   → 查询解密进度
 *   POST /decrypt/:jobId  → 逐个解密
 *   POST /pack/:jobId     → 流式打包 ZIP
 *   GET  /download/:jobId → 下载已打包 ZIP
 * ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

/* 运行目录：打包后可写文件放在 exe 同目录 */
const externalDir = (typeof process.pkg !== 'undefined')
  ? path.dirname(process.execPath)
  : __dirname;

/* ---------- CRC32 ---------- */
const crcTable = (function() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/* ---------- 加载配置 ---------- */
const configPath = path.join(externalDir, 'config.json');
let config = { startPort: 3000, maxScan: 100, fixedPort: 0, cpuThreads: 4, maxMemory: 8192 };
try {
  config = Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf8')));
} catch (e) {
  console.log('config.json not found, creating default');
  try {
    fs.writeFileSync(configPath, JSON.stringify({
      startPort: 3000,
      maxScan: 100,
      fixedPort: 3001,
      cpuThreads: 2,
      maxMemory: 1024,
      chunkSizeMB: 10
    }, null, 2));
  } catch(e2) { console.log('Cannot write config: ' + e2.message); }
}

/* ---------- 日志系统 ---------- */
const LOGS_DIR = path.join(externalDir, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

/* 生成清理脚本 */
const cleanupBat = path.join(externalDir, "清理临时文件.bat");
try {
  if (!fs.existsSync(cleanupBat)) {
    fs.writeFileSync(cleanupBat,
      "@echo off\r\n" +
      "cd /d \"%~dp0\"\r\n" +
      "echo Cleaning update...\r\n" +
      "del /q /s update\\*.* >nul 2>&1\r\n" +
      "for /d %%x in (update\\*) do @rd /s /q \"%%x\" >nul 2>&1\r\n" +
      "echo Cleaning download...\r\n" +
      "del /q /s download\\*.* >nul 2>&1\r\n" +
      "for /d %%x in (download\\*) do @rd /s /q \"%%x\" >nul 2>&1\r\n" +
      "echo Done.\r\n"
    );
  }
} catch(e) {}

let logStream = null;
let logBuffer = [];

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function logFileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth()+1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.txt';
}

function openLogStream() {
  if (logStream) { try { logStream.end(); } catch(e) {} }
  const fpath = path.join(LOGS_DIR, logFileName());
  logStream = fs.createWriteStream(fpath, { flags: 'a' });
  /* 写入缓冲中的日志 */
  for (const line of logBuffer) logStream.write(line + '\n');
  logBuffer = [];
}

function log(msg) {
  const line = '[' + ts() + '] ' + msg;
  console.log(line);
  if (logStream) {
    logStream.write(line + '\n');
  } else {
    logBuffer.push(line);
  }
}

/* 每小时切日志 */
setInterval(function() {
  openLogStream();
}, 3600 * 1000);

/* 进程关闭时写日志 */
function flushAndExit() {
  if (logStream) { try { logStream.end(); } catch(e) {} }
}
process.on('exit', flushAndExit);
process.on('SIGINT', function() { flushAndExit(); process.exit(0); });
process.on('SIGTERM', function() { flushAndExit(); process.exit(0); });

/* 启动第一个日志文件 */
openLogStream();
log('===== MusicKey Server 启动 =====');

/* ---------- 加载解密核心（与前端共用同一份代码） ---------- */
const CORE_DIR = path.join(__dirname, 'core');
require('./core/musickey-key.js');
const MusicKeyCore = require('./core/musickey-core.js');

const UPDATE_DIR = path.join(externalDir, 'update');
const DOWNLOAD_DIR = path.join(externalDir, 'download');

if (!fs.existsSync(UPDATE_DIR)) fs.mkdirSync(UPDATE_DIR, { recursive: true });
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

/* ---------- 工具函数 ---------- */
function mkdirRecursive(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function collectFiles(dirPath, out) {
  out = out || [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  entries.forEach(entry => {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else {
      out.push(full);
    }
  });
  return out;
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}
function baseOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}
function outputPathOf(relPath, outExt) {
  const slash = relPath.lastIndexOf('/');
  const dir = slash >= 0 ? relPath.slice(0, slash + 1) : '';
  const fname = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  return dir + baseOf(fname) + '.' + outExt;
}

const PASSTHROUGH_EXT = ['.lrc', '.mp3', '.flac', '.wav', '.ogg', '.m4a', '.txt', '.jpg', '.jpeg', '.png', '.gif'];
function isPassthrough(name) {
  const lower = name.toLowerCase();
  return PASSTHROUGH_EXT.some(ext => lower.endsWith(ext));
}

/* ---------- 极简 multipart/form-data 解析器 ---------- */
function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  let start = buffer.indexOf(boundaryBuf);
  if (start === -1) return parts;

  start += boundaryBuf.length;
  while (start < buffer.length) {
    const end = buffer.indexOf(boundaryBuf, start);
    if (end === -1) break;

    let partStart = start;
    let partEnd = end;
    if (buffer[partStart] === 13 && buffer[partStart + 1] === 10) partStart += 2;
    if (buffer[partEnd - 2] === 13 && buffer[partEnd - 1] === 10) partEnd -= 2;

    const part = buffer.slice(partStart, partEnd);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      start = end + boundaryBuf.length;
      continue;
    }

    const headers = part.slice(0, headerEnd).toString('utf8');
    const body = part.slice(headerEnd + 4);

    const cdMatch = headers.match(/Content-Disposition:.*?filename="([^"]*)"/i);
    const nameMatch = headers.match(/Content-Disposition:.*?name="([^"]*)"/i);

    parts.push({
      filename: cdMatch ? cdMatch[1] : null,
      name: nameMatch ? nameMatch[1] : '',
      data: body
    });

    start = end + boundaryBuf.length;
  }
  return parts;
}

/* ---------- 打包进度状态（内存中） ---------- */
const packProgress = {}; // { jobId: { total, done, status: 'packing'|'done'|'error' } }

/* ---------- HTTP 服务 ---------- */
const server = http.createServer(async (req, res) => {
  /* CORS */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  /* 静态文件服务 */
  if (req.method === 'GET') {
    const PUBLIC_DIR = path.join(__dirname, 'public');
    let filePath = path.normalize(path.join(PUBLIC_DIR, url.pathname));
    if (url.pathname === '/' || url.pathname === '') filePath = path.join(PUBLIC_DIR, 'index.html');
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    } catch (e) { /* fall through to API */ }
  }

  /* POST /upload/:jobId?clientId=xxx —— 单文件逐个上传 */
  if (req.method === 'POST' && url.pathname.startsWith('/upload/')) {
    try {
      const jobId = url.pathname.split('/')[2];
      const clientId = url.searchParams.get('clientId') || 'default';
      const updateJobDir = path.join(UPDATE_DIR, clientId, jobId);
      mkdirRecursive(updateJobDir);

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);

      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=([^;]+)/);
      if (!boundaryMatch) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 boundary' }));
        return;
      }

      const parts = parseMultipart(body, boundaryMatch[1]);
      const filePart = parts.find(p => p.filename);
      if (!filePart) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '没有文件' }));
        return;
      }

      const updatePath = path.join(updateJobDir, filePart.filename);
      mkdirRecursive(path.dirname(updatePath));
      fs.writeFileSync(updatePath, filePart.data);

      log('上传: client=' + clientId + ' job=' + jobId + ' file=' + filePart.filename + ' (' + filePart.data.length + ' bytes)');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, jobId, saved: filePart.filename }));
    } catch (e) {
      log('上传错误: ' + e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  /* POST /merge/:jobId?clientId=xxx&filename=xxx —— 合并分块文件 */
  if (req.method === 'POST' && url.pathname.startsWith('/merge/')) {
    try {
      const jobId = url.pathname.split('/')[2];
      const clientId = url.searchParams.get('clientId') || 'default';
      const filename = url.searchParams.get('filename') || 'unknown';
      const updateJobDir = path.join(UPDATE_DIR, clientId, jobId);

      /* 找出所有 .partN 文件并按顺序合并 */
      const parts = [];
      const prefix = path.basename(filename) + '.part';
      const dir = path.dirname(path.join(updateJobDir, filename));
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (f.startsWith(prefix)) {
            const idx = parseInt(f.substring(prefix.length));
            if (!isNaN(idx)) parts.push({ idx, file: path.join(dir, f) });
          }
        }
      }
      parts.sort((a, b) => a.idx - b.idx);

      if (parts.length === 0) throw new Error('没有找到分块文件');

      const outPath = path.join(updateJobDir, filename);
      mkdirRecursive(path.dirname(outPath));
      const writeStream = fs.createWriteStream(outPath);
      for (const p of parts) {
        writeStream.write(fs.readFileSync(p.file));
        fs.unlinkSync(p.file);
      }
      writeStream.end();

      log('分块合并: ' + filename + ' 共 ' + parts.length + ' 块');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, filename, chunks: parts.length }));
    } catch (e) {
      log('合并错误: ' + e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  /* GET /status/:jobId?clientId=xxx —— 返回解密进度（total 从 update/ 读，done 从 download/ 读） */
  if (req.method === 'GET' && url.pathname.startsWith('/status/')) {
    const jobId = url.pathname.split('/')[2];
    const clientId = url.searchParams.get('clientId') || 'default';
    const updateJobDir = path.join(UPDATE_DIR, clientId, jobId);
    const downloadJobDir = path.join(DOWNLOAD_DIR, clientId, jobId);

    let total = 0, done = 0;
    if (fs.existsSync(updateJobDir)) {
      total = collectFiles(updateJobDir).length;
    }
    if (fs.existsSync(downloadJobDir)) {
      /* 只算文件，不算 .zip */
      done = collectFiles(downloadJobDir).filter(f => !f.endsWith('.zip')).length;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, total: total, done: done }));
    return;
  }

  /* POST /decrypt/:jobId?clientId=xxx —— 逐个解密 */
  if (req.method === 'POST' && url.pathname.startsWith('/decrypt/')) {
    const jobId = url.pathname.split('/')[2];
    const clientId = url.searchParams.get('clientId') || 'default';
    const updateJobDir = path.join(UPDATE_DIR, clientId, jobId);
    const downloadJobDir = path.join(DOWNLOAD_DIR, clientId, jobId);

    if (!fs.existsSync(updateJobDir)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'job 不存在' }));
      return;
    }

    try {
      mkdirRecursive(downloadJobDir);
      const allFiles = collectFiles(updateJobDir);
      let done = 0, failed = 0;

      log('解密开始: client=' + clientId + ' job=' + jobId + ' 共 ' + allFiles.length + ' 个文件');

      for (const fullPath of allFiles) {
        const relPath = path.relative(updateJobDir, fullPath).replace(/\\/g, '/');
        const fname = path.basename(fullPath);

        try {
          if (isPassthrough(fname)) {
            const outPath = path.join(downloadJobDir, relPath);
            mkdirRecursive(path.dirname(outPath));
            fs.copyFileSync(fullPath, outPath);
            done++;
            log('解密完成(透传): ' + relPath);
            /* 让出事件循环，让 /status 轮询能响应 */
            await new Promise(r => setImmediate(r));
            continue;
          }

          const buf = fs.readFileSync(fullPath);
          const result = await MusicKeyCore.decodeFile(new Uint8Array(buf), fname, {});
          let payload = result.payload;
          let container = result.container || 'bin';

          const hasTags = !!(result.tags && (result.tags.title || result.tags.artist || result.tags.album));
          const hasCover = !!(result.cover && result.cover.length);
          if (container === 'mp3' && (hasTags || hasCover)) {
            payload = MusicKeyCore.embedMp3Tags(payload, result.tags || {}, result.cover || null);
          } else if (container === 'flac' && (hasTags || hasCover)) {
            payload = MusicKeyCore.embedFlacTags(payload, result.tags || {}, result.cover || null);
          }

          const outExt = container === 'bin' ? (extOf(fname) || 'bin') : container;
          const outRel = outputPathOf(relPath, outExt);
          const outPath = path.join(downloadJobDir, outRel);
          mkdirRecursive(path.dirname(outPath));
          fs.writeFileSync(outPath, Buffer.from(payload));

          done++;
          log('解密完成: ' + relPath + ' → ' + outRel + ' (' + (payload.length/1024).toFixed(1) + ' KB)');
        } catch (e) {
          try {
            const outPath = path.join(downloadJobDir, relPath);
            mkdirRecursive(path.dirname(outPath));
            fs.copyFileSync(fullPath, outPath);
            failed++;
            log('解密失败(保留原文件): ' + relPath + ' — ' + e.message);
          } catch (e2) { failed++; }
        }
        /* 让出事件循环 */
        await new Promise(r => setImmediate(r));
      }

      log('解密结束: job=' + jobId + ' 成功=' + done + ' 失败=' + failed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, jobId, done, failed }));
    } catch (e) {
      log('解密错误: ' + e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  /* POST /pack/:jobId?clientId=xxx —— 流式打包到磁盘 */
  if (req.method === 'POST' && url.pathname.startsWith('/pack/')) {
    const jobId = url.pathname.split('/')[2];
    const clientId = url.searchParams.get('clientId') || 'default';
    const downloadJobDir = path.join(DOWNLOAD_DIR, clientId, jobId);
    const zipPath = path.join(DOWNLOAD_DIR, clientId, jobId + '.zip');

    if (!fs.existsSync(downloadJobDir)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'job 不存在' }));
      return;
    }

    try {
      const outFiles = collectFiles(downloadJobDir).filter(f => !f.endsWith('.zip'));
      const total = outFiles.length;
      let done = 0;
      const ZIP64_LIMIT = 0xFFFFFFFF;

      packProgress[jobId] = { total, done: 0, status: 'packing' };
      log('打包开始: client=' + clientId + ' job=' + jobId + ' 共 ' + total + ' 个文件');

      const outStream = fs.createWriteStream(zipPath);
      let streamError = null;
      outStream.on('error', function(err) {
        streamError = err;
        log('打包写盘错误: ' + err.message);
      });

      const centralDir = [];
      let offset = 0;

      for (const fullPath of outFiles) {
        const relName = path.relative(downloadJobDir, fullPath).replace(/\\/g, '/');
        const nameBuf = Buffer.from(relName, 'utf8');
        const fileData = fs.readFileSync(fullPath);
        const crc = crc32(fileData);
        const size = fileData.length;
        const needZip64File = size > ZIP64_LIMIT;

        let localExtraLen = 0;
        let localExtra = null;
        if (needZip64File) {
          localExtra = Buffer.alloc(20);
          localExtra.writeUInt16LE(0x0001, 0);
          localExtra.writeUInt16LE(16, 2);
          localExtra.writeBigUInt64LE(BigInt(size), 4);
          localExtra.writeBigUInt64LE(BigInt(size), 12);
          localExtraLen = 20;
        }

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(needZip64File ? 45 : 20, 4);
        localHeader.writeUInt16LE(0x0800, 6);
        localHeader.writeUInt16LE(0, 8);
        localHeader.writeUInt16LE(0, 10);
        localHeader.writeUInt16LE(0, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(needZip64File ? ZIP64_LIMIT : size, 18);
        localHeader.writeUInt32LE(needZip64File ? ZIP64_LIMIT : size, 22);
        localHeader.writeUInt16LE(nameBuf.length, 26);
        localHeader.writeUInt16LE(localExtraLen, 28);

        if (!outStream.write(localHeader)) {
          await new Promise(r => outStream.once('drain', r));
        }
        outStream.write(nameBuf);
        if (localExtra) outStream.write(localExtra);
        if (!outStream.write(fileData)) {
          await new Promise(r => outStream.once('drain', r));
        }

        centralDir.push({ name: nameBuf, crc: crc, size: size, offset: offset, needZip64File: needZip64File });
        offset += localHeader.length + nameBuf.length + localExtraLen + size;
        done++;
        packProgress[jobId].done = done;

        if (done % 10 === 0 || done === total) {
          log('打包进度: ' + done + '/' + total + ' — ' + relName);
        }

        fileData.fill(0);
      }

      const needCdZip64 = offset > ZIP64_LIMIT || total > 0xFFFF;
      let cdSize = 0;

      for (const entry of centralDir) {
        const entryNeedZip64 = entry.needZip64File || entry.offset > ZIP64_LIMIT;
        let cdExtraLen = 0;
        let cdExtra = null;
        if (entryNeedZip64) {
          const extraVals = [];
          if (entry.size > ZIP64_LIMIT) extraVals.push(BigInt(entry.size), BigInt(entry.size));
          if (entry.offset > ZIP64_LIMIT) extraVals.push(BigInt(entry.offset));
          const extraDataSize = extraVals.length * 8;
          cdExtra = Buffer.alloc(4 + extraDataSize);
          cdExtra.writeUInt16LE(0x0001, 0);
          cdExtra.writeUInt16LE(extraDataSize, 2);
          let pos = 4;
          for (const v of extraVals) { cdExtra.writeBigUInt64LE(v, pos); pos += 8; }
          cdExtraLen = 4 + extraDataSize;
        }

        const cdHeader = Buffer.alloc(46);
        cdHeader.writeUInt32LE(0x02014b50, 0);
        cdHeader.writeUInt16LE(45, 4);
        cdHeader.writeUInt16LE(entryNeedZip64 ? 45 : 20, 6);
        cdHeader.writeUInt16LE(0x0800, 8);
        cdHeader.writeUInt16LE(0, 10);
        cdHeader.writeUInt16LE(0, 12);
        cdHeader.writeUInt16LE(0, 14);
        cdHeader.writeUInt32LE(entry.crc, 16);
        cdHeader.writeUInt32LE(entry.size > ZIP64_LIMIT ? ZIP64_LIMIT : entry.size, 20);
        cdHeader.writeUInt32LE(entry.size > ZIP64_LIMIT ? ZIP64_LIMIT : entry.size, 24);
        cdHeader.writeUInt16LE(entry.name.length, 28);
        cdHeader.writeUInt16LE(cdExtraLen, 30);
        cdHeader.writeUInt16LE(0, 32);
        cdHeader.writeUInt16LE(0, 34);
        cdHeader.writeUInt16LE(0, 36);
        cdHeader.writeUInt32LE(0, 38);
        cdHeader.writeUInt32LE(entry.offset > ZIP64_LIMIT ? ZIP64_LIMIT : entry.offset, 42);

        outStream.write(cdHeader);
        outStream.write(entry.name);
        if (cdExtra) outStream.write(cdExtra);
        cdSize += cdHeader.length + entry.name.length + cdExtraLen;
      }

      const cdStartOffset = offset;

      if (needCdZip64) {
        const z64eocd = Buffer.alloc(56);
        z64eocd.writeUInt32LE(0x06064b50, 0);
        z64eocd.writeBigUInt64LE(BigInt(44), 4);
        z64eocd.writeUInt16LE(45, 12);
        z64eocd.writeUInt16LE(45, 14);
        z64eocd.writeUInt32LE(0, 16);
        z64eocd.writeUInt32LE(0, 20);
        z64eocd.writeBigUInt64LE(BigInt(total), 24);
        z64eocd.writeBigUInt64LE(BigInt(total), 32);
        z64eocd.writeBigUInt64LE(BigInt(cdSize), 40);
        z64eocd.writeBigUInt64LE(BigInt(cdStartOffset), 48);
        outStream.write(z64eocd);

        const z64loc = Buffer.alloc(20);
        z64loc.writeUInt32LE(0x07064b50, 0);
        z64loc.writeUInt32LE(0, 4);
        z64loc.writeBigUInt64LE(BigInt(cdStartOffset + cdSize), 8);
        z64loc.writeUInt32LE(1, 16);
        outStream.write(z64loc);
      }

      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(0, 4);
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(total > 0xFFFF ? 0xFFFF : total, 8);
      eocd.writeUInt16LE(total > 0xFFFF ? 0xFFFF : total, 10);
      eocd.writeUInt32LE(cdSize > ZIP64_LIMIT ? ZIP64_LIMIT : cdSize, 12);
      eocd.writeUInt32LE(cdStartOffset > ZIP64_LIMIT ? ZIP64_LIMIT : cdStartOffset, 16);
      eocd.writeUInt16LE(0, 20);
      outStream.write(eocd);

      outStream.end();

      await new Promise(function(resolve) {
        outStream.on('finish', resolve);
        outStream.on('error', resolve);
      });

      if (streamError) throw streamError;

      const stat = fs.statSync(zipPath);
      packProgress[jobId] = { total, done: total, status: 'done' };
      log('打包完成: job=' + jobId + ' 大小=' + (stat.size/1024/1024).toFixed(1) + ' MB');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, jobId, total, size: stat.size }));
    } catch (e) {
      packProgress[jobId] = { total: 0, done: 0, status: 'error' };
      log('打包错误: ' + e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  /* GET /packstatus/:jobId?clientId=xxx —— 查询打包进度 */
  if (req.method === 'GET' && url.pathname.startsWith('/packstatus/')) {
    const jobId = url.pathname.split('/')[2];
    const p = packProgress[jobId] || { total: 0, done: 0, status: 'unknown' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, total: p.total, done: p.done, status: p.status }));
    return;
  }

  /* GET /download/:jobId?clientId=xxx —— 直接下载已打包的 ZIP */
  if (req.method === 'GET' && url.pathname.startsWith('/download/')) {
    const jobId = url.pathname.split('/')[2];
    const clientId = url.searchParams.get('clientId') || 'default';
    const zipPath = path.join(DOWNLOAD_DIR, clientId, jobId + '.zip');

    if (!fs.existsSync(zipPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '打包文件不存在，请先打包' }));
      return;
    }

    try {
      const stat = fs.statSync(zipPath);
      log('下载: client=' + clientId + ' job=' + jobId + ' 大小=' + (stat.size/1024/1024).toFixed(1) + ' MB');
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="music-key-server.zip"`,
        'Accept-Ranges': 'none',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(zipPath).pipe(res);
    } catch (e) {
      log('下载错误: ' + e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  /* 健康检查 */
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  /* 获取配置 */
  if (url.pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ chunkSize: (config.chunkSizeMB || 10) * 1024 * 1024 }));
    return;
  }


  res.writeHead(404);
  res.end('Not found');
});

/* ---------- 端口选择：优先 fixedPort，否则扫描 ---------- */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.close(() => resolve(true));
      })
      .listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(start, maxScan) {
  /* 优先 fixedPort */
  if (config.fixedPort && config.fixedPort > 0) {
    if (await isPortAvailable(config.fixedPort)) {
      return config.fixedPort;
    }
    log('fixedPort ' + config.fixedPort + ' 被占用，从 startPort 扫描');
  }
  for (let i = 0; i < maxScan; i++) {
    const port = start + i;
    if (await isPortAvailable(port)) return port;
  }
  throw new Error('未找到空闲端口（' + start + ' ~ ' + (start + maxScan - 1) + '）');
}

findAvailablePort(config.startPort, config.maxScan).then(PORT => {
  server.listen(PORT, () => {
    log('MusicKey server running at http://localhost:' + PORT);
    log('UPDATE dir: ' + UPDATE_DIR);
    log('DOWNLOAD dir: ' + DOWNLOAD_DIR);
    const portFile = path.join(externalDir, 'port.json');
    fs.writeFileSync(portFile, JSON.stringify({ port: PORT }));
  });
}).catch(err => {
  log('启动失败: ' + err.message);
  console.error(err.message);
  process.exit(1);
});
