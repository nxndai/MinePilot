'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const config = require('./config');
const settings = require('./settings');
const net = require('./net');
const logger = require('./logger');
const { extractZip } = require('./zip');
const platform = require('./platform');

let cache = { at: 0, list: [] };
const inspected = new Map();

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    return [];
  }
}

function addCandidate(set, exe) {
  if (!exe) return;
  try {
    if (fs.existsSync(exe)) set.add(path.resolve(exe));
  } catch (err) {
    /* ignore */
  }
}

function javaExecutableIn(dir) {
  return platform.javaExecutableIn(dir);
}

function findJavaExe(root, depth = 0) {
  return platform.findJavaExecutable(root, depth) || null;
}

function gatherCandidates() {
  const set = new Set();

  const configured = String(settings.get().javaPath || '').trim();
  if (configured && fs.existsSync(configured)) {
    const stat = fs.statSync(configured);
    if (stat.isDirectory()) {
      addCandidate(set, javaExecutableIn(configured));
      addCandidate(set, path.join(configured, 'bin', platform.javaBinaryName()));
      addCandidate(set, path.join(configured, 'bin', 'java'));
    } else {
      addCandidate(set, configured);
      if (platform.isWindows && /java\.exe$/i.test(configured)) {
        addCandidate(set, configured.replace(/java\.exe$/i, 'javaw.exe'));
      }
    }
  }

  for (const name of listDirs(config.runtimeDir())) {
    addCandidate(set, findJavaExe(path.join(config.runtimeDir(), name)));
  }

  // 官方启动器下载的运行时（java-runtime-gamma / delta 等）
  const mcRuntimeRoots = [
    path.join(settings.get().gameDir, 'runtime'),
    platform.isWindows && process.env.APPDATA ? path.join(process.env.APPDATA, '.minecraft', 'runtime') : null,
    platform.isWindows && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime')
      : null,
    platform.isMac ? path.join(os.homedir(), 'Library', 'Application Support', 'minecraft', 'runtime') : null,
    platform.isLinux ? path.join(os.homedir(), '.minecraft', 'runtime') : null,
  ].filter(Boolean);
  for (const runtimeRoot of mcRuntimeRoots) {
    for (const name of listDirs(runtimeRoot)) {
      addCandidate(set, findJavaExe(path.join(runtimeRoot, name)));
    }
  }

  // macOS 的系统 Java 位置由 java_home 提供，优先读取，避免漏掉 /Library/Java 以外的 JDK。
  if (platform.isMac) {
    try {
      const probe = spawnSync('/usr/libexec/java_home', ['-v', '1.8+'], { encoding: 'utf8', timeout: 4000 });
      if (probe && !probe.error && probe.status === 0) {
        const home = String(probe.stdout || '').trim();
        if (home) addCandidate(set, javaExecutableIn(home));
      }
    } catch (err) { /* ignore */ }
  }

  for (const root of platform.javaHomeCandidates()) {
    addCandidate(set, javaExecutableIn(root));
    for (const sub of listDirs(root)) {
      addCandidate(set, javaExecutableIn(path.join(root, sub)));
    }
  }

  if (platform.isWindows) {
    for (const root of platform.javaHomeCandidates()) {
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru', 'JetBrains', 'Temurin']) {
        const vendorDir = path.join(root, vendor);
        for (const sub of listDirs(vendorDir)) {
          addCandidate(set, javaExecutableIn(path.join(vendorDir, sub)));
        }
      }
    }
  }

  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    addCandidate(set, path.join(dir, platform.javaBinaryName()));
    addCandidate(set, path.join(dir, 'java'));
  }

  return Array.from(set);
}

/**
 * 通过临时文件读取 java -version 的输出，避免使用管道（沙箱环境下管道可能不可用）。
 */
function probeVersion(exe) {
  const probeDir = path.join(config.cacheDir(), 'java-probe');
  fs.mkdirSync(probeDir, { recursive: true });
  const probeExe = /javaw\.exe$/i.test(exe) && fs.existsSync(exe.replace(/javaw\.exe$/i, 'java.exe'))
    ? exe.replace(/javaw\.exe$/i, 'java.exe')
    : exe;
  const outFile = path.join(probeDir, `probe-${process.pid}-${Date.now()}.txt`);
  let fd = null;
  try {
    fd = fs.openSync(outFile, 'w');
    spawnSync(probeExe, ['-version'], { stdio: ['ignore', fd, fd], windowsHide: true, timeout: 10000 });
  } catch (err) {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (err) { /* ignore */ }
    }
  }
  try {
    const text = fs.readFileSync(outFile, 'utf8');
    fs.unlinkSync(outFile);
    return text;
  } catch (err) {
    return '';
  }
}

function inspect(exe) {
  if (!exe || !fs.existsSync(exe)) return null;
  const cached = inspected.get(exe);
  if (cached && Date.now() - cached.at < 60000) return cached.info;

  let stat;
  try {
    stat = fs.statSync(exe);
  } catch (err) {
    return null;
  }

  const text = probeVersion(exe);
  const match = text.match(/version "([^"]+)"/i);
  if (!match) {
    logger.warn('无法解析 Java 版本:', exe, text.trim().slice(0, 120));
    return null;
  }
  const version = match[1];
  const major = version.startsWith('1.') ? parseInt(version.split('.')[1], 10) : parseInt(version.split('.')[0], 10);
  if (!Number.isFinite(major)) return null;

  let vendor = 'Java';
  if (/temurin|adoptium|adoptopenjdk/i.test(text)) vendor = 'Eclipse Temurin';
  else if (/zulu/i.test(text)) vendor = 'Azul Zulu';
  else if (/corretto/i.test(text)) vendor = 'Amazon Corretto';
  else if (/microsoft/i.test(text)) vendor = 'Microsoft OpenJDK';
  else if (/graalvm/i.test(text)) vendor = 'GraalVM';
  else if (/oracle/i.test(text)) vendor = 'Oracle JDK';
  else if (/openjdk/i.test(text)) vendor = 'OpenJDK';

  const info = {
    path: exe,
    major,
    version,
    vendor,
    arch: stat.size > 0 ? (process.arch === 'x64' ? '64 位' : process.arch) : '',
    modified: stat.mtimeMs,
  };
  inspected.set(exe, { at: Date.now(), info });
  return info;
}

async function detect(force = false) {
  if (!force && cache.list.length && Date.now() - cache.at < 60000) return cache.list;
  const seen = new Set();
  const list = [];
  for (const exe of gatherCandidates()) {
    if (seen.has(exe)) continue;
    seen.add(exe);
    const info = inspect(exe);
    if (info) list.push(info);
  }
  list.sort((a, b) => b.major - a.major || a.path.localeCompare(b.path));
  cache = { at: Date.now(), list };
  return list;
}

function requiredJava(mcVersion, metaMajor) {
  if (metaMajor) return metaMajor;
  const parts = String(mcVersion || '').split('.').map((p) => parseInt(p, 10));
  if (parts[0] === 1) {
    const minor = parts[1] || 0;
    const patch = parts[2] || 0;
    if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
    if (minor >= 17) return 17;
  }
  if (parts[0] >= 2) return 21;
  return 8;
}

async function installJava(major, onProgress, signal) {
  const targetMajor = [8, 17, 21].includes(Number(major)) ? Number(major) : 21;
  const targetOs = platform.javaOs();
  const targetArch = platform.javaArch();
  const api = `https://api.adoptium.net/v3/assets/latest/${targetMajor}/hotspot?architecture=${encodeURIComponent(targetArch)}&image_type=jre&os=${encodeURIComponent(targetOs)}&vendor=eclipse`;
  onProgress({ phase: `获取 Java ${targetMajor} 下载信息`, percent: 2 });
  const assets = await net.fetchJson(api, { signal, timeout: 30000 });
  const pkg = assets && assets[0] && assets[0].binary && assets[0].binary.package;
  if (!pkg || !pkg.link) throw new Error('无法获取 Java 下载地址，请检查网络');

  const runtimeDir = config.runtimeDir();
  const extension = /\.tar\.gz$/i.test(pkg.name || '') ? 'tar.gz' : /\.zip$/i.test(pkg.name || '') ? 'zip' : platform.javaArchiveExt();
  const archivePath = path.join(runtimeDir, `temurin-${targetMajor}.${extension}`);
  const targetDir = path.join(runtimeDir, `temurin-${targetMajor}`);
  const totalBytes = pkg.size || 0;
  // 清华镜像目前只稳定提供 Windows 包；macOS / Linux 使用 Adoptium 官方地址，避免 404。
  const mirrorLink = platform.isWindows
    ? `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${targetMajor}/jre/x64/windows/${pkg.name}`
    : '';
  let received = 0;
  let lastPercent = 0;

  onProgress({ phase: `下载 Java ${targetMajor}`, percent: 4, bytesTotal: totalBytes, bytesDone: 0 });
  await net.downloadFile(mirrorLink || pkg.link, archivePath, {
    signal,
    retries: 3,
    fallbackUrl: mirrorLink ? pkg.link : null,
    onBytes: (count) => {
      received += count;
      const percent = totalBytes ? Math.min(70, 4 + Math.floor((received / totalBytes) * 66)) : 30;
      if (percent > lastPercent) {
        lastPercent = percent;
        onProgress({ phase: `下载 Java ${targetMajor}`, percent, bytesTotal: totalBytes, bytesDone: received });
      }
    },
  });

  const expectedSha256 = pkg.checksum ? String(pkg.checksum).trim().toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    try { fs.rmSync(archivePath, { force: true }); } catch (err) { /* ignore */ }
    throw new Error('Java 下载源未提供有效的 SHA256 校验值，已中止安装');
  }
  onProgress({ phase: `校验 Java ${targetMajor}`, percent: 72 });
  const actualSha256 = await net.sha256File(archivePath);
  if (actualSha256 !== expectedSha256) {
    try { fs.rmSync(archivePath, { force: true }); } catch (err) { /* ignore */ }
    throw new Error('Java 安装包 SHA256 校验失败，文件可能不完整或已被篡改');
  }

  onProgress({ phase: `解压 Java ${targetMajor}`, percent: 74 });
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  try {
    if (extension === 'zip') {
      extractZip(archivePath, targetDir);
    } else {
      const tar = spawnSync('tar', ['-xzf', archivePath, '-C', targetDir], {
        windowsHide: true,
        timeout: 180000,
      });
      if (tar.error) throw new Error(`解压 Java 失败：${tar.error.message}`);
      if (tar.status !== 0) {
        const detail = String(tar.stderr || '').trim().slice(0, 200);
        throw new Error(`解压 Java 失败${detail ? `：${detail}` : ''}`);
      }
    }
  } finally {
    try { fs.rmSync(archivePath, { force: true }); } catch (err) { /* ignore */ }
  }

  const exe = findJavaExe(targetDir);
  if (!exe) throw new Error('Java 解压完成，但未找到可执行文件');
  if (!platform.isWindows) {
    try { fs.chmodSync(exe, 0o755); } catch (err) { /* ignore */ }
  }

  inspected.delete(exe);
  const info = inspect(exe);
  settings.update({ javaPath: exe });
  onProgress({ phase: `Java ${targetMajor} 安装完成`, percent: 100 });
  logger.info('已自动安装 Java:', exe, info && info.version);
  return { path: exe, major: info ? info.major : targetMajor, version: info ? info.version : '' };
}

/**
 * 返回适合指定游戏版本的 Java，优先使用用户设置。
 */
async function pickFor(requiredMajor, configuredPath, force = false) {
  const list = await detect(force);
  const configuredHit = configuredPath
    ? list.find((item) => path.resolve(item.path) === path.resolve(configuredPath))
    : null;
  if (configuredHit && configuredHit.major >= requiredMajor) {
    return { java: configuredHit, compatible: true };
  }
  const compatible = list.filter((item) => item.major >= requiredMajor);
  if (compatible.length) {
    // 优先选择刚好满足要求的最低版本，避免新 Java 与旧模组/加载器不兼容。
    const closest = compatible.slice().sort((a, b) => a.major - b.major || a.path.localeCompare(b.path))[0];
    return { java: closest, compatible: true };
  }
  if (configuredHit) return { java: configuredHit, compatible: false };
  if (list.length) return { java: list[0], compatible: false };
  return { java: null, compatible: false };
}

module.exports = {
  detect,
  inspect,
  requiredJava,
  installJava,
  pickFor,
  findJavaExe,
};