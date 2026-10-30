'use strict';

/**
 * 构建 Edge 应用窗口版：
 *   dist/MinePilotWeb/MinePilot.exe
 *
 * 该版本不依赖 Electron，由原生引导程序启动本地 Node 服务，
 * 再用 Microsoft Edge 的 --app 窗口加载界面。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist', 'MinePilotWeb');
const cscCandidates = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];

if (process.platform !== 'win32') {
  console.error('此脚本仅用于 Windows。');
  process.exit(1);
}

// 打包前先校验关键脚本，避免把语法错误带进发布目录。
for (const rel of ['server.js', 'main.js', 'src/core/launcher.js', 'src/core/mods.js', 'src/core/curseforge.js', 'src/core/skinmanager.js', 'src/core/appearance.js', 'src/core/monitor.js', 'src/core/procstats.js', 'src/core/platform.js', 'src/core/diagnostics.js', 'src/core/updater.js', 'src/core/plugins.js', 'renderer/js/appearance.js', 'renderer/js/skin.js', 'renderer/js/monitor.js', 'renderer/js/diagnostics.js', 'renderer/js/updater.js', 'renderer/js/plugins.js', 'renderer/js/account.js', 'renderer/js/mods.js']) {
  execFileSync(process.execPath, ['--check', path.join(root, rel)], { stdio: 'inherit' });
}

const csc = cscCandidates.find((candidate) => fs.existsSync(candidate));
if (!csc) {
  console.error('未找到 .NET Framework C# 编译器 csc.exe。');
  process.exit(1);
}
if (!fs.existsSync(process.execPath)) {
  console.error('当前 Node 可执行文件不存在。');
  process.exit(1);
}

console.log('准备输出目录…');
// 某些 Windows 安全策略会给已存在的程序目录加上禁止删除子项的权限。
// 这里改为覆盖更新：保留 data\ 中的账户与设置，也不删除用户已有的 Edge 配置。
fs.mkdirSync(outDir, { recursive: true });

console.log('复制启动器代码…');
const entries = ['package.json', 'server.js', 'main.js', 'preload.js', 'src', 'renderer', 'assets', 'LICENSE', 'NOTICE', 'README.md'];
for (const entry of entries) {
  const source = path.join(root, entry);
  if (!fs.existsSync(source)) continue;
  fs.cpSync(source, path.join(outDir, entry), { recursive: true });
}

console.log('复制 Node 运行时…');
const nodeDir = path.join(outDir, 'runtime', 'node');
fs.mkdirSync(nodeDir, { recursive: true });
try {
  fs.copyFileSync(process.execPath, path.join(nodeDir, 'node.exe'));
} catch (err) {
  // 启动器正在运行时 node.exe 会被占用；运行时不随代码变化，保留现有文件即可。
  if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
    console.warn('Node 运行时正在使用中，跳过复制（保留现有 runtime/node/node.exe）。');
  } else {
    throw err;
  }
}

console.log('写入服务启动脚本…');
fs.copyFileSync(
  path.join(root, 'tools', 'web-launcher', 'start-server.cmd'),
  path.join(outDir, 'start-server.cmd')
);
fs.copyFileSync(
  path.join(root, 'tools', 'web-launcher', 'MinePilot.vbs'),
  path.join(outDir, 'MinePilot.vbs')
);
fs.copyFileSync(
  path.join(root, 'tools', 'web-launcher', 'repair-game-dirs.cmd'),
  path.join(outDir, 'repair-game-dirs.cmd')
);

const fallback = [
  '@echo off',
  'setlocal',
  'cd /d "%~dp0"',
  'set "EDGE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
  'if not exist "%EDGE%" set "EDGE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
  'start "" /min "%~dp0runtime\\node\\node.exe" "%~dp0server.js" --port 46321',
  'timeout /t 2 /nobreak >nul',
  'start "" "%EDGE%" --app=http://127.0.0.1:46321/?web=1 --no-first-run --no-default-browser-check',
  '',
].join('\r\n');
fs.writeFileSync(path.join(outDir, '启动_MinePilot.cmd'), fallback, 'utf8');

fs.writeFileSync(path.join(outDir, '使用说明.txt'), '\ufeff' + [
  'MinePilot Edge 版',
  '',
  '双击桌面上的 MinePilot 快捷方式启动。',
  '也可以双击本目录的 MinePilot.exe 或 MinePilot.vbs。',
  '安装版可从桌面或开始菜单启动；卸载程序默认保留 data\\ 目录。',
  '如果安全软件拦截了 MinePilot.exe，可以双击 启动_MinePilot.cmd。',
  '',
  '这个版本不依赖 Electron：由系统脚本启动本地 Node 服务，',
  '再用 Microsoft Edge 的应用窗口显示界面。',
  '',
  '「模组」页支持 Modrinth 与 CurseForge 两个来源，可按功能、优化、科技等分类筛选。',
  'Modrinth 开箱可用；CurseForge 需要在「设置 → 模组来源」填入自己的 API Key。',
  '请先给目标版本安装 Fabric、Forge、NeoForge 或 Quilt，否则模组不会加载。',
  '',
  '数据目录：程序目录下的 data\\',
  '游戏目录：%APPDATA%\\.minecraft',
  '',
  '账户：设置或首页头像可登录 Microsoft 正版账户；也可以继续使用离线账户。',
  '登录时如果浏览器没有自动打开，请点“复制链接”，手动访问 https://www.microsoft.com/link。',
  '在浏览器里登录后，还需要点“继续 / 接受”完成授权，启动器才会显示登录成功。',
  '如果启动游戏提示无法写入游戏数据目录（EPERM），请确认是从桌面快捷方式直接启动，',
  '不要在聊天窗口、预览页或沙箱里启动；仍失败时把游戏目录换到普通可写文件夹，',
  '或把 MinePilot 和使用的 Java 加入安全软件的信任/排除列表。',
  '如果提示 logs/saves/crash-reports/downloads 目录不可用，先双击本目录的 repair-game-dirs.cmd，',
  '它会为所有版本和全局游戏目录补齐这些文件夹，然后再启动游戏。',
  '如果目录存在但游戏仍报 AccessDenied，启动器会自动改用 data\\game\\<版本号> 便携目录，',
  '并复制原版本的 mods、saves、config；新存档会保存在便携目录中。',
  '加载器：在“版本”页选择已安装版本，点击“加载器”即可安装 Fabric 或 Forge。',
  '',
  '如果你有自己的 Azure 应用，可在启动前设置环境变量 MINEPILOT_MS_CLIENT_ID。',
  '',
].join('\r\n'), 'utf8');

console.log('复制图标…');
const iconCandidates = [
  path.join(root, 'assets', 'MinePilot.ico'),
  path.join(root, 'dist', 'MinePilot', 'MinePilot.ico'),
];
const icon = iconCandidates.find((candidate) => fs.existsSync(candidate));
if (icon) fs.copyFileSync(icon, path.join(outDir, 'MinePilot.ico'));

console.log('编译原生引导程序…');
const exePath = path.join(outDir, 'MinePilot.exe');
const cscArgs = [
  '/nologo',
  '/target:winexe',
  '/codepage:65001',
  '/out:' + exePath,
  '/reference:System.dll',
  '/reference:System.Windows.Forms.dll',
  '/reference:System.Drawing.dll',
  path.join(root, 'tools', 'web-launcher', 'Program.cs'),
];
if (icon) cscArgs.push('/win32icon:' + icon);
execFileSync(csc, cscArgs, { stdio: 'inherit' });

console.log('');
console.log('打包完成：' + exePath);
console.log('双击 MinePilot.exe 即可运行。');