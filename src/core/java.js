'use strict';

const fs = require('fs');
const os = require('os');
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

function ignoredPaths() {
  return new Set((settings.get().javaIgnorePaths || []).map((item) => path.resolve(String(item || ''))));
}

function addCandidate(set, exe, ignored = ignoredPaths()) {
  if (!exe) return;
  try {
    const resolved = path.resolve(exe);
    if (ignored.has(resolved)) return;
    if (fs.existsSync(resolved)) set.add(resolved);
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

  for (const extra of settings.get().javaExtraPaths || []) {
    const value = String(extra || '').trim();
    if (!value) continue;
    try {
      const stat = fs.statSync(value);
      if (stat.isDirectory()) {
        addCandidate(set, javaExecutableIn(value));
        addCandidate(set, path.join(value, 'bin', platform.javaBinaryName()));
        addCandidate(set, path.join(value, 'bin', 'java'));
        addCandidate(set, findJavaExe(value));
      } else {
        addCandidate(set, value);
      }
    } catch (err) { /* ignore */ }
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
  const bits = /64-Bit/i.test(text) ? 64 : (/32-Bit/i.test(text) ? 32 : 0);

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
    bits,
    arch: bits ? `${bits} 位` : (stat.size > 0 ? (process.arch === 'x64' ? '64 位' : process.arch) : ''),
    modified: stat.mtimeMs,
  };
  inspected.set(exe, { at: Date.now(), info });
  return info;
}

async function detect(force = false) {
  if (!force && cache.list.length && Date.now() - cache.at < 60000) return cache.list;
  const seen = new Set();
  const list = [];
  const configured = String(settings.get().javaPath || '').trim();
  const extraPaths = new Set((settings.get().javaExtraPaths || []).map((item) => path.resolve(String(item || ''))));
  for (const exe of gatherCandidates()) {
    if (seen.has(exe)) continue;
    seen.add(exe);
    const info = inspect(exe);
    if (info) {
      list.push(Object.assign({}, info, {
        isDefault: Boolean(configured) && path.resolve(info.path) === path.resolve(configured),
        source: extraPaths.has(path.resolve(info.path)) ? 'manual' : 'auto',
      }));
    }
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

const JAVA_VENDORS = {
  temurin: { id: 'temurin', label: 'Eclipse Temurin', dir: 'temurin' },
  zulu: { id: 'zulu', label: 'Azul Zulu', dir: 'zulu' },
  corretto: { id: 'corretto', label: 'Amazon Corretto', dir: 'corretto' },
};

function archiveExtension(name) {
  return /\.tar\.gz$/i.test(name || '') ? 'tar.gz' : /\.zip$/i.test(name || '') ? 'zip' : platform.javaArchiveExt();
}

async function adoptiumPackage(major, signal) {
  const targetOs = platform.javaOs();
  const targetArch = platform.javaArch();
  const api = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${encodeURIComponent(targetArch)}&image_type=jre&os=${encodeURIComponent(targetOs)}&vendor=eclipse`;
  const assets = await net.fetchJson(api, { signal, timeout: 30000 });
  const pkg = assets && assets[0] && assets[0].binary && assets[0].binary.package;
  if (!pkg || !pkg.link) throw new Error('无法获取 Adoptium 下载地址，请检查网络');
  // 清华镜像目前只稳定提供 Windows 包；macOS / Linux 使用 Adoptium 官方地址，避免 404。
  const mirrorLink = platform.isWindows
    ? `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${major}/jre/x64/windows/${pkg.name}`
    : '';
  return {
    vendor: 'temurin',
    label: 'Eclipse Temurin',
    link: pkg.link,
    mirrorLink,
    name: pkg.name,
    checksum: pkg.checksum,
    size: pkg.size,
    extension: archiveExtension(pkg.name),
    targetDir: path.join(config.runtimeDir(), `temurin-${major}`),
    archivePath: path.join(config.runtimeDir(), `temurin-${major}.${archiveExtension(pkg.name)}`),
  };
}

async function zuluPackage(major, signal) {
  const osName = platform.javaOs() === 'windows' ? 'windows' : platform.javaOs() === 'mac' ? 'macos' : 'linux';
  const arch = platform.javaArch() === 'x64' ? 'x86_64' : platform.javaArch() === 'x86' ? 'i686' : 'aarch64';
  const query = new URLSearchParams({
    java_version: String(major),
    os: osName,
    arch,
    java_package_type: 'jre',
    latest: 'true',
    release_status: 'ga',
    page_size: '20',
  });
  const api = `https://api.azul.com/metadata/v1/zulu/packages/?${query.toString()}`;
  const data = await net.fetchJson(api, { signal, timeout: 30000 });
  const packages = Array.isArray(data) ? data : (data && Array.isArray(data.packages) ? data.packages : []);
  const pkg = packages.find((item) => item && item.download_url && /\.(zip|tar\.gz)$/i.test(item.name || item.download_url));
  if (!pkg) throw new Error('Azul 没有返回可用的 Java 下载包，请换用 Temurin 或 Corretto');
  return {
    vendor: 'zulu',
    label: 'Azul Zulu',
    link: pkg.download_url,
    mirrorLink: '',
    name: pkg.name || path.basename(new URL(pkg.download_url).pathname),
    checksum: pkg.sha256_hash || pkg.checksum,
    size: pkg.size,
    extension: archiveExtension(pkg.name || pkg.download_url),
    targetDir: path.join(config.runtimeDir(), `zulu-${major}`),
    archivePath: path.join(config.runtimeDir(), `zulu-${major}.${archiveExtension(pkg.name || pkg.download_url)}`),
  };
}

async function correttoPackage(major, signal) {
  const arch = platform.javaArch() === 'x64' ? 'x64' : platform.javaArch() === 'x86' ? 'x86' : 'aarch64';
  const osName = platform.javaOs() === 'windows' ? 'windows' : platform.javaOs() === 'mac' ? 'macos' : 'linux';
  const extension = platform.isWindows ? 'zip' : 'tar.gz';
  const name = `amazon-corretto-${major}-${arch}-${osName}-jdk.${extension}`;
  const link = `https://corretto.aws/downloads/latest/${name}`;
  // Corretto 官方提供独立的 SHA256 文件；没有校验值时不继续，避免把未知文件解压进运行时目录。
  let checksum = '';
  try {
    const text = await net.fetchText(`https://corretto.aws/downloads/latest_sha256/${name}`, { signal, timeout: 20000, retries: 2 });
    const match = String(text || '').match(/[a-f0-9]{64}/i);
    if (match) checksum = match[0].toLowerCase();
  } catch (err) {
    throw new Error(`无法获取 Amazon Corretto 的 SHA256 校验值：${err.message}`);
  }
  return {
    vendor: 'corretto',
    label: 'Amazon Corretto',
    link,
    mirrorLink: '',
    name,
    checksum,
    size: 0,
    extension,
    targetDir: path.join(config.runtimeDir(), `corretto-${major}`),
    archivePath: path.join(config.runtimeDir(), `corretto-${major}.${extension}`),
  };
}

async function resolveJavaPackage(vendor, major, signal) {
  if (vendor === 'zulu') return zuluPackage(major, signal);
  if (vendor === 'corretto') return correttoPackage(major, signal);
  return adoptiumPackage(major, signal);
}

async function installJava(major, onProgress, signal, options = {}) {
  const targetMajor = [8, 11, 17, 21].includes(Number(major)) ? Number(major) : 21;
  const vendor = JAVA_VENDORS[options.vendor] ? options.vendor : 'temurin';
  const label = JAVA_VENDORS[vendor].label;
  onProgress({ phase: `获取 ${label} Java ${targetMajor} 下载信息`, percent: 2 });
  const pkg = await resolveJavaPackage(vendor, targetMajor, signal);
  if (!pkg || !pkg.link) throw new Error('无法获取 Java 下载地址，请检查网络');

  const runtimeDir = config.runtimeDir();
  fs.mkdirSync(runtimeDir, { recursive: true });
  const extension = pkg.extension;
  const archivePath = pkg.archivePath;
  const targetDir = pkg.targetDir;
  const totalBytes = pkg.size || 0;
  let received = 0;
  let lastPercent = 0;

  onProgress({ phase: `下载 ${label} Java ${targetMajor}`, percent: 4, bytesTotal: totalBytes, bytesDone: 0 });
  await net.downloadFile(pkg.mirrorLink || pkg.link, archivePath, {
    signal,
    retries: 3,
    fallbackUrl: pkg.mirrorLink ? pkg.link : null,
    onBytes: (count) => {
      received += count;
      const percent = totalBytes ? Math.min(70, 4 + Math.floor((received / totalBytes) * 66)) : 30;
      if (percent > lastPercent) {
        lastPercent = percent;
        onProgress({ phase: `下载 ${label} Java ${targetMajor}`, percent, bytesTotal: totalBytes, bytesDone: received });
      }
    },
  });

  const expectedSha256 = pkg.checksum ? String(pkg.checksum).trim().toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    try { fs.rmSync(archivePath, { force: true }); } catch (err) { /* ignore */ }
    throw new Error(`${label} 下载源未提供有效的 SHA256 校验值，已中止安装`);
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
  settings.update({ javaPath: exe, javaVendor: vendor });
  onProgress({ phase: `Java ${targetMajor} 安装完成`, percent: 100 });
  logger.info('已自动安装 Java:', exe, info && info.version, vendor);
  return {
    path: exe,
    major: info ? info.major : targetMajor,
    version: info ? info.version : '',
    vendor,
    vendorLabel: label,
  };
}

/**
 * 返回适合指定游戏版本的 Java，优先使用用户设置。
 */
async function pickFor(requiredMajor, configuredPath, force = false, versionId = '') {
  const list = await detect(force);
  const overrides = settings.get().javaVersionOverrides || {};
  const overridePath = versionId ? String(overrides[versionId] || '').trim() : '';
  if (overridePath) {
    const overrideHit = list.find((item) => path.resolve(item.path) === path.resolve(overridePath));
    if (overrideHit) {
      return { java: overrideHit, compatible: overrideHit.major >= requiredMajor, override: true };
    }
    if (fs.existsSync(overridePath)) {
      const info = inspect(overridePath);
      if (info) return { java: Object.assign({}, info, { isDefault: false, source: 'manual' }), compatible: info.major >= requiredMajor, override: true };
    }
  }
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
  JAVA_VENDORS,
};