'use strict';

/**
 * 通用 MinePilot 自解压安装包构建器。
 *
 * NSIS 3.11（32 位）在当前 Windows 环境下无法为超过约 200 MB 的 Electron
 * 数据块创建 mmap，且大 ZIP 输出也会碰到限制。这里使用一个小型 C# 安装器，
 * 把 ZIP 追加到 exe 末尾；安装时再解压到目标目录。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createZip } = require('../src/core/zip');

const root = path.resolve(__dirname, '..');
const installerDir = path.join(root, 'tools', 'installer');
const sourcePath = path.join(installerDir, 'sfx', 'Installer.cs');
const icon = path.join(root, 'assets', 'MinePilot.ico');
const cscCandidates = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];
const skipEntries = new Set(['data', 'edge-profile', 'logs', 'server.log', 'bootstrap.log', 'web-port.txt']);

function rm(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function stage(appDir, staging) {
  if (!fs.existsSync(path.join(appDir, 'MinePilot.exe'))) {
    throw new Error(`未找到 ${appDir}\\MinePilot.exe，请先构建应用目录。`);
  }
  const pkgPath = fs.existsSync(path.join(appDir, 'package.json'))
    ? path.join(appDir, 'package.json')
    : path.join(appDir, 'resources', 'app', 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`未找到 ${appDir} 的应用 package.json。`);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  rm(staging);
  fs.mkdirSync(staging, { recursive: true });
  for (const name of fs.readdirSync(appDir)) {
    if (skipEntries.has(name)) continue;
    // 安装器会从自身 stub 前缀生成卸载程序，不把单独编译的卸载程序放进载荷。
    // 某些终端防护会锁定/隔离新编译的卸载器，导致 tar 无法读取。
    if (name === 'Uninstall.exe') continue;
    fs.cpSync(path.join(appDir, name), path.join(staging, name), { recursive: true });
  }
  for (const name of skipEntries) {
    if (fs.existsSync(path.join(staging, name))) {
      throw new Error(`安装包中混入了用户数据：${name}`);
    }
  }
  return pkg;
}

function compileStub(version, stub, buildSource) {
  const csc = cscCandidates.find((candidate) => fs.existsSync(candidate));
  if (!csc) throw new Error('未找到 .NET Framework C# 编译器 csc.exe。');
  if (!fs.existsSync(sourcePath)) throw new Error('缺少安装器源码 tools\\installer\\sfx\\Installer.cs。');
  const source = fs.readFileSync(sourcePath, 'utf8').replace(/__VERSION__/g, version);
  fs.writeFileSync(buildSource, source, 'utf8');
  const args = [
    '/nologo',
    '/target:winexe',
    '/codepage:65001',
    '/optimize+',
    '/out:' + stub,
    '/reference:System.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    '/reference:Microsoft.CSharp.dll',
  ];
  if (fs.existsSync(icon)) args.push('/win32icon:' + icon);
  args.push(buildSource);
  execFileSync(csc, args, { stdio: 'inherit', timeout: 120000 });
  if (!fs.existsSync(stub)) throw new Error('安装器 stub 编译失败。');
}

function buildUninstaller(outFile, version) {
  const target = path.resolve(outFile);
  const buildSource = path.join(installerDir, 'sfx-uninstall-build.cs');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    rm(target);
    compileStub(version, target, buildSource);
    if (!fs.existsSync(target)) throw new Error('卸载程序编译失败。');
    return target;
  } finally {
    rm(buildSource);
  }
}

function makePayload(staging, payload, uninstaller) {
  if (!Buffer.isBuffer(uninstaller) || !uninstaller.length) {
    throw new Error('安装器 stub 为空，无法生成卸载程序。');
  }
  const files = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) files.push(file);
    }
  };
  walk(staging);
  files.sort((a, b) => a.localeCompare(b));
  const entries = files.map((file) => ({
    name: path.relative(staging, file).split(path.sep).join('/'),
    filePath: file,
    mtime: fs.statSync(file).mtime,
  }));
  // 安装器自身在文件名变成 Uninstall.exe 时会进入卸载分支，因此可以直接作为
  // 卸载程序嵌入 ZIP。这样构建过程中不需要把单独编译的卸载器写到磁盘上。
  entries.push({ name: 'Uninstall.exe', data: uninstaller, mtime: new Date() });
  rm(payload);
  const result = createZip(entries, payload, { compress: true });
  if (!fs.existsSync(payload) || fs.statSync(payload).size < 1024) {
    throw new Error('安装数据包生成失败。');
  }
  return result;
}

function buildSfx(options) {
  const appDir = path.resolve(options.appDir);
  const outFile = path.resolve(options.outFile);
  const label = String(options.label || 'app').replace(/[^a-z0-9_-]/gi, '');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = String(options.version || pkg.version || '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`版本号应为 x.y.z，当前为 ${version}`);
  }
  const staging = path.join(installerDir, `sfx-staging-${label}`);
  const payload = path.join(installerDir, `sfx-payload-${label}.zip`);
  const stub = path.join(installerDir, `sfx-stub-${label}.exe`);
  const buildSource = path.join(installerDir, `sfx-build-${label}.cs`);

  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const appPkg = stage(appDir, staging);
    if (appPkg.version !== version) {
      throw new Error(`应用版本不一致：package.json=${version}，安装目录=${appPkg.version}`);
    }
    console.log(`暂存 ${label} 程序文件完成。`);
    let stubBuffer = Buffer.isBuffer(options.stubBuffer) ? options.stubBuffer : null;
    if (!stubBuffer) {
      compileStub(version, stub, buildSource);
      // 立刻把 stub 读入内存：部分终端防护会在编译后锁定/隔离新生成的 exe，
      // 等到大载荷打包完成再读就会得到 ENOENT / Permission denied。
      stubBuffer = fs.readFileSync(stub);
    }
    console.log('编译小型安装器完成。');
    makePayload(staging, payload, stubBuffer);
    console.log(`生成安装数据包：${(fs.statSync(payload).size / 1024 / 1024).toFixed(1)} MB`);

    const data = fs.readFileSync(payload);
    const length = Buffer.alloc(8);
    length.writeBigInt64LE(BigInt(data.length), 0);
    const marker = Buffer.from('MPPAYLOAD1', 'ascii');
    const installer = Buffer.concat([stubBuffer, data, length, marker]);
    rm(outFile);
    fs.writeFileSync(outFile, installer);

    const size = installer.length;
    const hash = crypto.createHash('sha256').update(installer).digest('hex');
    const hashPath = `${outFile}.sha256`;
    fs.writeFileSync(hashPath, `${hash}  ${path.basename(outFile)}\r\n`, 'utf8');
    console.log('');
    console.log(`安装包：${outFile}`);
    console.log(`大小：${(size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`SHA256：${hash}`);
    console.log(`校验文件：${hashPath}`);
    return { outFile, size, hash };
  } finally {
    rm(staging);
    rm(payload);
    rm(stub);
    rm(buildSource);
  }
}

module.exports = { buildSfx, buildUninstaller };