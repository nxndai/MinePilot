'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const net = require('./net');
const mojang = require('./mojang');
const loaders = require('./loaders');
const settings = require('./settings');
const logger = require('./logger');
const config = require('./config');
const javaCore = require('./java');
const versionsCore = require('./versions');
const platform = require('./platform');

const ASSETS_BASE = 'https://resources.download.minecraft.net';

function computeNativesKey(library) {
  return platform.nativesKey(library) || null;
}

function artifactAllowed(name) {
  return platform.artifactAllowed(name);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function buildTask(url, target, sha1, size, label, source) {
  const mirrored = mojang.mirrorUrl(url, source);
  const preferMirror = source === 'bmclapi' && mirrored !== url;
  return {
    // 自动模式官方优先、镜像兜底；BMCLAPI 模式镜像优先，失败后回退官方。
    url: preferMirror ? mirrored : url,
    fallbackUrl: mirrored !== url ? (preferMirror ? url : mirrored) : null,
    path: target,
    sha1: sha1 ? String(sha1).toLowerCase() : null,
    size: size || 0,
    label: label || path.basename(target),
  };
}

function collectTasks(meta, gameDir, s) {
  const tasks = [];
  const seen = new Set();
  const push = (task) => {
    if (!task || !task.url || !task.path) return;
    if (seen.has(task.path)) return;
    seen.add(task.path);
    tasks.push(task);
  };

  const features = Object.assign({}, mojang.DEFAULT_FEATURES);
  const libsDir = path.join(gameDir, 'libraries');

  // 加载器版本的 client.jar 属于它继承的原版版本（meta.jarId），
  // 不能因为 meta.id 是加载器版本就漏掉主文件校验/补全。
  if (meta.downloads.client) {
    push(buildTask(
      meta.downloads.client.url,
      path.join(gameDir, 'versions', meta.jarId, `${meta.jarId}.jar`),
      meta.downloads.client.sha1,
      meta.downloads.client.size,
      '客户端主文件',
      s.downloadSource || s.useMirror,
    ));
  }

  for (const lib of meta.libraries) {
    if (lib.artifact && mojang.rulesAllow(lib.rules, features) && artifactAllowed(lib.name)) {
      push(buildTask(
        lib.artifact.url,
        path.join(libsDir, lib.artifact.path),
        lib.artifact.sha1,
        lib.artifact.size,
        lib.name,
        s.downloadSource || s.useMirror,
      ));
    }
    const nativesKey = computeNativesKey(lib);
    if (nativesKey && lib.classifiers && lib.classifiers[nativesKey]) {
      const classifier = lib.classifiers[nativesKey];
      push(buildTask(
        classifier.url,
        path.join(libsDir, classifier.path),
        classifier.sha1,
        classifier.size,
        lib.name,
        s.downloadSource || s.useMirror,
      ));
    }
  }

  if (meta.logging && meta.logging.file && meta.logging.file.url) {
    const logTask = buildTask(
      meta.logging.file.url,
      path.join(gameDir, 'assets', 'log_configs', meta.logging.file.id || 'client.xml'),
      meta.logging.file.sha1,
      meta.logging.file.size,
      '日志配置',
      s.downloadSource || s.useMirror,
    );
    // 日志配置只影响日志格式；缺失时游戏仍可启动，不能因此阻断启动。
    if (logTask) logTask.optional = true;
    push(logTask);
  }

  return tasks;
}

function progressMapper(emit, start, end, phase) {
  return (p) => {
    if (!p) return;
    const ratio = p.totalBytes
      ? Math.min(1, p.receivedBytes / p.totalBytes)
      : (p.totalFiles ? p.doneFiles / p.totalFiles : 0);
    emit({
      phase,
      percent: start + (end - start) * ratio,
      doneFiles: p.doneFiles,
      totalFiles: p.totalFiles,
      bytesDone: p.receivedBytes,
      bytesTotal: p.totalBytes,
    });
  };
}

async function downloadTasks(tasks, options) {
  try {
    await net.downloadMany(tasks, options);
  } catch (err) {
    if ((options.signal && options.signal.aborted) || err.code === 'ABORTED') throw err;
    const failed = (err.failures || []).map((failure) => failure.item).filter(Boolean);
    if (!failed.length || failed.length > 200) throw err;
    logger.warn('部分文件下载失败，正在重试:', failed.length);
    // 重试阶段不重复上报百分比，避免进度条来回跳动。
    await net.downloadMany(failed, Object.assign({}, options, { onProgress: null }));
  }
}

async function downloadAndFinish(versionId, gameDir, options = {}, startedAt = Date.now()) {
  const { onProgress = null, signal = null } = options;
  const s = settings.get();
  const emit = (payload) => { if (onProgress) onProgress(payload); };

  const meta = await mojang.loadVersion(gameDir, versionId);
  if (!meta.mainClass) throw new Error('版本信息缺少启动类，无法安装');
  if (!meta.assetIndex && meta.assets && meta.assets !== 'legacy') {
    logger.warn('版本缺少资源索引信息:', versionId);
  }

  const tasks = collectTasks(meta, gameDir, s);
  const totalBytes = tasks.reduce((sum, task) => sum + (task.size || 0), 0);
  emit({
    phase: '准备下载游戏文件',
    percent: 5,
    doneFiles: 0,
    totalFiles: tasks.length,
    bytesDone: 0,
    bytesTotal: totalBytes,
  });

  await downloadTasks(tasks, {
    threads: s.downloadThreads,
    signal,
    onProgress: progressMapper(emit, 6, 40, '下载游戏文件'),
  });

  if (meta.assetIndex && meta.assetIndex.url) {
    const indexId = meta.assetIndex.id || meta.assets || 'legacy';
    const indexPath = path.join(gameDir, 'assets', 'indexes', `${indexId}.json`);
    emit({ phase: '下载资源索引', percent: 41 });
    await net.downloadFile(meta.assetIndex.url, indexPath, { sha1: meta.assetIndex.sha1, signal });

    if (s.downloadAssets) {
      const index = mojang.readJson(indexPath);
      const objects = index.objects || {};
      const names = Object.keys(objects);
      const objectTasks = [];
      const objectSeen = new Set();
      for (const name of names) {
        const object = objects[name];
        if (!object || !object.hash || objectSeen.has(object.hash)) continue;
        objectSeen.add(object.hash);
        const prefix = object.hash.slice(0, 2);
        const official = `${ASSETS_BASE}/${prefix}/${object.hash}`;
        const source = s.downloadSource || (s.useMirror ? 'auto' : 'official');
        const mirrored = mojang.mirrorUrl(official, source);
        const preferMirror = source === 'bmclapi' && mirrored !== official;
        objectTasks.push({
          // BMCLAPI 模式下资源也优先走镜像；自动模式保持官方优先、镜像兜底。
          url: preferMirror ? mirrored : official,
          fallbackUrl: mirrored !== official ? (preferMirror ? official : mirrored) : null,
          path: path.join(gameDir, 'assets', 'objects', prefix, object.hash),
          sha1: object.hash,
          size: object.size || 0,
          label: name,
        });
      }

      emit({
        phase: '下载资源文件',
        percent: 42,
        doneFiles: 0,
        totalFiles: objectTasks.length,
        bytesDone: 0,
        bytesTotal: objectTasks.reduce((sum, task) => sum + (task.size || 0), 0),
      });

      await downloadTasks(objectTasks, {
        threads: s.downloadThreads,
        signal,
        onProgress: progressMapper(emit, 43, 97, '下载资源文件'),
      });

      copyLegacyAssets(gameDir, index, indexId, objects, emit);
    }
  }

  const versionDir = path.join(gameDir, 'versions', versionId);
  ensureDir(versionDir);
  fs.writeFileSync(path.join(versionDir, '.minepilot.json'), JSON.stringify({
    versionId,
    installedAt: Date.now(),
    newLauncher: true,
  }, null, 2), 'utf8');

  emit({ phase: '安装完成', percent: 100, doneFiles: tasks.length, totalFiles: tasks.length });
  logger.info('版本安装完成:', versionId, '耗时', ((Date.now() - startedAt) / 1000).toFixed(1), '秒');
  return { versionId, elapsed: Date.now() - startedAt, totalBytes };
}

async function installVanilla(versionId, options = {}) {
  const { onProgress = null, signal = null } = options;
  const s = settings.get();
  const gameDir = s.gameDir;
  const emit = (payload) => { if (onProgress) onProgress(payload); };
  const startedAt = Date.now();

  emit({ phase: '获取版本列表', percent: 1 });
  const source = settings.get().downloadSource || 'auto';
  const manifest = await mojang.getManifest(false, source);
  const entry = manifest.versions.find((item) => item.id === versionId);
  if (!entry) throw new Error(`版本 ${versionId} 不在官方版本列表中`);

  emit({ phase: '获取版本信息', percent: 3 });
  const raw = await mojang.fetchVersionJson(entry, source);
  raw.id = versionId;

  const versionsDir = path.join(gameDir, 'versions');
  const versionDir = path.join(versionsDir, versionId);
  ensureDir(versionDir);
  fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(raw, null, 2), 'utf8');

  if (raw.inheritsFrom) {
    const parentJson = mojang.findVersionJson(gameDir, raw.inheritsFrom);
    if (!parentJson) {
      emit({ phase: `安装前置版本 ${raw.inheritsFrom}`, percent: 3 });
      await installVanilla(raw.inheritsFrom, {
        signal,
        onProgress: (p) => emit(Object.assign({}, p, { phase: `前置版本 ${raw.inheritsFrom}：${p.phase}` })),
      });
    }
  }

  return downloadAndFinish(versionId, gameDir, { onProgress, signal }, startedAt);
}

function mapProgress(emit, from, to, prefix) {
  return (payload) => {
    if (!payload) return;
    emit(Object.assign({}, payload, {
      percent: from + ((Number(payload.percent) || 0) / 100) * (to - from),
      phase: prefix ? `${prefix}${payload.phase}` : payload.phase,
    }));
  };
}

async function ensureVanilla(mcVersion, options, from, to) {
  const gameDir = settings.get().gameDir;
  const existing = mojang.findVersionJson(gameDir, mcVersion);
  const jar = path.join(gameDir, 'versions', mcVersion, `${mcVersion}.jar`);
  if (existing && fs.existsSync(jar)) return;
  await installVanilla(mcVersion, {
    signal: options.signal,
    onProgress: mapProgress(options.onProgress, from, to, '前置原版：'),
  });
}

function ensureLauncherProfiles(gameDir) {
  const profileCandidates = [
    path.join(gameDir, 'launcher_profiles.json'),
    path.join(gameDir, 'launcher_profiles_microsoft_store.json'),
  ];
  if (profileCandidates.some((file) => fs.existsSync(file))) return;
  ensureDir(gameDir);
  fs.writeFileSync(
    profileCandidates[0],
    JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2),
    'utf8',
  );
}

async function pickJavaFor(mcVersion, label) {
  const required = javaCore.requiredJava(mcVersion);
  const picked = await javaCore.pickFor(required, settings.get().javaPath);
  if (!picked.java) {
    const error = new Error(`安装 ${label} 需要 Java ${required}，请先在设置中安装 Java`);
    error.code = 'NO_JAVA';
    throw error;
  }
  if (!picked.compatible) {
    const error = new Error(`当前 Java ${picked.java.major} 低于 ${label} 要求的 Java ${required}`);
    error.code = 'NO_JAVA';
    throw error;
  }
  return picked.java;
}

function assertJar(file, label) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(4);
    const read = fs.readSync(fd, header, 0, 4, 0);
    if (read < 4 || header[0] !== 0x50 || header[1] !== 0x4b) {
      throw new Error(`${label} 安装器下载内容无效，请检查网络后重试`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Fabric 和 Quilt 都提供可直接写入 versions/ 的 profile JSON，
 * 不需要运行外部安装器，也不需要用户手动放文件。
 */
async function installProfile(mcVersion, loaderVersion, options, config) {
  const s = settings.get();
  const gameDir = s.gameDir;
  const emit = (payload) => { if (options.onProgress) options.onProgress(payload); };
  const startedAt = Date.now();
  const label = config.label;

  emit({ phase: `准备 ${label} 安装`, percent: 1 });
  await ensureVanilla(mcVersion, options, 2, 25);

  emit({ phase: `获取 ${label} 配置`, percent: 26 });
  const profile = await config.fetchProfile(mcVersion, loaderVersion);
  const versionId = String(profile.id || `${config.type}-loader-${loaderVersion}-${mcVersion}`);
  profile.id = versionId;
  profile.inheritsFrom = profile.inheritsFrom || mcVersion;

  const versionDir = path.join(gameDir, 'versions', versionId);
  ensureDir(versionDir);
  fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(profile, null, 2), 'utf8');

  emit({ phase: `下载 ${label} 库文件`, percent: 28 });
  const result = await downloadAndFinish(versionId, gameDir, {
    signal: options.signal,
    onProgress: mapProgress(emit, 30, 100, ''),
  }, startedAt);
  logger.info(`${label} 安装完成:`, versionId);
  return Object.assign({}, result, { loader: config.type });
}

async function installFabric(mcVersion, loaderVersion, options = {}) {
  return installProfile(mcVersion, loaderVersion, options, {
    type: 'fabric',
    label: 'Fabric',
    fetchProfile: loaders.fabricProfile,
  });
}

async function installQuilt(mcVersion, loaderVersion, options = {}) {
  return installProfile(mcVersion, loaderVersion, options, {
    type: 'quilt',
    label: 'Quilt',
    fetchProfile: loaders.quiltProfile,
  });
}

function javaConsolePath(file) {
  if (!file) return file;
  if (/javaw\.exe$/i.test(file)) {
    const consoleExe = file.replace(/javaw\.exe$/i, 'java.exe');
    if (fs.existsSync(consoleExe)) return consoleExe;
  }
  return file;
}

function readLogTail(file, maxBytes = 20000) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch (err) {
    return '';
  }
}

function runInstaller(javaPath, jarPath, gameDir, options = {}) {
  const { logPath, onProgress = null, signal = null, label = 'Forge' } = options;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      const error = new Error('已取消安装');
      error.code = 'ABORTED';
      reject(error);
      return;
    }
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, 'a');
    let finished = false;
    let progressTimer = null;
    const args = options.args || ['-jar', jarPath, '--installClient', gameDir];
    const child = spawn(javaPath, args, {
      cwd: gameDir,
      windowsHide: true,
      // 直接写入日志文件，避免 Electron / 受限终端下管道子进程被系统拦截。
      stdio: ['ignore', logFd, logFd],
    });

    const cleanup = () => {
      if (progressTimer) clearInterval(progressTimer);
      progressTimer = null;
      try { fs.closeSync(logFd); } catch (err) { /* ignore */ }
    };
    const fail = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (signal) signal.removeEventListener('abort', abortHandler);
      reject(error);
    };
    const abortHandler = () => {
      try { child.kill(); } catch (err) { /* ignore */ }
      const error = new Error('已取消安装');
      error.code = 'ABORTED';
      fail(error);
    };
    if (signal) signal.addEventListener('abort', abortHandler, { once: true });

    if (onProgress) {
      progressTimer = setInterval(() => {
        onProgress({ phase: `运行 ${label} 安装器`, percent: 45 });
      }, 900);
    }

    child.on('error', (err) => {
      fail(Object.assign(new Error(`无法运行 ${label} 安装器：${err.message}`), { code: 'INSTALLER_SPAWN' }));
    });
    child.on('exit', (code) => {
      if (finished) return;
      if (signal && signal.aborted) {
        abortHandler();
        return;
      }
      finished = true;
      cleanup();
      if (signal) signal.removeEventListener('abort', abortHandler);
      if (code !== 0) {
        const tail = readLogTail(logPath).trim().split(/\r?\n/).slice(-8).join('\n');
        const error = new Error(`${label} 安装器退出（代码 ${code}）${tail ? `：${tail}` : ''}`);
        error.code = 'INSTALLER_FAILED';
        reject(error);
        return;
      }
      resolve({ output: readLogTail(logPath) });
    });
  });
}

function listVersionIds(gameDir) {
  const dir = path.join(gameDir, 'versions');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    return [];
  }
}

function rawLoaderKeys(raw, id) {
  const libraries = Array.isArray(raw.libraries) ? raw.libraries : [];
  const text = [
    String(id || ''),
    String(raw.mainClass || ''),
    ...libraries.map((lib) => String(lib.name || '')),
  ].join('\n');

  // NeoForge 1.20.1 的 Maven 坐标是 net.neoforged:forge，
  // 不能把它误判成普通 Forge。
  if (/neoforged|neoforge/i.test(text)) return ['neoforge'];
  if (/minecraftforge/i.test(text)) return ['forge'];
  const keys = versionsCore.detectLoaders([raw]).map((loader) => loader.key);
  if (keys.includes('neoforge')) return ['neoforge'];
  if (keys.includes('forge')) return ['forge'];
  return keys;
}

function versionIdMc(raw, id) {
  if (raw && raw.inheritsFrom) return String(raw.inheritsFrom).trim();
  const match = String(id || '').match(/^(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : '';
}

/**
 * Forge / NeoForge 安装器生成的新版本名并不完全统一，例如：
 *   1.20.1-forge-47.4.16
 *   neoforge-21.1.80
 * 因此安装完成后扫描 versions/，按加载器类型、Minecraft 版本和修改时间识别。
 */
function findInstalledLoaderVersion(gameDir, options) {
  const { key, mcVersion, loaderVersion, before = new Set(), startedAt = 0 } = options;
  const candidates = [];

  for (const id of listVersionIds(gameDir)) {
    let raw;
    try {
      const jsonFile = mojang.findVersionJson(gameDir, id);
      if (!jsonFile) continue;
      raw = mojang.readJson(jsonFile);
    } catch (err) {
      continue;
    }
    if (!rawLoaderKeys(raw, id).includes(key)) continue;

    const actualMc = versionIdMc(raw, id);
    if (actualMc && mcVersion && actualMc !== mcVersion) continue;

    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(gameDir, 'versions', id)).mtimeMs;
    } catch (err) { /* ignore */ }

    let score = 0;
    if (loaderVersion && id.includes(loaderVersion)) score += 1000;
    if (!before.has(id)) score += 100;
    if (mtime >= startedAt - 5000) score += 50;
    if (key === 'neoforge' && /neoforge/i.test(id)) score += 10;
    if (key === 'forge' && /forge/i.test(id)) score += 5;
    candidates.push({ id, score, mtime });
  }

  candidates.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return candidates.length ? candidates[0].id : '';
}

async function installWithInstaller(mcVersion, loaderVersion, options, installerConfig) {
  const s = settings.get();
  const gameDir = s.gameDir;
  const emit = (payload) => { if (options.onProgress) options.onProgress(payload); };
  const label = installerConfig.label;

  emit({ phase: `准备 ${label} 安装`, percent: 1 });
  ensureLauncherProfiles(gameDir);
  const java = await pickJavaFor(mcVersion, label);
  await ensureVanilla(mcVersion, options, 2, 25);

  const urls = installerConfig.getUrls(mcVersion, loaderVersion);
  const installerPath = path.join(config.cacheDir(), `${installerConfig.key}-${urls.full}-installer.jar`);
  emit({ phase: `下载 ${label} 安装器`, percent: 27 });
  const preferMirror = settings.get().downloadSource === 'bmclapi';
  await net.downloadFile(preferMirror ? urls.mirror : urls.official, installerPath, {
    fallbackUrl: preferMirror ? urls.official : urls.mirror,
    signal: options.signal,
    timeout: 120000,
  });
  assertJar(installerPath, label);

  const startedAt = Date.now();
  const before = new Set(listVersionIds(gameDir));
  emit({ phase: `运行 ${label} 安装器`, percent: 30 });
  const logPath = path.join(config.logsDir(), `${installerConfig.key}-install-${urls.full}-${startedAt}.log`);
  const javaExe = javaConsolePath(java.path);
  const runOptions = {
    label,
    signal: options.signal,
    logPath,
    onProgress: (progress) => emit(progress),
  };
  let runResult;
  try {
    // 多数 Forge / NeoForge 安装器支持 --installClient <游戏目录>；
    // 少数旧版只接受不带路径的 --installClient，并以当前工作目录为准。
    runResult = await runInstaller(javaExe, installerPath, gameDir, Object.assign({}, runOptions, {
      args: ['-jar', installerPath, '--installClient', gameDir],
    }));
  } catch (err) {
    if ((options.signal && options.signal.aborted) || !/unknown|unrecognized|unexpected|invalid.*arg|too many|does not take|requires an argument/i.test(err.message)) {
      throw err;
    }
    logger.warn(`${label} 安装器不接受目录参数，改用当前目录重试:`, err.message);
    runResult = await runInstaller(javaExe, installerPath, gameDir, Object.assign({}, runOptions, {
      args: ['-jar', installerPath, '--installClient'],
    }));
  }

  const versionId = findInstalledLoaderVersion(gameDir, {
    key: installerConfig.key,
    mcVersion,
    loaderVersion,
    before,
    startedAt,
  });
  if (!versionId) {
    throw new Error(`${label} 安装器没有生成版本配置，请查看安装日志：${logPath}`);
  }

  emit({ phase: `校验 ${label} 文件`, percent: 70 });
  const result = await downloadAndFinish(versionId, gameDir, {
    signal: options.signal,
    onProgress: mapProgress(emit, 72, 100, ''),
  }, startedAt);
  logger.info(`${label} 安装完成:`, versionId);
  return Object.assign({}, result, { loader: installerConfig.key });
}

async function installForge(mcVersion, loaderVersion, options = {}) {
  return installWithInstaller(mcVersion, loaderVersion, options, {
    key: 'forge',
    label: 'Forge',
    getUrls: loaders.forgeInstallerUrls,
  });
}

async function installNeoForge(mcVersion, loaderVersion, options = {}) {
  return installWithInstaller(mcVersion, loaderVersion, options, {
    key: 'neoforge',
    label: 'NeoForge',
    getUrls: loaders.neoForgeInstallerUrls,
  });
}

async function installVersion(versionId, options = {}) {
  if (options.loader === 'fabric') {
    return installFabric(versionId, options.loaderVersion, options);
  }
  if (options.loader === 'quilt') {
    return installQuilt(versionId, options.loaderVersion, options);
  }
  if (options.loader === 'forge') {
    return installForge(versionId, options.loaderVersion, options);
  }
  if (options.loader === 'neoforge') {
    return installNeoForge(versionId, options.loaderVersion, options);
  }
  return installVanilla(versionId, options);
}

function copyLegacyAssets(gameDir, index, indexId, objects, emit) {
  try {
    if (!index.virtual && !index.map_to_resources) return;
    emit({ phase: '整理旧版资源文件', percent: 97 });
    const targetRoot = index.virtual
      ? path.join(gameDir, 'assets', 'virtual', indexId)
      : path.join(gameDir, 'resources');
    for (const name of Object.keys(objects)) {
      const object = objects[name];
      if (!object || !object.hash) continue;
      const source = path.join(gameDir, 'assets', 'objects', object.hash.slice(0, 2), object.hash);
      const target = path.join(targetRoot, name);
      if (!fs.existsSync(source)) continue;
      ensureDir(path.dirname(target));
      fs.copyFileSync(source, target);
    }
  } catch (err) {
    logger.warn('整理旧版资源失败:', err.message);
  }
}

module.exports = { installVersion, collectTasks, findInstalledLoaderVersion, ASSETS_BASE };