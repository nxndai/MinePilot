'use strict';

/*
 * 开发辅助脚本：下载 Electron 预编译运行时（不经过 npm，避免沙箱/代理问题）。
 * 用法：node tools/download-electron.js [版本] [目标目录]
 */

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { extractZip } = require('../src/core/zip');

const version = process.argv[2] || '33.2.0';
const targetDir = path.resolve(process.argv[3] || 'runtime/electron');
const cacheDir = path.resolve('.cache');
const zipPath = path.join(cacheDir, `electron-v${version}-win32-x64.zip`);
const fileName = `electron-v${version}-win32-x64.zip`;
const urls = [
  `https://npmmirror.com/mirrors/electron/${version}/${fileName}`,
  `https://registry.npmmirror.com/-/binary/electron/${version}/${fileName}`,
  `https://github.com/electron/electron/releases/download/v${version}/${fileName}`,
];

async function download(url) {
  console.log(`下载 ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length') || 0);
  let received = 0;
  let lastLog = 0;
  const stream = Readable.fromWeb(response.body);
  stream.on('data', (chunk) => {
    received += chunk.length;
    if (Date.now() - lastLog > 2000) {
      lastLog = Date.now();
      const percent = total ? ((received / total) * 100).toFixed(1) : '?';
      console.log(`  ${percent}%  ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
    }
  });
  await pipeline(stream, fs.createWriteStream(zipPath));
}

async function main() {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 50 * 1024 * 1024) {
    let lastError = null;
    for (const url of urls) {
      try {
        await download(url);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        console.warn('下载失败，尝试下一个源:', err.message);
        try { fs.rmSync(zipPath, { force: true }); } catch (e) { /* ignore */ }
      }
    }
    if (lastError) throw lastError;
  } else {
    console.log('使用已缓存的 Electron 压缩包');
  }

  const existing = path.join(targetDir, 'electron.exe');
  if (fs.existsSync(existing)) {
    console.log('Electron 运行时已存在:', existing);
    return;
  }

  console.log('解压 Electron ...');
  const count = extractZip(zipPath, targetDir);
  console.log(`完成，共 ${count} 个文件 -> ${targetDir}`);
}

main().catch((err) => {
  console.error('失败:', err.message);
  process.exit(1);
});