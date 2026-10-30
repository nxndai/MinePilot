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

const root = path.resolve(__dirname, '..');
const installerDir = path.join(root, 'tools', 'installer');
const sourcePath = path.join(installerDir, 'sfx', 'Installer.cs');
const icon = path.join(root, 'assets', 'MinePilot.ico');
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
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

function makePayload(staging, payload, stub) {
  if (!fs.existsSync(tar)) throw new Error('未找到 Windows tar.exe，无法创建安装数据包。');
  fs.copyFileSync(stub, path.join(staging, 'Uninstall.exe'));
  rm(payload);
  const args = ['-a', '-cf', payload, '-C', staging, '.'];
  try {
    execFileSync(tar, args, { encoding: 'utf8', timeout: 300000 });
  } catch (err) {
    // Some Windows Server images ship a tar.exe build that exits 1 without
    // producing a usable ZIP. Retry with the PowerShell archiver so CI is not
    // tied to a single tar implementation.
    console.warn('tar 创建安装数据包失败，改用 PowerShell Compress-Archive。');
    if (err.stdout) console.warn(String(err.stdout).trim());
    if (err.stderr) console.warn(String(err.stderr).trim());
    const quote = (value) => String(value).replace(/'/g, "''");
    const command = [
      "$ErrorActionPreference='Stop';",
      `Compress-Archive -Path '${quote(path.join(staging, '*'))}' -DestinationPath '${quote(payload)}' -Force`,
    ].join(' ');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      stdio: 'inherit',
      timeout: 300000,
    });
  }
  if (!fs.existsSync(payload) || fs.statSync(payload).size < 1024) {
    throw new Error('安装数据包生成失败。');
  }
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
    compileStub(version, stub, buildSource);
    console.log('编译小型安装器完成。');
    makePayload(staging, payload, stub);
    console.log(`生成安装数据包：${(fs.statSync(payload).size / 1024 / 1024).toFixed(1)} MB`);

    rm(outFile);
    fs.copyFileSync(stub, outFile);
    const data = fs.readFileSync(payload);
    fs.appendFileSync(outFile, data);
    const length = Buffer.alloc(8);
    length.writeBigInt64LE(BigInt(data.length), 0);
    fs.appendFileSync(outFile, length);
    fs.appendFileSync(outFile, Buffer.from('MPPAYLOAD1', 'ascii'));

    const size = fs.statSync(outFile).size;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');
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

module.exports = { buildSfx };