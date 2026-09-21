# MusicKey Server

音乐解锁服务端 —— 支持 NCM / QMC / KGM / KWM 等加密音乐格式的在线解密，浏览器本地或服务端均可使用。

基于 [music-key](https://github.com/Xiaowu-0916/music-key)（MIT）的解密算法，封装为 Node.js 独立服务端。

## 功能

- **本地浏览器模式**：纯前端解密，无需上传文件，受浏览器内存限制
- **服务端模式**：上传到服务器解密，支持大文件、分块上传，最终打包 ZIP 下载
- **支持格式**：`.ncm`（网易云）、`.mflac` / `.mgg` / `.qmc0-3` / `.tkm` / `.bkc`（QQ音乐）、`.kgm` / `.kgma` / `.vpr`（酷狗）、`.kwm`（酷我）
- **标签保留**：自动写入 MP3/FLAC 元数据和封面
- **分块上传**：大文件自动切块上传，绕过 Cloudflare 等 CDN 的请求体大小限制
- **自动清理**：内置清理脚本，可配合计划任务定期删除临时文件

## 快速开始

### Windows

```bat
git clone https://github.com/seien210300928/music-key-server.git
cd music-key-server
start.bat
```

### Linux / macOS

```bash
git clone https://github.com/seien210300928/music-key-server.git
cd music-key-server
chmod +x start.sh build.sh clean.sh
./start.sh
```

首次启动会在同目录自动生成：
- `config.json` —— 配置文件
- `logs/` —— 运行日志
- `update/` —— 上传文件临时目录
- `download/` —— 解密输出目录
- `cleanup.bat` / `cleanup.sh` —— 手动清理临时文件脚本

访问 `http://localhost:3001` 即可使用。

> **注意**：如果想要移植到网站，由于浏览器 HTML 安全限制，网页无法自动启动本地服务，使用前必须先手动运行启动脚本。

## 配置文件

编辑 `config.json`：

```json
{
  "startPort": 3001,
  "maxScan": 1000,
  "fixedPort": 3001,
  "cpuThreads": 2,
  "maxMemory": 1024,
  "chunkSizeMB": 10
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `startPort` | 起始端口，扫描端口时从这里开始 | `3001` |
| `maxScan` | 最多扫描多少个端口 | `1000` |
| `fixedPort` | 固定端口，设为 `0` 则自动扫描空闲端口 | `3001` |
| `cpuThreads` | 预留（服务端并发数） | `2` |
| `maxMemory` | 预留（服务端内存限制，MB） | `1024` |
| `chunkSizeMB` | 分块上传大小，单位 MB | `10` |

> 修改配置后重启服务生效。

## 反向代理示例

### Caddy（局域网）

```caddy
http://192.168.1.69, http://seien-book {
    handle_path /mk/* {
        reverse_proxy localhost:3001
    }
}
```

访问 `http://192.168.1.69/mk/` 即可使用。

### Caddy（广域网 + Cloudflare）

```caddy
https://book.seien.dpdns.org {
    handle_path /mk/* {
        reverse_proxy localhost:3001
    }
}
```

访问 `https://book.seien.dpdns.org/mk/` 即可使用。

> **Cloudflare 注意事项**：
> - 橙色云代理有 ~100MB 请求体限制，大文件请使用分块上传（默认已启用）
> - 建议在 Cloudflare 中对 `/mk/` 路径关闭缓存和压缩

## 脚本说明

| 脚本 | 用途 |
|------|------|
| `start.bat` / `start.sh` | 启动服务（自动下载 Node.js） |
| `build.bat` / `build.sh` | 构建独立可执行文件到 `dist/`（自动下载 Node.js 和依赖） |
| `clean.bat` / `clean.sh` | 清理项目（删除 node、node_modules、dist、logs、update、download、config 等） |
| `cleanup.bat` / `cleanup.sh` | 启动时自动生成，清理运行临时文件（update、download、logs），可挂到计划任务 |

## 构建

从源码构建独立可执行文件：

```bash
# Windows
build.bat

# Linux / macOS
./build.sh
```

产物输出到 `dist/`：
- Windows: `dist/music-key-server.exe`
- Linux: `dist/music-key-server-linux-x64`
- macOS: `dist/music-key-server-macos-arm64`（Apple Silicon）或 `dist/music-key-server-macos-x64`（Intel）

包含 Node.js 运行时和所有静态文件，可直接复制到对应平台运行。

## 目录结构

```
music-key-server/
├── server.js              # 服务端入口
├── package.json
├── start.bat / start.sh    # 启动服务
├── build.bat / build.sh    # 构建可执行文件
├── clean.bat / clean.sh    # 清理项目
├── core/
│   ├── musickey-core.js   # 解密核心引擎（MIT，来自上游）
│   └── musickey-key.js    # 酷狗公钥表（MIT，来自上游）
├── public/                # 前端文件
│   ├── index.html
│   ├── musickey.css
│   ├── musickey-page.js
│   ├── musickey-core.js
│   └── musickey-key.js
└── dist/                  # 构建产物
```

## 许可证

本项目采用 **AGPLv3** 许可证。

解密算法核心（`core/musickey-core.js`、`core/musickey-key.js`）继承自上游 MIT 项目，详见 [NOTICE](NOTICE)。
