'use strict';

/**
 * 启动器自身更新。
 *
 * 默认更新源是本仓库的 GitHub Releases（无需配置即可检查更新）；
 * 用户可以在「设置 → 启动器更新」里换成自己的 manifest / 仓库地址，
 * 环境变量 MINEPILOT_UPDATE_URL 也可以覆盖默认值。
 *
 * manifest 格式（HTTPS）：
 * {
 *   "version": "1.7.0",
 *   "notes": "更新说明",
 *   "publishedAt": "2026-10-30T12:00:00Z",
 *   "assets": [
 *     { "name": "MinePilot-Setup.exe", "url": "https://...", "platform": "win32",
 *       "arch": "x64", "sha256": "…", "size": 123456 }
 *   ]
 * }
 * 也接受 GitHub Releases API 的 /releases/latest 响应。
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const settings = require('./settings');
const net = require('./net');
const logger = require('./logger');
const platform = require('./platform');

const MAX_DOWNLOAD_BYTES = 800 * 1024 * 1024;
// 内置默认更新源：本仓库的 Releases。用户没有配置时直接用它，开箱即可检查更新。
const OFFICIAL_REPO = 'https://github.com/nxndai/MinePilot';
const OFFICIAL_RELEASES = `${OFFICIAL_REPO}/releases/latest`;
// GitHub 发布资源在部分网络下拿不到数据时的备用下载节点。
// 注意：镜像只改传输路径，下载完成仍会用 Release 提供的 SHA256 校验。
const UPDATE_MIRRORS = ['https://ghfast.top/', 'https://ghproxy.net/'];
let context = {
  currentVersion: '0.0.0',
  downloadsDir: null,
  onProgress: null,
};
let active = null;
let release = null;
let lastError = '';
let lastCheck = 0;
let checking = false;
let downloaded = null;

function configure(options = {}) {
  context = Object.assign({}, context, options);
  if (!context.downloadsDir) {
    try { context.downloadsDir = path.join(config.root(), 'updates'); } catch (err) { context.downloadsDir = null; }
  }
}

/** 用户显式配置的更新源（设置或环境变量）；为空表示使用内置官方源。 */
function customFeed() {
  const configured = String(settings.get().updateFeedUrl || '').trim();
  return configured || String(process.env.MINEPILOT_UPDATE_URL || '').trim();
}

function feedUrl() {
  return customFeed() || OFFICIAL_REPO;
}

function releasesUrl() {
  return release && release.url ? release.url : OFFICIAL_RELEASES;
}

/**
 * 给出该资源可以尝试的下载地址：原始 URL + 镜像。
 * 只对 GitHub Releases 的资源做镜像，自定义 manifest 的地址原样使用。
 */
function updateSources(url) {
  const list = [url];
  try {
    const parsed = new URL(url);
    if (/^github\.com$/i.test(parsed.hostname) && /\/releases\/download\//.test(parsed.pathname)) {
      const custom = String(process.env.MINEPILOT_UPDATE_MIRROR || '').trim();
      const mirrors = custom ? [custom] : UPDATE_MIRRORS;
      for (const mirror of mirrors) {
        const base = String(mirror || '').trim().replace(/\/+$/, '');
        if (!isSafeUrl(base) || base === url) continue;
        list.push(`${base}/${url}`);
      }
    }
  } catch (err) { /* URL 不合法就只用原地址 */ }
  return list;
}

function isSafeFeed(raw) {
  return isSafeUrl(raw);
}

function isSafeUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]');
  } catch (err) {
    return false;
  }
}

function resolveFeed(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';
  // 允许直接粘贴 GitHub 仓库或 releases 页面，自动转成 API 地址。
  const github = /^https:\/\/github\.com\/([^/]+)\/([^/?#]+)(?:\/releases.*)?\/?$/i.exec(input);
  if (github) return `https://api.github.com/repos/${github[1]}/${github[2]}/releases/latest`;
  return input;
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').split('+')[0];
}

function compareVersions(a, b) {
  const left = normalizeVersion(a).split('-');
  const right = normalizeVersion(b).split('-');
  const leftParts = left[0].split('.').map((part) => parseInt(part, 10) || 0);
  const rightParts = right[0].split('.').map((part) => parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const l = leftParts[index] || 0;
    const r = rightParts[index] || 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  const leftPre = left[1] || '';
  const rightPre = right[1] || '';
  if (leftPre && !rightPre) return -1;
  if (!leftPre && rightPre) return 1;
  return leftPre.localeCompare(rightPre);
}

function versionFromTag(tag) {
  return normalizeVersion(tag);
}

function assetMatches(asset, targetPlatform, targetArch) {
  const name = String(asset.name || '').toLowerCase();
  if (/source\s*code|源码/.test(name)) return false;
  const assetPlatform = String(asset.platform || '').toLowerCase();
  if (assetPlatform) {
    const aliases = assetPlatform === 'windows' ? 'win32' : assetPlatform === 'macos' || assetPlatform === 'osx' ? 'darwin' : assetPlatform;
    if (aliases !== targetPlatform) return false;
  } else {
    if (targetPlatform === 'win32' && !/(win|windows|setup|installer)/.test(name) && !/\.exe$/.test(name)) return false;
    if (targetPlatform === 'darwin' && !/(mac|darwin|osx|\.dmg$)/.test(name)) return false;
    if (targetPlatform === 'linux' && !/(linux|appimage|\.deb$|\.tar\.gz$)/.test(name)) return false;
  }
  const assetArch = String(asset.arch || '').toLowerCase();
  if (assetArch) {
    if (assetArch !== targetArch) return false;
  } else if (targetPlatform === 'win32' && targetArch === 'arm64' && !/arm64|aarch64/.test(name)) {
    return false;
  } else if (targetPlatform === 'darwin' && targetArch === 'arm64' && !/arm64|aarch64/.test(name)) {
    return false;
  } else if (targetPlatform === 'linux' && targetArch === 'arm64' && !/arm64|aarch64/.test(name)) {
    return false;
  }
  return true;
}

function pickAsset(assets) {
  const currentPlatform = process.platform;
  const currentArch = process.arch;
  const list = (Array.isArray(assets) ? assets : []).filter((asset) => asset && asset.url);
  return list.find((asset) => assetMatches(asset, currentPlatform, currentArch)) || null;
}

function normalizeRelease(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('更新源返回的内容不是有效 JSON');
  if (raw.tag_name) {
    const version = versionFromTag(raw.tag_name || raw.name || '');
    if (!version) throw new Error('GitHub Release 缺少版本号');
    const assets = (raw.assets || []).map((asset) => {
      let sha256 = '';
      if (asset.digest && /^sha256:/i.test(asset.digest)) sha256 = asset.digest.slice(7);
      return {
        name: asset.name || path.basename(String(asset.browser_download_url || '')),
        url: isSafeUrl(asset.browser_download_url || asset.url || '') ? (asset.browser_download_url || asset.url) : '',
        // 让 pickAsset 根据文件名判断平台，避免把第一个资源误当成当前平台安装包。
        platform: '',
        arch: '',
        sha256,
        size: Number(asset.size) || 0,
      };
    });
    const chosen = pickAsset(assets);
    return {
      version,
      notes: String(raw.body || ''),
      publishedAt: raw.published_at || '',
      url: raw.html_url || '',
      asset: chosen,
      assets,
      source: 'github',
    };
  }

  const version = normalizeVersion(raw.version || raw.latest || raw.tag || '');
  if (!version) throw new Error('更新源缺少 version 字段');
  const assets = (Array.isArray(raw.assets) ? raw.assets : []).map((asset) => ({
    name: asset.name || path.basename(String(asset.url || '')),
    url: isSafeUrl(asset.url || asset.downloadUrl || '') ? (asset.url || asset.downloadUrl) : '',
    platform: asset.platform && asset.platform !== 'any' ? asset.platform : '',
    arch: asset.arch || '',
    sha256: String(asset.sha256 || '').toLowerCase(),
    size: Number(asset.size) || 0,
  }));
  const chosen = pickAsset(assets);
  return {
    version,
    notes: String(raw.notes || raw.changelog || ''),
    publishedAt: raw.publishedAt || raw.pub_date || '',
    url: raw.url || '',
    asset: chosen,
    assets,
    source: 'manifest',
  };
}

function snapshot() {
  const feed = feedUrl();
  const custom = Boolean(customFeed());
  return {
    ok: !lastError,
    configured: true,
    custom,
    source: custom ? 'custom' : 'official',
    status: lastError ? 'error' : release ? (downloaded ? 'downloaded' : 'available') : 'idle',
    currentVersion: normalizeVersion(context.currentVersion),
    feedHost: safeHost(feed),
    releaseUrl: releasesUrl(),
    latestVersion: release ? release.version : '',
    available: Boolean(release && compareVersions(release.version, context.currentVersion) > 0),
    notes: release ? release.notes : '',
    publishedAt: release ? release.publishedAt : '',
    asset: release && release.asset ? {
      name: release.asset.name,
      size: release.asset.size,
      sha256: Boolean(release.asset.sha256),
      platform: release.asset.platform,
      arch: release.asset.arch,
    } : null,
    filePath: downloaded ? downloaded.path : '',
    downloadedBytes: downloaded ? downloaded.size : 0,
    checkedAt: lastCheck,
    error: lastError,
    message: lastError || (release
      ? (compareVersions(release.version, context.currentVersion) > 0 ? `发现新版本 ${release.version}` : '当前已是最新版本')
      : '尚未检查更新'),
  };
}

function safeHost(raw) {
  try { return new URL(raw).host; } catch (err) { return ''; }
}

function emitProgress(payload) {
  if (typeof context.onProgress === 'function') {
    try { context.onProgress(payload); } catch (err) { /* ignore */ }
  }
}

async function check() {
  if (checking) return snapshot();
  checking = true;
  lastError = '';
  const rawFeed = feedUrl();
  if (!rawFeed) {
    release = null;
    downloaded = null;
    checking = false;
    return snapshot();
  }
  const feed = resolveFeed(rawFeed);
  if (!isSafeFeed(feed)) {
    lastError = '更新源必须使用 HTTPS（本地调试地址 127.0.0.1 / localhost 除外）';
    checking = false;
    return snapshot();
  }
  try {
    logger.info('检查启动器更新:', safeHost(feed));
    const raw = await net.fetchJson(feed, {
      timeout: 20000,
      retries: 2,
      headers: feed.includes('api.github.com') ? { Accept: 'application/vnd.github+json' } : {},
    });
    const next = normalizeRelease(raw);
    release = next;
    downloaded = null;
    lastCheck = Date.now();
    if (next.asset) {
      logger.info('发现更新:', next.version, next.asset.name);
    } else {
      logger.info('更新版本存在，但当前平台没有匹配的安装包');
    }
  } catch (err) {
    lastError = err.message || String(err);
    release = null;
    downloaded = null;
    logger.warn('检查更新失败:', lastError);
  } finally {
    checking = false;
  }
  return snapshot();
}

function fileForAsset(asset, version) {
  if (!context.downloadsDir) throw new Error('下载目录尚未初始化');
  fs.mkdirSync(context.downloadsDir, { recursive: true });
  const safeName = String(asset.name || `MinePilot-${version}`).replace(/[^a-z0-9._-]/gi, '_').slice(0, 120);
  return path.join(context.downloadsDir, `MinePilot-${version}-${safeName}`);
}

async function download() {
  if (!release) {
    const state = await check();
    if (!state.available) throw new Error(state.message || '没有可下载的更新');
  }
  if (!release.asset) throw new Error(`版本 ${release.version} 没有适用于当前平台的安装包`);
  if (compareVersions(release.version, context.currentVersion) <= 0) throw new Error('当前版本已经不低于更新源中的版本，不需要更新');
  if (active) throw new Error('已有更新正在下载');
  const asset = release.asset;
  if (asset.size && asset.size > MAX_DOWNLOAD_BYTES) throw new Error('安装包体积异常，已拒绝下载');
  const destination = fileForAsset(asset, release.version);
  const controller = new AbortController();
  let received = 0;
  let tooLarge = false;
  active = { controller, destination, version: release.version };
  try {
    emitProgress({ phase: '准备下载更新', percent: 0, receivedBytes: 0, totalBytes: asset.size || 0 });
    // GitHub 的发布资源会 302 到 release-assets.githubusercontent.com，
    // 这个域名在部分网络下连得上却收不到任何数据。失败时自动换镜像重试，
    // 下载完仍然强制校验 SHA256，镜像篡改会被发现。
    const candidates = updateSources(asset.url);
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        if (index > 0) {
          const host = safeHost(candidate);
          emitProgress({
            phase: `改用镜像下载（${host}）`,
            percent: 1,
            receivedBytes: 0,
            totalBytes: asset.size || 0,
          });
          logger.info('更新下载换源:', host);
        }
        const partFile = `${destination}.part`;
        try {
          received = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
        } catch (err) {
          received = 0;
        }
        await net.downloadFile(candidate, destination, {
          signal: controller.signal,
          // 主地址在部分网络下会一直不给数据，少等一会儿就切镜像；
          // 镜像可能有抖动，给更多重试（配合断点续传不会从头再来）。
          retries: index === 0 ? 1 : 3,
          idleTimeout: index === 0 ? 20000 : 30000,
          resume: true,
          onBytes: (count) => {
            received += count;
            if (received > MAX_DOWNLOAD_BYTES) {
              tooLarge = true;
              controller.abort();
              return;
            }
            const total = asset.size || 0;
            emitProgress({
              phase: `下载 MinePilot ${release.version}`,
              percent: total ? Math.min(99, Math.floor((received / total) * 100)) : 35,
              receivedBytes: received,
              totalBytes: total,
            });
          },
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (tooLarge || controller.signal.aborted) throw err;
        logger.warn(`更新下载失败（${safeHost(candidate)}）:`, err.message);
      }
    }
    if (lastError) throw lastError;
    const stat = fs.statSync(destination);
    if (stat.size <= 0) throw new Error('下载完成的安装包为空');
    if (stat.size > MAX_DOWNLOAD_BYTES) throw new Error('安装包体积异常，已拒绝使用');
    let checksum = '';
    if (asset.sha256) {
      emitProgress({ phase: '校验安装包', percent: 99, receivedBytes: stat.size, totalBytes: stat.size });
      checksum = await net.sha256File(destination);
      if (checksum.toLowerCase() !== String(asset.sha256).toLowerCase()) {
        fs.rmSync(destination, { force: true });
        throw new Error('安装包 SHA256 校验失败，文件可能损坏或被篡改');
      }
    }
    downloaded = { path: destination, size: stat.size, sha256: checksum, version: release.version };
    emitProgress({ phase: '更新已下载', percent: 100, receivedBytes: stat.size, totalBytes: stat.size });
    logger.info('更新下载完成:', destination, stat.size);
    return {
      ok: true,
      path: destination,
      size: stat.size,
      sha256: checksum,
      verified: Boolean(asset.sha256),
      version: release.version,
      warning: asset.sha256 ? '' : '更新源没有提供 SHA256，无法校验安装包完整性。',
    };
  } catch (err) {
    try { fs.rmSync(destination, { force: true }); } catch (e) { /* ignore */ }
    if (tooLarge) throw new Error('安装包超过 800 MB 上限，已停止下载');
    if (err.code === 'ABORTED' || controller.signal.aborted) throw new Error('已取消下载');
    throw err;
  } finally {
    active = null;
  }
}

function cancel() {
  if (!active) return { ok: false, error: '没有正在下载的更新' };
  try { active.controller.abort(); } catch (err) { /* ignore */ }
  return { ok: true };
}

function installTarget() {
  if (!downloaded || !fs.existsSync(downloaded.path)) return null;
  return downloaded.path;
}

function markInstalled() {
  // 安装程序启动后由主进程退出；这里只留下状态，便于诊断。
  lastCheck = Date.now();
}

function reset() {
  release = null;
  downloaded = null;
  lastError = '';
  active = null;
  checking = false;
}

module.exports = {
  configure,
  check,
  download,
  cancel,
  installTarget,
  markInstalled,
  snapshot,
  compareVersions,
  normalizeVersion,
  reset,
};