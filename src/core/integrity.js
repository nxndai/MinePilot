'use strict';

/**
 * 启动前文件完整性校验。
 *
 * 目标是“能启动、能正常显示/播放资源”，因此检查：
 *  - 客户端主文件（加载器版本会检查它继承的原版 jar）
 *  - 所有当前平台会用到的库与 natives
 *  - 日志配置、资源索引
 *  - 资源对象（遵循设置里的“下载资源文件”开关）
 *
 * 校验结果会缓存到 cache/integrity，缓存键包含文件大小和 mtime，
 * 因此第二次启动只做 stat 检查；文件被修改后会重新计算 SHA1。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const net = require('./net');
const mojang = require('./mojang');
const installer = require('./installer');
const logger = require('./logger');
const config = require('./config');

const ASSETS_BASE = 'https://resources.download.minecraft.net';
const CACHE_VERSION = 1;
const HASH_WORKERS = 8;

function safeName(value) {
  return String(value || 'version').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'version';
}

function cacheFile(versionId) {
  const suffix = crypto.createHash('sha1').update(String(versionId)).digest('hex').slice(0, 8);
  return path.join(config.cacheDir(), 'integrity', `${safeName(versionId)}-${suffix}.json`);
}

function readCache(versionId, gameDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(versionId), 'utf8'));
    if (raw && raw.version === CACHE_VERSION && raw.files && typeof raw.files === 'object') {
      if (raw.gameDir && path.resolve(raw.gameDir) === path.resolve(gameDir)) return raw;
    }
  } catch (err) {
    /* 没有缓存或缓存损坏，按首次校验处理 */
  }
  return { version: CACHE_VERSION, files: {} };
}

function saveCache(versionId, cache, gameDir) {
  const target = cacheFile(versionId);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    cache.gameDir = path.resolve(gameDir);
    fs.writeFileSync(temp, JSON.stringify(cache), 'utf8');
    try {
      fs.renameSync(temp, target);
    } catch (err) {
      // Windows 上目标文件被占用时 rename 可能失败，退化为先删除再改名。
      fs.rmSync(target, { force: true });
      fs.renameSync(temp, target);
    }
  } catch (err) {
    logger.warn('保存完整性缓存失败:', err.message);
  }
}

function relativeKey(gameDir, file) {
  return path.relative(gameDir, file).replace(/\\/g, '/');
}

function fileStat(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : null;
  } catch (err) {
    return null;
  }
}

function task(url, target, sha1, size, label, useMirror) {
  if (!url) return null;
  const mirrored = mojang.mirrorUrl(url, useMirror);
  return {
    url: mirrored,
    fallbackUrl: mirrored !== url ? url : null,
    path: target,
    sha1: sha1 ? String(sha1).toLowerCase() : null,
    size: Number(size) || 0,
    label: label || path.basename(target),
  };
}

function assetIndexTask(meta, gameDir, s) {
  const index = meta.assetIndex;
  if (!index || !index.url) return null;
  const id = String(index.id || meta.assets || 'legacy').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return task(
    index.url,
    path.join(gameDir, 'assets', 'indexes', `${id}.json`),
    index.sha1,
    index.size,
    '资源索引',
    s.useMirror,
  );
}

function collectCoreTasks(meta, gameDir, s) {
  const tasks = [];
  for (const item of installer.collectTasks(meta, gameDir, s)) {
    if (item && item.url && item.path) tasks.push(item);
  }
  const indexTask = assetIndexTask(meta, gameDir, s);
  if (indexTask) tasks.push(indexTask);

  const seen = new Set();
  return tasks.filter((item) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}

function readAssetIndex(meta, gameDir) {
  if (!meta.assetIndex || !meta.assetIndex.url) return null;
  const id = String(meta.assetIndex.id || meta.assets || 'legacy').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  const file = path.join(gameDir, 'assets', 'indexes', `${id}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && parsed.objects && typeof parsed.objects === 'object' ? parsed : { objects: {} };
  } catch (err) {
    const error = new Error(`资源索引已损坏，无法读取：${err.message}`);
    error.code = 'INTEGRITY_FAILED';
    throw error;
  }
}

function assetTasks(index, gameDir, s) {
  const tasks = [];
  const seen = new Set();
  for (const [name, object] of Object.entries(index && index.objects ? index.objects : {})) {
    const hash = object && object.hash ? String(object.hash).toLowerCase() : '';
    if (!/^[a-f0-9]{40}$/.test(hash) || seen.has(hash)) continue;
    seen.add(hash);
    const prefix = hash.slice(0, 2);
    const url = `${ASSETS_BASE}/${prefix}/${hash}`;
    tasks.push(task(
      url,
      path.join(gameDir, 'assets', 'objects', prefix, hash),
      hash,
      object.size,
      name,
      s.useMirror,
    ));
  }
  return tasks.filter(Boolean);
}

async function inspectTask(item, gameDir, cache) {
  const file = item.path;
  const stat = fileStat(file);
  if (!stat) return { kind: 'missing', task: item, detail: '文件不存在' };
  if (item.size && stat.size !== item.size) {
    return { kind: 'broken', task: item, detail: `大小不一致（期望 ${item.size}，实际 ${stat.size}）` };
  }

  const key = relativeKey(gameDir, file);
  const cached = cache.files[key];
  const currentKey = { size: stat.size, mtimeMs: stat.mtimeMs };
  if (
    cached
    && cached.size === currentKey.size
    && cached.mtimeMs === currentKey.mtimeMs
    && (!item.sha1 || cached.sha1 === item.sha1)
  ) {
    return null;
  }

  if (item.sha1) {
    try {
      const actual = await net.sha1File(file);
      if (actual !== item.sha1) {
        return { kind: 'broken', task: item, detail: 'SHA1 校验失败' };
      }
      cache.files[key] = { size: stat.size, mtimeMs: stat.mtimeMs, sha1: item.sha1 };
      return null;
    } catch (err) {
      return { kind: 'broken', task: item, detail: `无法读取：${err.message}` };
    }
  }

  // 极少数没有 SHA1 的旧文件只能检查存在性和大小。
  cache.files[key] = { size: stat.size, mtimeMs: stat.mtimeMs, sha1: '' };
  return null;
}

async function inspectItems(items, gameDir, cache, options) {
  const issues = [];
  const total = items.length;
  let done = 0;
  let cursor = 0;
  const workers = Math.max(1, Math.min(HASH_WORKERS, total || 1));

  const emit = () => {
    const percent = total ? Math.round((done / total) * 100) : 100;
    if (options.onProgress) {
      options.onProgress({
        phase: 'check',
        message: `正在校验${options.label || '核心文件'} ${done}/${total}`,
        percent: options.startPercent + ((options.endPercent - options.startPercent) * percent) / 100,
        checked: done,
        total,
      });
    }
  };

  emit();
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      if (options.signal && options.signal.aborted) throw new Error('已取消');
      const issue = await inspectTask(items[index], gameDir, cache);
      if (issue) issues.push(issue);
      done += 1;
      emit();
    }
  }));

  return issues;
}

async function repairIssues(issues, gameDir, cache, options) {
  if (!issues.length) return { repaired: 0, bytes: 0 };
  const items = issues.map((issue) => issue.task);
  const total = items.length;
  let lastPercent = options.startPercent;

  if (options.onProgress) {
    options.onProgress({
      phase: 'repair',
      message: `发现 ${total} 个缺失或损坏文件，正在自动补全…`,
      percent: options.startPercent,
      checked: 0,
      total,
      repaired: 0,
    });
  }

  try {
    await net.downloadMany(items, {
      threads: options.threads,
      signal: options.signal,
      retries: 3,
      onProgress: (progress) => {
        if (!options.onProgress) return;
        const ratio = progress.totalFiles ? progress.doneFiles / progress.totalFiles : 0;
        const percent = options.startPercent + ((options.endPercent - options.startPercent) * ratio);
        lastPercent = Math.max(lastPercent, percent);
        options.onProgress({
          phase: 'repair',
          message: `正在补全文件 ${progress.doneFiles}/${progress.totalFiles}`,
          percent: lastPercent,
          checked: progress.doneFiles,
          total,
          repaired: progress.doneFiles,
          bytesDone: progress.receivedBytes || 0,
          bytesTotal: progress.totalBytes || 0,
        });
      },
    });
  } catch (err) {
    if (options.signal && options.signal.aborted) throw err;
    const failed = (err.failures || []).map((failure) => failure.item).filter(Boolean);
    const sample = failed.length ? `（例如 ${failed[0].label || path.basename(failed[0].path)}）` : '';
    const error = new Error(
      `检测到 ${total} 个缺失或损坏文件，但自动修复失败${sample}：${err.message}。请检查网络后重试。`,
    );
    error.code = 'INTEGRITY_FAILED';
    error.failures = err.failures || [];
    throw error;
  }

  let bytes = 0;
  for (const item of items) {
    const stat = fileStat(item.path);
    if (!stat) continue;
    bytes += stat.size;
    cache.files[relativeKey(gameDir, item.path)] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha1: item.sha1 || '',
    };
  }

  if (options.onProgress) {
    options.onProgress({
      phase: 'repair',
      message: `已补全 ${total} 个文件`,
      percent: options.endPercent,
      checked: total,
      total,
      repaired: total,
    });
  }
  return { repaired: total, bytes };
}

/**
 * 校验并修复一个版本的运行文件。
 * @param {object} meta mojang.loadVersion 返回的合并后版本信息
 * @param {string} gameDir 版本所在 .minecraft 根目录
 * @param {object} options useMirror/downloadAssets/threads/signal/onProgress
 */
async function ensureFiles(meta, gameDir, options = {}) {
  const startedAt = Date.now();
  const s = Object.assign({}, options);
  const cache = readCache(meta.id || meta.jarId || 'version', gameDir);
  const coreTasks = collectCoreTasks(meta, gameDir, s);

  const coreIssues = await inspectItems(coreTasks, gameDir, cache, {
    label: '核心文件',
    startPercent: 2,
    endPercent: 28,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const missing = coreIssues.filter((issue) => issue.kind === 'missing').length;
  const broken = coreIssues.filter((issue) => issue.kind === 'broken').length;
  const allowDownloads = options.allowDownloads !== false;
  const coreRepair = allowDownloads
    ? await repairIssues(coreIssues, gameDir, cache, {
      startPercent: 28,
      endPercent: 58,
      threads: options.threads,
      signal: options.signal,
      onProgress: options.onProgress,
    })
    : { repaired: 0, bytes: 0 };

  let assetIssues = [];
  let assetRepair = { repaired: 0, bytes: 0 };
  let assetTotal = 0;
  let skippedAssets = false;
  const index = readAssetIndex(meta, gameDir);
  if (index) {
    const tasks = assetTasks(index, gameDir, s);
    assetTotal = tasks.length;
    if (options.downloadAssets === false) {
      skippedAssets = true;
    } else if (tasks.length) {
      assetIssues = await inspectItems(tasks, gameDir, cache, {
        label: '资源文件',
        startPercent: 58,
        endPercent: 94,
        signal: options.signal,
        onProgress: options.onProgress,
      });
      if (allowDownloads) {
        assetRepair = await repairIssues(assetIssues, gameDir, cache, {
          startPercent: 94,
          endPercent: 99,
          threads: options.threads,
          signal: options.signal,
          onProgress: options.onProgress,
        });
      }
    }
  }

  saveCache(meta.id || meta.jarId || 'version', cache, gameDir);

  if (!allowDownloads && coreIssues.length + assetIssues.length > 0) {
    const missingCount = coreIssues.filter((issue) => issue.kind === 'missing').length
      + assetIssues.filter((issue) => issue.kind === 'missing').length;
    const brokenCount = coreIssues.filter((issue) => issue.kind === 'broken').length
      + assetIssues.filter((issue) => issue.kind === 'broken').length;
    const error = new Error(
      `本地游戏文件不完整（缺失 ${missingCount}，损坏 ${brokenCount}）。`
      + '“在线下载”已关闭，无法自动补全；请在「设置 → 下载」开启后重试。',
    );
    error.code = 'ONLINE_DOWNLOADS_DISABLED';
    throw error;
  }

  const result = {
    ok: true,
    checked: coreTasks.length + assetTotal,
    missing: missing + assetIssues.filter((issue) => issue.kind === 'missing').length,
    broken: broken + assetIssues.filter((issue) => issue.kind === 'broken').length,
    repaired: coreRepair.repaired + assetRepair.repaired,
    assets: assetTotal,
    skippedAssets,
    bytes: coreRepair.bytes + assetRepair.bytes,
    elapsed: Date.now() - startedAt,
  };

  if (result.repaired > 0) {
    logger.info('启动前完整性修复完成:', meta.id, `修复 ${result.repaired} 个文件，耗时 ${result.elapsed}ms`);
  }
  if (options.onProgress) {
    options.onProgress({
      phase: 'done',
      message: result.repaired
        ? `完整性校验完成，已修复 ${result.repaired} 个文件`
        : `完整性校验通过（${result.checked} 个文件）`,
      percent: 100,
      checked: result.checked,
      total: result.checked,
      repaired: result.repaired,
    });
  }
  return result;
}

module.exports = {
  ensureFiles,
  collectCoreTasks,
  assetIndexTask,
  assetTasks,
  readCache,
  cacheFile,
};