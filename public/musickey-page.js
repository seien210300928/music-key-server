/* ============================================================
 * MusicKey 音乐解锁 —— 页面逻辑（纯前端，无服务端）
 * 位置：js/tools/musickey-page.js（仅 source/tools/MusicKey.html 使用）
 * 依赖（加载顺序见 MusicKey.html 底部）：
 *   js/tools/musickey-key.js —— 酷狗公钥表（LZMA1 base64 内嵌）
 *   js/tools/musickey-core.js —— 提供全局 MusicKeyCore（解密/标签/ZIP）
 * ============================================================ */
(function () {
  'use strict';

  var core = (typeof MusicKeyCore !== 'undefined') ? MusicKeyCore : null;
  if (!core) {
    document.addEventListener('DOMContentLoaded', function () {
      var e = document.getElementById('empty');
      if (e) e.textContent = '核心引擎加载失败，请刷新重试。';
    });
    return;
  }

  /* ===================== 基础 ===================== */
  var $ = function (id) { return document.getElementById(id); };
  var listEl = $('list');
  var emptyEl = $('empty');
  var dropzone = $('dropzone');
  var fileInput = $('fileInput');
  var dirInput = $('dirInput');
  var ekeyInput = $('ekey');
  var zipBtn = $('zipAll');
  var clearDoneBtn = $('clearDone');
  var clearAllBtn = $('clearAll');

  var items = new Map();   /* id → item */
  var seq = 0;
  var processing = false;

  /* ===================== 模式切换 ===================== */
  var mode = 'local'; /* 'local' | 'server' */
  var modeBtns = document.querySelectorAll('.mk-mode');
  var dzHint = $('dzHint');
  var toolbarLocal = $('toolbarLocal');
  var toolbarServer = $('toolbarServer');

  /* 服务器模式状态 */
  var srvJobId = null;
  var srvUploadDone = false;
  var srvDecryptDone = false;
  var srvPackDone = false;
  var srvUploadBtn = $('srvUpload');
  var srvDecryptBtn = $('srvDecrypt');
  var srvPackBtn = $('srvPack');
  var srvDownloadBtn = $('srvDownload');
  var clearAllSrvBtn = $('clearAllSrv');
  var autoDecryptChk = $('autoDecrypt');
  var autoPackChk = $('autoPack');
  var autoDownloadChk = $('autoDownload');
  var localAutoDownloadChk = $('localAutoDownload');

  function getBrowserMemLimit() {
    if (performance.memory && performance.memory.jsHeapSizeLimit) {
      var total = performance.memory.jsHeapSizeLimit;
      var used = performance.memory.usedJSHeapSize || 0;
      var limit = total - used - 512 * 1024 * 1024; /* 扣已用 + 预留 512MB 处理开销 */
      return Math.max(64, Math.floor(limit / (1024 * 1024)));
    }
    if (navigator.deviceMemory) {
      return Math.floor(navigator.deviceMemory * 1024 * 0.4);
    }
    return 512;
  }

  function updateSrvButtons() {
    var hasFiles = items.size > 0;
    srvUploadBtn.disabled = !hasFiles || srvUploadDone;
    srvDecryptBtn.disabled = !srvUploadDone || srvDecryptDone;
    srvPackBtn.disabled = !srvDecryptDone || srvPackDone;
    srvDownloadBtn.disabled = !srvPackDone;
    srvUploadBtn.textContent = srvUploadDone ? '1. 已上传' : '1. 上传文件';
    srvDecryptBtn.textContent = srvDecryptDone ? '2. 已解密' : '2. 开始解密';
    srvPackBtn.textContent = srvPackDone ? '3. 已打包' : '3. 打包 ZIP';
  }

  function updateModeUI() {
    modeBtns.forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    toolbarLocal.style.display = (mode === 'local') ? '' : 'none';
    toolbarServer.style.display = (mode === 'server') ? '' : 'none';
    if (mode === 'local') {
      var memMB = getBrowserMemLimit();
      dzHint.textContent = '本地模式 · 浏览器可用内存约 ' + memMB + ' MB，文件总大小建议不超过此限制；解密逐文件处理，打包时需一次性占用全部文件内存；支持 .ncm .mflac .mgg .qmc0-3 .kgm .kwm 等，一次只能上传一个文件夹';
    } else {
      dzHint.textContent = '服务器模式 · 上传后自动解密→打包→下载；注意：经 Cloudflare 橙色云代理时上传有大小限制（约 99MB）';
      updateSrvButtons();
    }
  }

  modeBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var newMode = btn.dataset.mode;
      if (newMode === mode) return;
      mode = newMode;
      srvJobId = null;
      srvUploadDone = false;
      srvDecryptDone = false;
      srvPackDone = false;
      updateModeUI();
      clearAll();
      toast(mode === 'local' ? '已切换到本地浏览器模式' : '已切换到服务器模式');
    });
  });

  /* 客户端 ID（存 localStorage，服务端按此分类存储） */
  var CLIENT_ID_KEY = 'musickey_client_id';
  function getClientId() {
    var id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var PLATFORMS = {
    ncm: { name: '网易云', color: '#ff6b6b' },
    mflac: { name: 'QQ音乐', color: '#31c27c' },
    mgg: { name: 'QQ音乐', color: '#31c27c' },
    qmc: { name: 'QQ音乐', color: '#31c27c' },
    tkm: { name: 'QQ音乐', color: '#31c27c' },
    bkc: { name: 'QQ音乐', color: '#31c27c' },
    kgm: { name: '酷狗', color: '#4d9fff' },
    kgma: { name: '酷狗', color: '#4d9fff' },
    vpr: { name: '酷狗', color: '#4d9fff' },
    kwm: { name: '酷我', color: '#ffb020' }
  };
  function platformOf(name) {
    var lower = name.toLowerCase();
    var keys = Object.keys(PLATFORMS).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      if (lower.indexOf(keys[i]) >= 0) return PLATFORMS[keys[i]];
    }
    return { name: '未知', color: '#7c5cff' };
  }

  function fmtSize(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }

  var ICONS = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 5-5m-5 5-5-5"/><path d="M4 20h16"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg>',
    retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>'
  };

  function toast(text) {
    var el = $('toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  /* ===================== 文件读取 ===================== */
  function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('读取文件失败')); };
      fr.readAsArrayBuffer(file);
    });
  }

  /* ===================== 目录遍历（拖入文件夹） =====================
   * 递归读取 FileSystemDirectoryEntry，输出文件的 relPath 形如 "专辑/子目录/歌.ncm"
   */
  function walkEntry(entry, pathPrefix, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(function (file) {
          file.relPath = pathPrefix ? pathPrefix + '/' + entry.name : entry.name;
          out.push(file);
          resolve();
        }, resolve);
      } else if (entry.isDirectory) {
        var dirName = pathPrefix ? pathPrefix + '/' + entry.name : entry.name;
        var reader = entry.createReader();
        var children = [];
        var readBatch = function () {
          reader.readEntries(function (entries) {
            if (!entries.length) {
              Promise.all(children.map(function (e) {
                return walkEntry(e, dirName, out);
              })).then(resolve);
              return;
            }
            children = children.concat(Array.prototype.slice.call(entries));
            readBatch();
          }, resolve);
        };
        readBatch();
      } else {
        resolve();
      }
    });
  }

  /* 从 drop 事件中收集文件（含嵌套文件夹），返回 Promise<File[]> */
  function filesFromDrop(dt) {
    return new Promise(function (resolve) {
      if (dt && dt.items && dt.items.length &&
          typeof dt.items[0].webkitGetAsEntry === 'function') {
        var entries = [];
        for (var i = 0; i < dt.items.length; i++) {
          var ent = dt.items[i].webkitGetAsEntry();
          if (ent) entries.push(ent);
        }
        if (entries.length) {
          var out = [];
          Promise.all(entries.map(function (en) {
            return walkEntry(en, '', out);
          })).then(function () { resolve(out); });
          return;
        }
      }
      resolve(dt && dt.files ? Array.prototype.slice.call(dt.files) : []);
    });
  }

  /* ===================== 状态机 ===================== */
  /* 这些扩展名不参与解密，原样透传进 ZIP */
  var PASSTHROUGH_EXT = ['.lrc', '.mp3', '.flac', '.wav', '.ogg', '.m4a', '.txt', '.jpg', '.jpeg', '.png', '.gif'];

  function isPassthrough(name) {
    var lower = name.toLowerCase();
    for (var i = 0; i < PASSTHROUGH_EXT.length; i++) {
      if (lower.endsWith(PASSTHROUGH_EXT[i])) return true;
    }
    return false;
  }

  function passthroughLabel(name) {
    var lower = name.toLowerCase();
    if (lower.endsWith('.lrc')) return '歌词';
    if (lower.endsWith('.mp3') || lower.endsWith('.flac') || lower.endsWith('.wav') ||
        lower.endsWith('.ogg') || lower.endsWith('.m4a')) return '音频';
    if (lower.endsWith('.txt')) return '文本';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') ||
        lower.endsWith('.gif')) return '图片';
    return '文件';
  }

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var rel = f.relPath || f.webkitRelativePath || f.name;
      var id = 'mk-' + (++seq);
      var passthrough = isPassthrough(f.name);
      var item = {
        id: id,
        file: f,
        relPath: rel,
        passthrough: passthrough,
        status: 'queued',
        phase: 'wait',
        progress: 4,
        platform: passthrough ? { name: passthroughLabel(f.name), color: '#9aa5b8' } : platformOf(f.name),
        sourceExt: extOf(f.name),
        coverUrl: null,
        audioUrl: null,
        outputName: '',
        outSize: 0,
        container: '',
        error: ''
      };
      /* 服务器模式：跳过本地解密，直接标记为就绪待上传 */
      if (mode === 'server') {
        item.status = 'done';
        item.phase = 'ready';
        item.outputName = rel;
        item.outSize = f.size;
      }
      items.set(id, item);
    }
    render();
    if (mode === 'server') {
      updateSrvButtons();
      /* 自动触发上传 */
      if (!srvUploadDone && items.size > 0) {
        setTimeout(function () { srvUpload(true); }, 300);
      }
    }
    pump();
  }

  function extOf(name) {
    var i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i).toLowerCase() : '';
  }
  function baseOf(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }
  /* 保留目录结构的输出文件名：dir/sub/song.ncm + mp3 → dir/sub/song.mp3 */
  function outputPathOf(relPath, outExt) {
    var slash = relPath.lastIndexOf('/');
    var dir = slash >= 0 ? relPath.slice(0, slash + 1) : '';
    var fname = slash >= 0 ? relPath.slice(slash + 1) : relPath;
    return dir + baseOf(fname) + '.' + outExt;
  }

  /* 顺序解码队列，避免大文件同时解码的内存峰值 */
  function pump() {
    if (processing) return;
    var next = null;
    items.forEach(function (it) { if (!next && it.status === 'queued') next = it; });
    if (!next) {
      /* 本地模式：全部完成且勾选自动下载 → 自动打包下载 */
      if (mode === 'local' && localAutoDownloadChk && localAutoDownloadChk.checked) {
        var allDone = true;
        items.forEach(function (it) { if (it.status !== 'done' && it.status !== 'failed') allDone = false; });
        if (allDone && items.size > 0) {
          setTimeout(function () { zipAll(); }, 300);
        }
      }
      return;
    }
    processing = true;
    process(next).then(function () {
      processing = false;
      pump();
    });
  }

  function process(it) {
    it.status = 'running';
    it.phase = it.passthrough ? 'read' : 'read';
    it.error = '';
    render();
    return readAsArrayBuffer(it.file).then(function (buf) {
      it.buf = new Uint8Array(buf);

      /* .lrc 等非音频文件：不解密，原样透传 */
      if (it.passthrough) {
        it.outputName = it.relPath;
        it.outSize = it.buf.length;
        it.audioUrl = URL.createObjectURL(new Blob([it.buf], { type: 'text/plain' }));
        it.status = 'done';
        render();
        return;
      }

      it.phase = 'decrypt';
      render();
      return core.decodeFile(it.buf, it.file.name, { ekey: (ekeyInput.value || '').trim() || null });
    }).then(function (res) {
      /* 透传文件已在上面完成 */
      if (it.passthrough || !items.has(it.id)) return;
      var payload = res.payload;
      var container = res.container;
      it.container = container || 'bin';
      /* MP3/FLAC 写入标签与封面（其余容器保持原样） */
      var hasTags = !!(res.tags && (res.tags.title || res.tags.artist || res.tags.album));
      var hasCover = !!(res.cover && res.cover.length);
      if (container === 'mp3' && (hasTags || hasCover)) {
        payload = core.embedMp3Tags(payload, res.tags || {}, res.cover || null);
      } else if (container === 'flac' && (hasTags || hasCover)) {
        payload = core.embedFlacTags(payload, res.tags || {}, res.cover || null);
      }
      var outExt = (container === 'bin') ? (it.sourceExt || 'bin') : container;
      it.outputName = outputPathOf(it.relPath, outExt);
      it.outSize = payload.length;
      if (hasCover) {
        it.coverUrl = URL.createObjectURL(new Blob([res.cover], { type: imageMimeOf(res.cover) }));
      }
      it.audioUrl = URL.createObjectURL(new Blob([payload], { type: mimeOf(it.container) }));
      it.buf = null; /* 释放内存，打包时从 blob 读 */
      it.status = 'done';
      render();
    }).catch(function (err) {
      if (!items.has(it.id)) return;
      it.status = 'failed';
      it.error = (err && err.message) ? err.message : String(err);
      it.buf = null;
      render();
    });
  }

  function imageMimeOf(cover) {
    return (cover.length >= 4 && cover[0] === 0x89 && cover[1] === 0x50 && cover[2] === 0x4E && cover[3] === 0x47)
      ? 'image/png' : 'image/jpeg';
  }

  function mimeOf(container) {
    return {
      mp3: 'audio/mpeg',
      flac: 'audio/flac',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4',
      wav: 'audio/wav'
    }[container] || 'application/octet-stream';
  }

  /* ===================== 渲染 ===================== */
  function stateText(it) {
    if (it.status === 'running') return it.phase === 'read' ? '读取中' : '解密中';
    if (it.status === 'done') return '完成';
    if (it.status === 'failed') return '失败';
    return '排队中';
  }

  function render() {
    var done = 0;
    items.forEach(function (it) { if (it.status === 'done') done++; });
    emptyEl.hidden = items.size > 0;
    zipBtn.disabled = done === 0;
    listEl.innerHTML = '';
    items.forEach(function (it) {
      listEl.appendChild(card(it));
    });
  }

  function card(it) {
    var el = document.createElement('article');
    el.className = 'card';
    el.style.setProperty('--pc', it.platform.color);
    el.dataset.id = it.id;

    /* 封面 */
    var cover = document.createElement('div');
    cover.className = 'cover';
    if (it.coverUrl) {
      var img = document.createElement('img');
      img.src = it.coverUrl;
      img.alt = '';
      cover.appendChild(img);
    } else if (it.passthrough) {
      cover.textContent = '¶';
    } else {
      cover.textContent = '♫';
    }

    /* 信息 */
    var info = document.createElement('div');
    info.className = 'info';
    var name = document.createElement('div');
    name.className = 'name';
    if (it.relPath && it.relPath.indexOf('/') >= 0) {
      var dirp = document.createElement('span');
      dirp.className = 'relpath';
      dirp.textContent = it.relPath.slice(0, it.relPath.lastIndexOf('/') + 1);
      name.appendChild(dirp);
    }
    var strong = document.createElement('strong');
    strong.textContent = it.file.name;
    strong.title = it.relPath || it.file.name;
    name.appendChild(strong);
    var plat = document.createElement('span');
    plat.className = 'platform';
    plat.textContent = it.platform.name;
    name.appendChild(plat);

    var meta = document.createElement('div');
    meta.className = 'meta';
    var srcMeta = fmtSize(it.file.size) + ' · ' + (it.sourceExt || '?').replace('.', '').toUpperCase();
    var m1 = document.createElement('span');
    m1.textContent = srcMeta;
    meta.appendChild(m1);
    if (it.status === 'done' && it.outputName) {
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '·';
      var m2 = document.createElement('span');
      m2.className = 'tagline';
      if (it.passthrough) {
        m2.textContent = '已保留 · ' + fmtSize(it.outSize);
      } else {
        m2.textContent = '输出 ' + it.container.toUpperCase() + ' · ' + fmtSize(it.outSize);
      }
      meta.appendChild(dot);
      meta.appendChild(m2);
    }
    info.appendChild(name);
    info.appendChild(meta);

    /* 进度条（运行中） */
    if (it.status === 'running') {
      var prog = document.createElement('div');
      prog.className = 'progress';
      var fill = document.createElement('i');
      fill.className = 'running';
      prog.appendChild(fill);
      info.appendChild(prog);
    }
    /* 失败详情 */
    if (it.status === 'failed' && it.error) {
      var err = document.createElement('div');
      err.className = 'error';
      err.textContent = it.error;
      info.appendChild(err);
    }

    /* 右侧状态与操作 */
    var end = document.createElement('div');
    end.className = 'end';
    var state = document.createElement('span');
    state.className = 'state ' + it.status;
    var sd = document.createElement('span');
    sd.className = 'sd';
    var st = document.createElement('span');
    st.textContent = stateText(it);
    state.appendChild(sd);
    state.appendChild(st);

    var actions = document.createElement('div');
    actions.className = 'actions';
    if (it.status === 'done' && it.audioUrl) {
      if (!it.passthrough) {
        actions.appendChild(iconBtn('play', '播放', playItem, it.id));
      }
      actions.appendChild(iconBtn('download primary', '下载', downloadItem, it.id));
    }
    if (it.status === 'failed') {
      actions.appendChild(iconBtn('retry', '重试', retryItem, it.id));
    }
    actions.appendChild(iconBtn('trash', '移除', removeItem, it.id));
    end.appendChild(state);
    end.appendChild(actions);

    el.appendChild(cover);
    el.appendChild(info);
    el.appendChild(end);
    return el;
  }

  function iconBtn(kind, title, handler, id) {
    var b = document.createElement('button');
    b.className = 'icon-btn ' + kind;
    b.type = 'button';
    b.title = title;
    b.innerHTML = ICONS[kind.split(' ')[0]] || '';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      handler(id);
    });
    return b;
  }

  /* ===================== 操作 ===================== */
  function playItem(id) {
    var it = items.get(id);
    if (!it || !it.audioUrl) return;
    window.open(it.audioUrl, '_blank', 'noopener');
  }

  function downloadItem(id) {
    var it = items.get(id);
    if (!it || !it.audioUrl || !it.outputName) return;
    /* download 属性不支持子目录路径，单文件下载只取文件名 */
    var name = it.outputName;
    var slash = name.lastIndexOf('/');
    if (slash >= 0) name = name.slice(slash + 1);
    var a = document.createElement('a');
    a.href = it.audioUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function retryItem(id) {
    var it = items.get(id);
    if (!it || it.status !== 'failed') return;
    it.status = 'queued';
    it.phase = 'wait';
    it.error = '';
    it.progress = 4;
    render();
    pump();
  }

  function removeItem(id) {
    var it = items.get(id);
    if (!it) return;
    if (it.coverUrl) URL.revokeObjectURL(it.coverUrl);
    if (it.audioUrl) URL.revokeObjectURL(it.audioUrl);
    it.buf = null;
    items.delete(id);
    render();
  }

  function clearDone() {
    items.forEach(function (it) {
      if (it.status === 'done' || it.status === 'failed') removeItem(it.id);
    });
  }

  function clearAll() {
    items.forEach(function (it) {
      if (it.coverUrl) URL.revokeObjectURL(it.coverUrl);
      if (it.audioUrl) URL.revokeObjectURL(it.audioUrl);
      it.buf = null;
    });
    items.clear();
    render();
  }

  /* ===================== 服务端降级 ===================== */
  var SERVER_START_PORT = 3000;
  var SERVER_MAX_SCAN = 100;

  function getServerBase() {
    /* file:// 打开：用 localhost，需扫描端口
       http(s) 打开：用同源（反代统一转发），不指定端口
       如果页面在子路径下（如 /mk/），API 请求也走该子路径 */
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      var path = window.location.pathname;
      var dir = path.substring(0, path.lastIndexOf('/') + 1);
      if (dir === '/' || dir === '') return window.location.origin;
      return window.location.origin + dir;
    }
    return 'http://localhost';
  }
  var serverPort = null;

  function findServerPort() {
    if (serverPort !== null) return Promise.resolve(serverPort);
    var base = getServerBase();
    var isFile = (window.location.protocol === 'file:');

    /* http(s)：同源，直接用 /health，不扫描端口 */
    if (!isFile) {
      return new Promise(function (resolve, reject) {
        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 3000);
        fetch(base + '/health', { method: 'GET', signal: controller.signal })
          .then(function (r) { clearTimeout(timeout); if (r.ok) { serverPort = ''; resolve(''); } else { reject(new Error('服务端未启动')); } })
          .catch(function () { clearTimeout(timeout); reject(new Error('服务端未启动')); });
      });
    }

    /* 本机：扫描端口 */
    return new Promise(function (resolve, reject) {
      var tried = 0;
      function tryPort(port) {
        if (tried >= SERVER_MAX_SCAN) { reject(new Error('服务端未启动')); return; }
        tried++;
        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 500);
        fetch(base + ':' + port + '/health', { method: 'GET', signal: controller.signal })
          .then(function (r) { clearTimeout(timeout); if (r.ok) { serverPort = ':' + port; resolve(':' + port); } else { tryPort(port + 1); } })
          .catch(function () { clearTimeout(timeout); tryPort(port + 1); });
      }
      tryPort(SERVER_START_PORT);
    });
  }

  /* 第一步：逐个上传文件（每个文件上传完释放内存） */
  function srvUpload(auto) {
    var files = [];
    items.forEach(function (it) {
      if (it.file) files.push({ file: it.file, name: it.relPath });
    });
    if (!files.length) { toast('没有可上传的文件'); return; }

    srvUploadBtn.disabled = true;
    srvDecryptBtn.disabled = true;
    srvDownloadBtn.disabled = true;
    srvUploadBtn.textContent = '连接服务器…';

    var chunkSize = 10 * 1024 * 1024; /* 默认 10MB，从服务端配置读取 */
    findServerPort().then(function (port) {
      /* 读取服务端配置（分块大小） */
      return fetch(getServerBase() + port + '/config').then(function(r) { return r.json(); }).then(function(cfg) {
        if (cfg.chunkSize) chunkSize = cfg.chunkSize;
        return port;
      }).catch(function() { return port; });
    }).then(function (port) {
      /* 生成 jobId */
      var jobId = cryptoRandomHex(16);
      srvJobId = jobId;
      var clientId = getClientId();
      var uploaded = 0;
      var total = files.length;


      function uploadFileWithChunks(f, fileIndex, totalFiles) {
        return new Promise(function(resolve, reject) {
          var fileSize = f.file.size;
          var label = '第' + (fileIndex + 1) + '/' + totalFiles + '个文件';
          if (fileSize <= chunkSize) {
            uploadOneFile(f.file, f.name, label).then(resolve).catch(reject);
            return;
          }
          var totalChunks = Math.ceil(fileSize / chunkSize);
          var chunkIdx = 0;
          function uploadChunk() {
            var start = chunkIdx * chunkSize;
            var end = Math.min(start + chunkSize, fileSize);
            var blob = f.file.slice(start, end);
            var chunkName = f.name + '.part' + chunkIdx;
            var chunkLabel = label + ' (块' + (chunkIdx + 1) + '/' + totalChunks + ')';
            uploadOneFile(blob, chunkName, chunkLabel).then(function() {
              chunkIdx++;
              if (chunkIdx < totalChunks) {
                uploadChunk();
              } else {
                srvUploadBtn.textContent = '1. 合并 ' + label;
                var xhr = new XMLHttpRequest();
                xhr.open('POST', getServerBase() + port + '/merge/' + jobId + '?clientId=' + encodeURIComponent(clientId) + '&filename=' + encodeURIComponent(f.name));
                xhr.onload = function() {
                  try {
                    var data = JSON.parse(xhr.responseText);
                    if (!data.ok) throw new Error(data.error || '合并失败');
                    f.file = null;
                    resolve();
                  } catch(e) { reject(e); }
                };
                xhr.onerror = function() { reject(new Error('合并请求失败')); };
                xhr.send();
              }
            }).catch(reject);
          }
          uploadChunk();
        });
      }

      function uploadOneFile(blob, name, label) {
        return new Promise(function(resolve, reject) {
          var fd = new FormData();
          fd.append('files', blob, name);
          var xhr = new XMLHttpRequest();
          xhr.open('POST', getServerBase() + port + '/upload/' + jobId + '?clientId=' + encodeURIComponent(clientId));
          xhr.upload.onprogress = function(e) {
            if (e.lengthComputable) {
              var pct = Math.round(e.loaded / e.total * 100);
              srvUploadBtn.textContent = '1. 上传 ' + label + ' (' + pct + '%)';
            }
          };
          xhr.onload = function() {
            try {
              var data = JSON.parse(xhr.responseText);
              if (!data.ok) throw new Error(data.error || '上传失败');
              resolve();
            } catch(e) { reject(e); }
          };
          xhr.onerror = function() { reject(new Error('网络错误')); };
          xhr.send(fd);
        });
      }

      function uploadNext(index) {
        return new Promise(function(resolve, reject) {
          if (index >= total) { resolve(); return; }
          var f = files[index];
          uploadFileWithChunks(f, index, total).then(function() {
            f.file = null;
            uploadNext(index + 1).then(resolve).catch(reject);
          }).catch(reject);
        });
      }

      uploadNext(0).then(function() {
        srvUploadDone = true;
        srvDecryptDone = false;
        srvPackDone = false;
        toast('上传完成，共 ' + total + ' 个文件');
        updateSrvButtons();
        /* 自动解密 */
        if (autoDecryptChk && autoDecryptChk.checked) {
          setTimeout(function () { srvDecrypt(); }, 200);
        }
      }).catch(function() {
        srvUploadBtn.disabled = false;
        srvUploadBtn.textContent = '1. 上传文件';
        toast('服务器暂时停止了该服务');
      });
    }).catch(function () {
      srvUploadBtn.disabled = false;
      srvUploadBtn.textContent = '1. 上传文件';
      toast('服务器暂时停止了该服务');
    });
  }

  function cryptoRandomHex(len) {
    var arr = new Uint8Array(len);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(arr);
    } else {
      for (var i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  /* 第二步：开始解密（带进度轮询） */
  function srvDecrypt() {
    if (!srvJobId) { toast('请先上传文件'); return; }
    srvDecryptBtn.disabled = true;
    srvDownloadBtn.disabled = true;
    srvDecryptBtn.textContent = '2. 解密中 0/0';
    toast('正在逐个解密…');

    /* 先获取总数 */
    fetch(getServerBase() + serverPort + '/status/' + srvJobId + '?clientId=' + encodeURIComponent(getClientId()))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var total = data.total || 0;
        /* 开始解密 */
        return fetch(getServerBase() + serverPort + '/decrypt/' + srvJobId + '?clientId=' + encodeURIComponent(getClientId()), {
          method: 'POST'
        }).then(function (r) { return r.json(); })
          .then(function (decryptData) {
            if (!decryptData.ok) throw new Error(decryptData.error || '解密失败');
            srvDecryptDone = true;
            toast('解密完成：成功 ' + decryptData.done + ' 个，失败 ' + decryptData.failed + ' 个');
            updateSrvButtons();
            /* 自动打包 */
            if (autoPackChk && autoPackChk.checked) {
              setTimeout(function () { srvPack(); }, 200);
            }
          });
      })
      .catch(function (err) {
        srvDecryptBtn.disabled = false;
        srvDecryptBtn.textContent = '2. 开始解密';
        toast('解密失败：' + (err.message || '未知错误'));
      });

    /* 轮询进度 */
    var pollTimer = setInterval(function () {
      fetch(getServerBase() + serverPort + '/status/' + srvJobId + '?clientId=' + encodeURIComponent(getClientId()))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (srvDecryptBtn.disabled) {
            srvDecryptBtn.textContent = '2. 解密中 ' + data.done + '/' + data.total;
          }
          if (srvDecryptDone) {
            clearInterval(pollTimer);
          }
        })
        .catch(function () {});
    }, 500);
  }

  /* 第三步：打包 ZIP（带进度轮询） */
  function srvPack() {
    if (!srvJobId) { toast('请先完成解密'); return; }
    srvPackBtn.disabled = true;
    srvPackBtn.textContent = '3. 打包中 0/0';
    toast('正在打包 ZIP…');

    /* 轮询打包进度 */
    var packTimer = setInterval(function () {
      fetch(getServerBase() + serverPort + '/packstatus/' + srvJobId + '?clientId=' + encodeURIComponent(getClientId()))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.status === 'packing') {
            srvPackBtn.textContent = '3. 打包中 ' + data.done + '/' + data.total;
          }
        })
        .catch(function () {});
    }, 500);

    fetch(getServerBase() + serverPort + '/pack/' + srvJobId + '?clientId=' + encodeURIComponent(getClientId()), {
      method: 'POST'
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        clearInterval(packTimer);
        if (!data.ok) throw new Error(data.error || '打包失败');
        srvPackDone = true;
        toast('打包完成：' + data.total + ' 个文件，' + (data.size / 1024 / 1024).toFixed(1) + ' MB');
        updateSrvButtons();
        /* 自动下载 */
        if (autoDownloadChk && autoDownloadChk.checked) {
          setTimeout(function () { srvDownload(); }, 200);
        }
      })
      .catch(function (err) {
        clearInterval(packTimer);
        srvPackBtn.disabled = false;
        srvPackBtn.textContent = '3. 打包 ZIP';
        toast('打包失败：' + (err.message || '未知错误'));
      });
  }

  /* 第四步：下载 ZIP */
  function srvDownload() {
    if (!srvJobId) { toast('请先完成打包'); return; }
    toast('正在下载…');
    var url = getServerBase() + serverPort + '/download/' + srvJobId + '?clientId=' + encodeURIComponent(getClientId());
    window.open(url, '_blank');
  }

  function zipAll() {
    var pending = 0, failed = 0;
    items.forEach(function (it) {
      if (it.status === 'queued' || it.status === 'running') pending++;
      else if (it.status === 'failed') failed++;
    });
    if (pending > 0) { toast('还有 ' + pending + ' 个文件在处理中，请稍候'); return; }

    var doneCount = 0;
    items.forEach(function (it) { if (it.status === 'done') doneCount++; });
    if (doneCount === 0) {
      toast(failed > 0 ? '没有已完成的文件可打包' : '没有文件可打包');
      return;
    }

    toast('正在读取 ' + doneCount + ' 个文件打包…');

    var files = [];
    var seen = {};
    function uniqName(name) {
      if (!seen[name]) { seen[name] = 1; return name; }
      var i = name.lastIndexOf('.');
      var base = i > 0 ? name.slice(0, i) : name;
      var ext = i > 0 ? name.slice(i) : '';
      var n = 2;
      while (seen[base + '(' + n + ')' + ext]) n++;
      var nn = base + '(' + n + ')' + ext;
      seen[nn] = 1;
      return nn;
    }

    var doneItems = [];
    items.forEach(function (it) {
      if (it.status === 'done' && it.audioUrl && it.outputName) {
        doneItems.push(it);
      }
    });

    Promise.all(doneItems.map(function (it) {
      return fetch(it.audioUrl).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
        return { name: uniqName(it.outputName), data: new Uint8Array(buf) };
      });
    })).then(function (fileList) {
      files = fileList;
      toast('正在打包 ' + files.length + ' 个文件…');
      setTimeout(function () {
        try {
          var zip = core.makeZip(files);
          var blob = new Blob([zip], { type: 'application/zip' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'music-key-解锁结果.zip';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          toast('打包完成');
        } catch (err) {
          var msg = (err && err.message) ? err.message : String(err);
          if (msg.indexOf('Array buffer allocation') >= 0 || msg.indexOf('allocation') >= 0) {
            toast('本地模式内存不足以满足需求，请尝试增加浏览器分配内存或使用服务器模式再或者分次解密');
          } else {
            toast('打包失败：' + msg);
          }
        }
      }, 30);
    }).catch(function (err) {
      toast('读取文件失败：' + (err && err.message ? err.message : String(err)));
    });
  }

  /* ===================== 事件绑定 ===================== */
  var pickFileBtn = $('pickFile');
  var pickDirBtn = $('pickDir');
  pickFileBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    fileInput.click();
  });
  pickDirBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    dirInput.click();
  });
  fileInput.addEventListener('change', function () {
    addFiles(fileInput.files);
    fileInput.value = '';
  });
  dirInput.addEventListener('change', function () {
    var newFiles = Array.prototype.slice.call(dirInput.files);
    if (!newFiles.length) return;
    /* 单文件夹模式：已有文件时提示是否覆盖 */
    if (items.size > 0) {
      var ok = confirm('上传新文件夹将清空当前 ' + items.size + ' 个文件，是否继续？');
      if (!ok) {
        dirInput.value = '';
        return;
      }
      clearAll();
    }
    addFiles(newFiles);
    dirInput.value = '';
  });
  ['dragover', 'dragenter'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.add('drag');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.remove('drag');
    });
  });
  dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer) {
      filesFromDrop(e.dataTransfer).then(function (files) {
        if (!files.length) return;
        /* 判断是否包含文件夹（有 relPath 含 / 的就是文件夹拖入） */
        var hasFolder = files.some(function (f) {
          var rel = f.relPath || f.webkitRelativePath || f.name;
          return rel.indexOf('/') >= 0;
        });
        if (hasFolder && items.size > 0) {
          var ok = confirm('拖入新文件夹将清空当前 ' + items.size + ' 个文件，是否继续？');
          if (!ok) return;
          clearAll();
        }
        addFiles(files);
      });
    }
  });

  zipBtn.addEventListener('click', zipAll);
  clearDoneBtn.addEventListener('click', clearDone);
  clearAllBtn.addEventListener('click', clearAll);

  /* 服务器模式按钮 */
  srvUploadBtn.addEventListener('click', srvUpload);
  srvDecryptBtn.addEventListener('click', srvDecrypt);
  srvPackBtn.addEventListener('click', srvPack);
  srvDownloadBtn.addEventListener('click', srvDownload);
  clearAllSrvBtn.addEventListener('click', function () {
    srvJobId = null;
    srvUploadDone = false;
    srvDecryptDone = false;
    srvPackDone = false;
    updateSrvButtons();
    clearAll();
  });

  updateModeUI();
  render();
})();
