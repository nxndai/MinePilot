'use strict';

/**
 * 将 MinePilot 打包为可双击运行的目录：dist/MinePilot/MinePilot.exe
 * 用法：node tools/package-win.js
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const electronDir = path.join(root, 'runtime', 'electron');
const outDir = path.join(root, 'dist', 'MinePilot');

if (process.platform !== 'win32') {
  console.error('此脚本仅用于 Windows 打包。');
  process.exit(1);
}
if (!fs.existsSync(path.join(electronDir, 'electron.exe'))) {
  console.error('未找到 runtime/electron/electron.exe，请先运行 tools/download-electron.js。');
  process.exit(1);
}

console.log('清理输出目录…');
// 先移除旧 data 链接，避免递归删除时误伤现有便携数据。
// 如果 data 是真实目录（用户已经运行过便携版），先移到输出目录外，
// 打完包再放回，避免升级打包时丢失账户、设置和游戏数据。
const previousData = path.join(outDir, 'data');
const backupData = path.join(root, 'dist', 'MinePilot.data.backup');
let hasDataBackup = false;
if (fs.existsSync(previousData)) {
  try {
    const stat = fs.lstatSync(previousData);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(previousData);
    } else if (stat.isDirectory()) {
      fs.rmSync(backupData, { recursive: true, force: true });
      fs.renameSync(previousData, backupData);
      hasDataBackup = true;
    }
  } catch (err) {
    console.warn('暂存旧 data 失败：' + err.message);
  }
}
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

console.log('复制 Electron 运行时…');
fs.cpSync(electronDir, outDir, { recursive: true });

const oldExe = path.join(outDir, 'electron.exe');
const newExe = path.join(outDir, 'MinePilot.exe');
fs.renameSync(oldExe, newExe);

console.log('复制应用图标…');
for (const iconName of ['MinePilot.ico', 'icon.png']) {
  const iconSource = path.join(root, 'assets', iconName);
  if (fs.existsSync(iconSource)) fs.copyFileSync(iconSource, path.join(outDir, iconName));
}

console.log('复制启动器代码…');
const appDir = path.join(outDir, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
const entries = ['package.json', 'main.js', 'preload.js', 'src', 'renderer', 'assets', 'LICENSE', 'NOTICE', 'README.md'];
for (const entry of entries) {
  const source = path.join(root, entry);
  if (!fs.existsSync(source)) continue;
  fs.cpSync(source, path.join(appDir, entry), { recursive: true });
}

// 便携版直接使用现有的 data（如果存在），这样升级时不会丢失账户、设置和游戏数据。
// 安装版不会携带 data，安装后首次运行会使用 %APPDATA%\MinePilot。
const legacyData = path.join(root, 'dist', 'MinePilotWeb', 'data');
const portableData = path.join(outDir, 'data');
try {
  if (hasDataBackup) {
    if (fs.existsSync(portableData)) fs.rmSync(portableData, { recursive: true, force: true });
    fs.renameSync(backupData, portableData);
    console.log('已恢复原有便携数据。');
  } else if (fs.existsSync(legacyData)) {
    fs.symlinkSync(legacyData, portableData, 'junction');
    console.log('已链接现有便携数据：' + legacyData);
  } else {
    fs.mkdirSync(portableData, { recursive: true });
  }
} catch (err) {
  fs.mkdirSync(portableData, { recursive: true });
  console.warn('创建 data 目录失败，将使用默认数据目录：' + err.message);
}

console.log('');
console.log('打包完成：' + newExe);
console.log('双击 MinePilot.exe 即可运行（独立应用窗口，不再打开 Edge）。');
