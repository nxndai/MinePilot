'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const mojang = require('./mojang');
const settings = require('./settings');
const accounts = require('./accounts');
const versions = require('./versions');
const config = require('./config');
const logger = require('./logger');
const { extractZip } = require('./zip');
const integrity = require('./integrity');
const platform = require('./platform');

const LAUNCHER_NAME = 'MinePilot';
const LAUNCHER_VERSION = '1.8.0';

function effectiveMemoryMb(value, recommended, javaBits) {
  let memory;
  if (!value || value.memoryAuto !== false) {
    memory = Number(recommended) || settings.recommendedMemory();
  } else {
    memory = Math.max(512, Math.min(65536, parseInt(value.memoryMb, 10) || settings.recommendedMemory()));
  }
  // 32 位 Java 的可用堆通常不到 1.5 GB，分配过大将无法创建 JVM。
  if (Number(javaBits) === 32) memory = Math.min(memory, 1024);
  return memory;
}

// G1GC tuning based on the widely used Aikar-style flags. These only change
// garbage-collection behavior; they do not alter game files or authentication.
function memoryArgs(enabled, javaMajor) {
  if (!enabled || Number(javaMajor) < 8) return [];
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
  ];
}

function formatMemory(mb) {
  const value = Number(mb) || 0;
  return value % 1024 === 0 ? `${value / 1024} GB` : `${(value / 1024).toFixed(1)} GB`;
}

function nativesKey(library) {
  return platform.nativesKey(library) || null;
}

async function prepareNatives(meta, gameDir, versionId, onLog) {
  // 放在启动器数据目录，避免部分电脑禁止向 .minecraft\versions 写入新目录。
  const nativesDir = path.join(config.root(), 'natives', versionId);
  fs.rmSync(nativesDir, { recursive: true, force: true });
  fs.mkdirSync(nativesDir, { recursive: true });

  for (const lib of meta.libraries) {
    const key = nativesKey(lib);
    if (!key || !lib.classifiers[key]) continue;
    const classifier = lib.classifiers[key];
    const jar = path.join(gameDir, 'libraries', classifier.path);
    if (!fs.existsSync(jar)) {
      const error = new Error(`缺少运行库 ${lib.name}，请重新安装该版本`);
      error.code = 'MISSING_FILES';
      throw error;
    }
    try {
      extractZip(jar, nativesDir, { filter: (name) => platform.nativeFilePattern().test(name) });
    } catch (err) {
      if (onLog) onLog(`[MinePilot] 解压运行库失败：${lib.name}（${err.message}）\n`);
      logger.warn('解压运行库失败:', lib.name, err.message);
    }
  }
  return nativesDir;
}

function buildClasspath(meta, gameDir) {
  const entries = [];
  const missing = [];
  for (const lib of meta.libraries) {
    if (!lib.artifact) continue;
    if (!mojang.rulesAllow(lib.rules, mojang.DEFAULT_FEATURES)) continue;
    if (!platform.artifactAllowed(lib.name)) continue;
    const file = path.join(gameDir, 'libraries', lib.artifact.path);
    if (fs.existsSync(file)) entries.push(file);
    else missing.push(lib.artifact.path);
  }
  const jar = path.join(gameDir, 'versions', meta.jarId, `${meta.jarId}.jar`);
  if (fs.existsSync(jar)) entries.push(jar);
  else missing.push(`versions/${meta.jarId}/${meta.jarId}.jar`);

  if (missing.length) {
    const error = new Error(`版本文件不完整，缺少 ${missing.length} 个文件（例如 ${missing[0]}），请在“下载”页重新安装该版本`);
    error.code = 'MISSING_FILES';
    error.missing = missing;
    throw error;
  }
  return entries.join(path.delimiter);
}

function resolveJavaExecutable(javaPath) {
  if (!javaPath) return null;
  // Windows 上优先使用 java.exe：部分安全软件对 javaw.exe 的子进程写入限制更严格。
  if (/java\.exe$/i.test(javaPath) && fs.existsSync(javaPath)) return javaPath;
  if (/javaw\.exe$/i.test(javaPath)) {
    const java = javaPath.replace(/javaw\.exe$/i, 'java.exe');
    if (fs.existsSync(java)) return java;
  }
  return javaPath;
}

function ensureGameDirectories(gameDir, onLog) {
  const names = ['logs', 'saves', 'crash-reports', 'resourcepacks', 'downloads', 'mods', 'config', 'screenshots', 'shaderpacks'];
  const critical = new Set(['logs', 'saves']);
  const failures = [];
  for (const name of names) {
    const target = path.join(gameDir, name);
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch (err) {
      const detail = `${name}（${err.code || err.message}）`;
      if (critical.has(name)) failures.push(detail);
      if (onLog) {
        if (name === 'downloads') {
          onLog('[MinePilot] downloads 目录不可用：1.21.8 等需要下载队列的版本会启动失败；请在资源管理器里手动新建该文件夹。\n');
        } else {
          onLog(`[MinePilot] 可选目录暂时不可用：${detail}\n`);
        }
      }
    }
  }
  if (failures.length) {
    if (onLog) onLog(`[MinePilot] 无法创建游戏目录：${failures.join('、')}\n`);
    const error = new Error(
      `启动器无法写入游戏数据目录 ${gameDir}（${failures.join('、')}）。` +
      `如果你是从聊天窗口、预览页或受限沙箱里启动的，请关闭后从${platform.label()}应用菜单直接启动；` +
      '如果仍然失败，请把游戏目录换到一个普通可写文件夹，或在安全软件中允许 MinePilot 和它使用的 Java。',
    );
    error.code = 'GAME_DIR_DENIED';
    throw error;
  }
}

function ensureGameDirectoryReady(gameDir, onLog) {
  try {
    fs.mkdirSync(gameDir, { recursive: true });
    ensureGameDirectories(gameDir, onLog);
  } catch (err) {
    if (err.code === 'GAME_DIR_DENIED') throw err;
    const error = new Error(
      `启动器无法创建游戏数据目录 ${gameDir}（${err.code || err.message}）。` +
      `请从${platform.label()}应用菜单直接启动，或把游戏目录换到一个普通可写文件夹。`,
    );
    error.code = 'GAME_DIR_DENIED';
    throw error;
  }

  // 目录存在不代表能写文件：1.21.8 就是 downloads 目录存在、log.json 仍被拒绝。
  const probe = path.join(gameDir, `.minepilot-write-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
  } catch (err) {
    try { fs.unlinkSync(probe); } catch {}
    if (onLog) onLog(`[MinePilot] 游戏目录存在但无法写入文件：${err.code || err.message}\n`);
    const error = new Error(
      `游戏数据目录 ${gameDir} 可以访问，但无法写入文件（${err.code || err.message}）。` +
      '这通常是安全软件或沙箱拦截，请从桌面快捷方式启动，或把游戏目录换到普通可写文件夹。',
    );
    error.code = 'GAME_DIR_DENIED';
    throw error;
  }
}

function copyInitialGameData(sourceDir, targetDir, onLog) {
  if (!sourceDir || path.resolve(sourceDir) === path.resolve(targetDir)) return;
  const entries = ['mods', 'config', 'saves', 'resourcepacks', 'shaderpacks', 'options.txt', 'servers.dat'];
  for (const name of entries) {
    const source = path.join(sourceDir, name);
    if (!fs.existsSync(source)) continue;
    const target = path.join(targetDir, name);
    try {
      fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
    } catch (err) {
      if (onLog) onLog(`[MinePilot] 复制 ${name} 到便携目录失败：${err.message}\n`);
    }
  }
}

function replaceKnownPlaceholders(value, vars) {
  let output = String(value).replace(/\$\{classpath_separator\}/g, path.delimiter);
  for (const [key, replacement] of Object.entries(vars)) {
    if (replacement === undefined || replacement === null) continue;
    output = output.split(`\${${key}}`).join(String(replacement));
  }
  return output;
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlField(block, tag) {
  const cdata = block.match(new RegExp(`<log4j:${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></log4j:${tag}>`));
  if (cdata) return cdata[1];
  const plain = block.match(new RegExp(`<log4j:${tag}>([\\s\\S]*?)</log4j:${tag}>`));
  return plain ? decodeXmlEntities(plain[1]) : '';
}

/**
 * Minecraft 的控制台使用 LegacyXMLLayout 输出 XML。这里把完整的事件块转换成
 * 易读的文本，同时保留 JVM / 启动器输出的普通文本。
 */
function createLogFormatter(emit) {
  let buffer = '';

  const formatEvent = (block) => {
    const attr = (name) => {
      const match = block.match(new RegExp(`${name}="([^"]*)"`));
      return match ? decodeXmlEntities(match[1]) : '';
    };
    const timestamp = Number(attr('timestamp')) || Date.now();
    const time = new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
    const level = attr('level') || 'INFO';
    const thread = attr('thread') || 'main';
    const loggerName = attr('logger') || '';
    const message = xmlField(block, 'Message');
    const throwable = xmlField(block, 'Throwable');

    // 离线账户没有正版令牌，客户端仍会尝试查询账户属性并得到 401。
    // 这是预期行为，压缩成一行提示，避免整段堆栈吓到用户。
    if (/Failed to verify authentication/i.test(message)) {
      return `[${time}] [${thread}/WARN] [MinePilot] 离线模式：跳过正版账户验证（HTTP 401），单人游戏不受影响\n`;
    }

    let line = `[${time}] [${thread}/${level}]`;
    if (loggerName) line += ` [${loggerName}]`;
    line += ` ${message}`;
    if (throwable && throwable.trim()) line += `\n${throwable.trim()}`;
    return `${line}\n`;
  };

  const drain = () => {
    let output = '';
    for (;;) {
      if (!buffer) break;
      const start = buffer.indexOf('<log4j:Event');
      if (start < 0) {
        const lastOpen = buffer.lastIndexOf('<');
        const safe = lastOpen < 0 ? buffer : buffer.slice(0, lastOpen);
        const rest = lastOpen < 0 ? '' : buffer.slice(lastOpen);
        const cleaned = safe.replace(/<\?xml[^>]*\?>/g, '').trim();
        if (cleaned) output += `${cleaned}\n`;
        buffer = rest;
        break;
      }
      if (start > 0) {
        const plain = buffer.slice(0, start).replace(/<\?xml[^>]*\?>/g, '').trim();
        if (plain) output += `${plain}\n`;
        buffer = buffer.slice(start);
      }
      const end = buffer.indexOf('</log4j:Event>');
      if (end < 0) break;
      const block = buffer.slice(0, end + '</log4j:Event>'.length);
      buffer = buffer.slice(end + '</log4j:Event>'.length);
      output += formatEvent(block);
    }
    if (output) emit(output);
  };

  return {
    push(text) {
      buffer += text;
      if (buffer.length > 400000) buffer = buffer.slice(-200000);
      drain();
    },
    flush() {
      if (buffer.trim()) emit(buffer);
      buffer = '';
    },
  };
}

function gameLanguageCode(language) {
  return language === 'en-US' ? 'en_us' : 'zh_cn';
}

/**
 * 让游戏语言跟随启动器语言。
 * 只改 options.txt 的 lang 行，保留分辨率、音量等其他设置。
 * 写入失败时只记录警告，不阻断启动。
 */
function applyGameLanguage(gameDir, language, onLog) {
  const code = gameLanguageCode(language);
  const file = path.join(gameDir, 'options.txt');
  let raw = '';
  let exists = false;
  try {
    raw = fs.readFileSync(file, 'utf8');
    exists = true;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      if (onLog) onLog(`[MinePilot] 无法读取游戏语言设置：${err.message}\n`);
      return false;
    }
  }

  const hadBom = raw.charCodeAt(0) === 0xfeff;
  if (hadBom) raw = raw.slice(1);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw === '' ? [] : raw.split(/\r?\n/);
  let found = false;
  let changed = false;
  const next = lines.map((line) => {
    if (!/^lang:/i.test(line)) return line;
    found = true;
    const replacement = `lang:${code}`;
    if (line !== replacement) changed = true;
    return replacement;
  });
  if (!found) {
    next.push(`lang:${code}`);
    changed = true;
  }
  if (!changed) return false;

  let output = next.join(eol);
  if (output && !output.endsWith(eol)) output += eol;
  try {
    fs.writeFileSync(file, (hadBom ? '\ufeff' : '') + output, 'utf8');
  } catch (err) {
    if (onLog) onLog(`[MinePilot] 无法写入游戏语言设置：${err.message}\n`);
    return false;
  }
  if (onLog) {
    onLog(`[MinePilot] 游戏语言已设置为${code === 'en_us' ? '英文' : '简体中文'}（${exists ? 'options.txt' : '新建 options.txt'}）。\n`);
  }
  return true;
}

async function launch(versionId, options = {}) {
  const { javaPath, javaMajor = 0, javaBits = 0, onLog = null, onExit = null, onProgress = null } = options;
  const s = settings.get();
  const baseGameDir = s.gameDir;
  const isolated = versions.isolateFor(baseGameDir, versionId, s.versionIsolation);
  const defaultGameDir = versions.effectiveDir(baseGameDir, versionId, isolated, s.gameDataDir);
  let gameDir = defaultGameDir;
  let portable = Boolean(s.gameDataDir);

  if (!javaPath || !fs.existsSync(javaPath)) {
    const error = new Error('尚未配置可用的 Java 运行环境');
    error.code = 'NO_JAVA';
    throw error;
  }

  try {
    ensureGameDirectoryReady(gameDir, onLog);
  } catch (err) {
    if (err.code !== 'GAME_DIR_DENIED' || s.gameDataDir) throw err;

    // 原目录被系统安全策略拒绝写入时，退回到启动器自己的可写数据目录。
    // 只复制存档、模组、配置等用户数据，不复制日志和缓存。
    const portableDir = path.join(config.root(), 'game', versionId);
    if (onLog) {
      onLog(`[MinePilot] 原游戏目录不可写，改用便携数据目录：${portableDir}\n`);
    }
    ensureGameDirectoryReady(portableDir, onLog);
    copyInitialGameData(defaultGameDir, portableDir, onLog);
    gameDir = portableDir;
    portable = true;
    if (onLog) {
      onLog('[MinePilot] 已把原版本的模组/存档/配置复制到便携目录；之后的新存档会保存在这里。\n');
    }
  }

  if (s.gameDataDir) {
    const sourceDir = versions.gameDirFor(baseGameDir, versionId, isolated);
    if (onLog) onLog(`[MinePilot] 使用便携游戏数据目录：${gameDir}\n`);
    if (path.resolve(sourceDir) !== path.resolve(gameDir)) {
      copyInitialGameData(sourceDir, gameDir, onLog);
    }
  }

  const meta = await mojang.loadVersion(baseGameDir, versionId);
  if (!meta.mainClass) {
    const error = new Error('版本信息缺少主类，无法启动');
    error.code = 'INVALID_VERSION';
    throw error;
  }

  let profile;
  try {
    profile = await accounts.profileFor(s);
  } catch (err) {
    const error = new Error(err.message);
    error.code = err.code || 'AUTH_FAILED';
    throw error;
  }

  const log = (text) => { if (onLog) onLog(text); };
  const recommendedMemory = settings.recommendedMemory();
  const desiredMemory = effectiveMemoryMb(s, recommendedMemory);
  const memoryMb = effectiveMemoryMb(s, recommendedMemory, javaBits);
  const autoMemory = s.memoryAuto !== false;
  const userJvmArgs = s.jvmArgs && s.jvmArgs.trim() ? mojang.splitArgs(s.jvmArgs) : [];
  const hasGcChoice = userJvmArgs.some((arg) => /^-XX:\+Use[A-Za-z0-9]+GC$/.test(arg));
  const optimizeMemory = s.memoryOptimize !== false && Number(javaMajor) >= 8 && !hasGcChoice;
  log(`[MinePilot] 正在准备启动 ${versionId} ...\n`);
  log(`[MinePilot] 内存：${formatMemory(memoryMb)}（${autoMemory ? '自动' : '手动'}）`
    + `${optimizeMemory ? ' · G1GC 优化已启用' : ''}。\n`);
  if (Number(javaBits) === 32 && memoryMb < desiredMemory) {
    log(`[MinePilot] 检测到 32 位 Java，已将内存限制为 ${formatMemory(memoryMb)}。\n`);
  }
  if (s.memoryOptimize !== false && hasGcChoice) {
    log('[MinePilot] 已保留自定义 GC 参数，跳过内置 G1GC 优化。\n');
  } else if (s.memoryOptimize !== false && Number(javaMajor) > 0 && Number(javaMajor) < 8) {
    log(`[MinePilot] 当前 Java ${javaMajor} 低于 8，已跳过 G1GC 内存优化。\n`);
  }
  applyGameLanguage(gameDir, s.language, log);
  log(s.onlineDownloads
    ? '[MinePilot] 正在校验核心库与资源文件，缺失或损坏的文件会自动补全…\n'
    : '[MinePilot] 正在校验核心库与资源文件（在线下载已关闭，仅使用本地文件）…\n');

  const integrityResult = await integrity.ensureFiles(meta, baseGameDir, {
    useMirror: s.useMirror,
    downloadAssets: s.downloadAssets,
    allowDownloads: s.onlineDownloads === true,
    threads: s.downloadThreads,
    onProgress: (progress) => {
      if (onProgress) onProgress(progress);
    },
  });
  if (integrityResult.repaired > 0) {
    log(`[MinePilot] 完整性校验完成：已修复 ${integrityResult.repaired} 个文件（缺失 ${integrityResult.missing}，损坏 ${integrityResult.broken}）。\n`);
  } else if (integrityResult.optionalMissing > 0) {
    log(`[MinePilot] 有 ${integrityResult.optionalMissing} 个可选资源/日志文件缺失或无法写入，已跳过；游戏会使用现有资源继续启动。\n`);
  } else {
    log(`[MinePilot] 完整性校验通过：${integrityResult.checked} 个文件。\n`);
  }
  if (integrityResult.skippedAssets) {
    log('[MinePilot] 设置中关闭了“下载资源文件”，已跳过资源对象校验；声音/贴图缺失时请在设置中开启该选项。\n');
  }

  const nativesDir = await prepareNatives(meta, baseGameDir, versionId, log);
  const classpath = buildClasspath(meta, baseGameDir);

  const features = Object.assign({}, mojang.DEFAULT_FEATURES, { has_custom_resolution: !s.fullscreen });

  const vars = {
    auth_player_name: profile.name,
    version_name: meta.id,
    game_directory: gameDir,
    assets_root: path.join(baseGameDir, 'assets'),
    assets_index_name: meta.assets || (meta.assetIndex && meta.assetIndex.id) || 'legacy',
    auth_uuid: profile.uuid,
    auth_access_token: profile.accessToken,
    auth_session: profile.accessToken,
    user_type: profile.userType,
    version_type: meta.type || 'release',
    natives_directory: nativesDir,
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    classpath,
    library_directory: path.join(baseGameDir, 'libraries'),
    resolution_width: s.width,
    resolution_height: s.height,
    user_properties: '{}',
    clientid: '',
    auth_xuid: profile.xuid || '',
  };

  const jvm = [];
  jvm.push(`-Xmx${memoryMb}M`);
  jvm.push(`-Xms${Math.min(memoryMb, 2048)}M`);
  if (optimizeMemory) jvm.push(...memoryArgs(true, javaMajor));
  jvm.push(`-Dminecraft.launcher.brand=${LAUNCHER_NAME}`);
  jvm.push(`-Dminecraft.launcher.version=${LAUNCHER_VERSION}`);
  jvm.push('-Dlog4j2.formatMsgNoLookups=true');
  jvm.push('-Dfile.encoding=UTF-8');

  if (meta.logging && meta.logging.file && meta.logging.file.id) {
    const logConfig = path.join(baseGameDir, 'assets', 'log_configs', meta.logging.file.id);
    if (fs.existsSync(logConfig)) {
      jvm.push(`-Dlog4j.configurationFile=${logConfig}`);
    }
  }
  if (userJvmArgs.length) {
    jvm.push(...userJvmArgs);
  }

  const versionJvm = mojang.expandArguments(meta.jvmArgs, features)
    .map((arg) => replaceKnownPlaceholders(mojang.substitute(arg, vars), vars));
  let hasClasspathArg = false;
  let hasLibraryPath = false;
  for (const arg of versionJvm) {
    if (arg === '-cp' || arg === '-classpath' || arg === '--class-path' || arg === classpath) hasClasspathArg = true;
    if (arg.startsWith('-Djava.library.path=')) hasLibraryPath = true;
  }
  jvm.push(...versionJvm);

  // 固定 natives / JNA / LWJGL 的临时目录。旧版本（例如 1.18）的
  // 参数里没有这些路径，JNA 会往 %TEMP% 写 dll，遇到安全软件会直接拒绝访问。
  for (const [prefix, value] of [
    ['-Djna.tmpdir=', nativesDir],
    ['-Dorg.lwjgl.system.SharedLibraryExtractPath=', nativesDir],
    ['-Dio.netty.native.workdir=', nativesDir],
  ]) {
    if (!jvm.some((arg) => arg.startsWith(prefix))) jvm.push(`${prefix}${value}`);
  }
  if (!hasLibraryPath) jvm.push(`-Djava.library.path=${nativesDir}`);
  if (!hasClasspathArg) jvm.push('-cp', classpath);

  let gameArgs;
  if (meta.legacyArgs) gameArgs = mojang.splitArgs(meta.legacyArgs);
  else gameArgs = mojang.expandArguments(meta.gameArgs, features);
  gameArgs = gameArgs.map((arg) => replaceKnownPlaceholders(mojang.substitute(arg, vars), vars));
  if (s.fullscreen) gameArgs.push('--fullscreen');

  const javaExe = resolveJavaExecutable(javaPath);
  const args = jvm.concat([meta.mainClass], gameArgs);
  const safeArgs = redactCommandLine(args);
  const logPath = path.join(config.logsDir(), `launch-${versionId}-${Date.now()}.log`);
  const header = [
    `# MinePilot ${LAUNCHER_VERSION} 启动日志`,
    `# 时间: ${new Date().toLocaleString()}`,
    `# Java: ${javaExe}`,
    `# 版本: ${versionId}  玩家: ${profile.name}`,
    '',
    '# 命令行:',
    `${javaExe} ${safeArgs.map(quoteForLog).join(' ')}`,
    '',
    '',
  ].join('\n');
  fs.writeFileSync(logPath, header, 'utf8');
  let readPosition = Buffer.byteLength(header, 'utf8');

  logger.info('启动游戏:', versionId, 'Java:', javaExe, '参数数量:', args.length);

  let logFd = null;
  let child;
  try {
    // 使用文件描述符而不是管道：既能把游戏输出写入日志，也兼容受限环境。
    logFd = fs.openSync(logPath, 'a');
    child = spawn(javaExe, args, {
      cwd: gameDir,
      env: process.env,
      windowsHide: true,
      // Unix 上建立独立进程组，监控页结束游戏时可以一并结束子进程。
      detached: !platform.isWindows,
      stdio: ['ignore', logFd, logFd],
    });
  } catch (err) {
    const error = new Error(`无法启动 Java：${err.message}`);
    error.code = 'SPAWN_FAILED';
    throw error;
  } finally {
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch (err) { /* ignore */ }
    }
  }

  const decoder = new StringDecoder('utf8');
  const formatter = createLogFormatter(log);
  const flush = () => {
    try {
      const size = fs.statSync(logPath).size;
      if (size <= readPosition) return;
      const length = size - readPosition;
      const fd = fs.openSync(logPath, 'r');
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, readPosition);
      fs.closeSync(fd);
      readPosition = size;
      const text = decoder.write(buffer);
      if (text) formatter.push(text);
    } catch (err) {
      /* 日志读取失败不影响游戏 */
    }
  };
  const timer = setInterval(flush, 250);

  const startedAt = Date.now();
  let finished = false;

  const finish = (info) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    try { flush(); } catch (err) { /* ignore */ }
    const tail = decoder.end();
    if (tail) formatter.push(tail);
    formatter.flush();
    if (onExit) onExit(Object.assign({
      logPath,
      duration: Date.now() - startedAt,
      startedAt,
      gameDir,
      versionId,
      javaPath: javaExe,
      player: profile.name,
      memoryMb,
      memoryMode: autoMemory ? 'auto' : 'manual',
      memoryOptimized: optimizeMemory,
    }, info));
  };

  child.on('error', (err) => {
    try { fs.appendFileSync(logPath, `\n# 进程错误: ${err.message}\n`); } catch (e) { /* ignore */ }
    logger.error('Java 进程错误:', err.message);
    finish({ code: -1, error: err.message });
  });

  child.on('exit', (code, signal) => {
    const duration = Date.now() - startedAt;
    logger.info('游戏退出:', versionId, '代码:', code, '用时:', (duration / 1000).toFixed(1), '秒');
    finish({ code, signal, duration });
  });

  return {
    pid: child.pid,
    startedAt,
    logPath,
    versionId,
    player: profile.name,
    java: javaExe,
    gameDir,
    portable,
    memoryMb,
    memoryMode: autoMemory ? 'auto' : 'manual',
    memoryOptimized: optimizeMemory,
    integrity: integrityResult,
    process: child,
  };
}

function redactCommandLine(args) {
  const secretFlags = new Set(['--accessToken', '--clientId', '--xuid']);
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equal = /^--(accessToken|clientId|xuid)=/i.exec(arg);
    if (equal) {
      result.push(`${arg.slice(0, equal[0].length)}<已隐藏>`);
      continue;
    }
    if (secretFlags.has(arg)) {
      result.push(arg);
      if (index + 1 < args.length) {
        result.push('<已隐藏>');
        index += 1;
      }
      continue;
    }
    result.push(arg);
  }
  return result;
}

function quoteForLog(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

module.exports = {
  launch,
  buildClasspath,
  prepareNatives,
  applyGameLanguage,
  gameLanguageCode,
  effectiveMemoryMb,
  memoryArgs,
};