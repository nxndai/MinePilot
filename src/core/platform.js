'use strict';

/**
 * 平台适配层。
 *
 * 启动器的大部分逻辑是跨平台的，但 Minecraft 元数据、Java 安装包和系统
 * 打开方式都有平台差异。所有差异集中在这里，避免在业务代码里散落
 * `process.platform === 'win32'` 判断。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

function name() {
  return isWindows ? 'windows' : isMac ? 'osx' : isLinux ? 'linux' : process.platform;
}

function label() {
  return isWindows ? 'Windows' : isMac ? 'macOS' : isLinux ? 'Linux' : process.platform;
}

function archName() {
  return process.arch === 'x64' ? 'x64' : process.arch === 'ia32' ? 'ia32' : process.arch;
}

function mcArch() {
  if (process.arch === 'x64') return 'x86_64';
  if (process.arch === 'ia32') return 'x86';
  if (process.arch === 'arm64') return 'arm64';
  return process.arch;
}

function defaultGameDir() {
  if (isWindows) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, '.minecraft');
  }
  if (isMac) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft');
  }
  return path.join(os.homedir(), '.minecraft');
}

function javaBinaryName() {
  return isWindows ? 'javaw.exe' : 'java';
}

/** 在 Java 根目录中找出可执行文件。macOS 的 JRE 在 Contents/Home/bin 下。 */
function javaExecutableIn(root) {
  const candidates = [
    path.join(root, 'bin', javaBinaryName()),
    path.join(root, 'bin', 'java'),
    path.join(root, 'Contents', 'Home', 'bin', 'java'),
    path.join(root, 'Contents', 'Home', 'bin', 'javaw'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (err) { /* ignore */ }
  }
  return '';
}

/** 递归查找 Java 可执行文件，深度限制避免扫描整个系统。 */
function findJavaExecutable(root, depth = 0) {
  if (!root || depth > 4) return '';
  const direct = javaExecutableIn(root);
  if (direct) return direct;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch (err) {
    return '';
  }
  for (const entry of entries) {
    const found = findJavaExecutable(path.join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return '';
}

function javaHomeCandidates() {
  const list = [];
  const env = process.env;
  if (env.JAVA_HOME) list.push(env.JAVA_HOME);
  if (isWindows) {
    if (env.ProgramFiles) list.push(path.join(env.ProgramFiles, 'Java'));
    if (env['ProgramFiles(x86)']) list.push(path.join(env['ProgramFiles(x86)'], 'Java'));
    if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'Programs'));
  } else if (isMac) {
    list.push('/Library/Java/JavaVirtualMachines');
    list.push(path.join(os.homedir(), 'Library', 'Java', 'JavaVirtualMachines'));
    list.push('/opt/homebrew/opt/openjdk');
    list.push('/usr/local/opt/openjdk');
  } else {
    list.push('/usr/lib/jvm');
    list.push('/usr/java');
    list.push(path.join(os.homedir(), '.jdks'));
    list.push('/opt/java');
    list.push('/snap/java/current');
  }
  return list.filter(Boolean);
}

function javaOs() {
  if (isWindows) return 'windows';
  if (isMac) return 'mac';
  return 'linux';
}

function javaArch() {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'ia32') return 'x86';
  if (process.arch === 'arm64') return 'aarch64';
  return process.arch;
}

function javaArchiveExt() {
  return isWindows ? 'zip' : 'tar.gz';
}

function nativeArchToken() {
  if (process.arch === 'x64') return '64';
  if (process.arch === 'ia32') return '32';
  return process.arch;
}

/** Minecraft 旧版本使用 library.natives + classifiers；返回当前平台 classifier 键。 */
function nativesKey(library) {
  if (!library || !library.natives || typeof library.natives !== 'object') return '';
  const keyName = name();
  const aliases = keyName === 'osx' ? ['osx', 'macos', 'mac'] : [keyName];
  let value = '';
  for (const alias of aliases) {
    if (library.natives[alias]) {
      value = String(library.natives[alias]);
      break;
    }
  }
  if (!value) return '';
  return value.replace(/\$\{arch\}/g, nativeArchToken());
}

function nativeFilePattern() {
  if (isWindows) return /\.(dll|dylib|so)$/i;
  if (isMac) return /\.(dylib|jnilib)$/i;
  return /\.so(\.\d+)*$/i;
}

function nativeClassifierName(nameText) {
  const text = String(nameText || '');
  if (isWindows) {
    if (/natives-windows-arm64$/i.test(text)) return process.arch === 'arm64';
    if (/natives-windows-x86$/i.test(text)) return process.arch === 'ia32';
    return /natives-windows$/i.test(text);
  }
  if (isMac) {
    if (/natives-macos-arm64$/i.test(text)) return process.arch === 'arm64';
    if (/natives-macos$/i.test(text)) return process.arch !== 'arm64';
    return false;
  }
  if (/natives-linux-arm64$/i.test(text)) return process.arch === 'arm64';
  if (/natives-linux$/i.test(text)) return process.arch !== 'arm64';
  return false;
}

function artifactAllowed(nameText) {
  const text = String(nameText || '');
  if (!/natives-/i.test(text)) return true;
  return nativeClassifierName(text);
}

function platformAssetToken() {
  return `${name()}-${archName()}`;
}

function updaterAssetPattern() {
  if (isWindows) return /(win|windows).*(setup|installer|\.exe$)|\.exe$/i;
  if (isMac) return /(mac|darwin|osx|\.dmg$)/i;
  return /(linux|appimage|\.tar\.gz$|\.deb$)/i;
}

function openCommand() {
  if (isMac) return 'open';
  if (isLinux) return 'xdg-open';
  return '';
}

module.exports = {
  isWindows,
  isMac,
  isLinux,
  name,
  label,
  archName,
  mcArch,
  defaultGameDir,
  javaBinaryName,
  javaExecutableIn,
  findJavaExecutable,
  javaHomeCandidates,
  javaOs,
  javaArch,
  javaArchiveExt,
  nativesKey,
  nativeFilePattern,
  nativeClassifierName,
  artifactAllowed,
  platformAssetToken,
  updaterAssetPattern,
  openCommand,
};