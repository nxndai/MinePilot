'use strict';

const net = require('./net');
const logger = require('./logger');
const settings = require('./settings');

/**
 * Fabric / Forge / NeoForge / Quilt 元数据。
 * 安装流程放在 installer.js 里，这个模块只负责查询版本和生成下载地址。
 */

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FABRIC_MIRROR = 'https://bmclapi2.bangbang93.com/fabric-meta/v2';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const FORGE_MIRROR = 'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge';
const FORGE_PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const NEOFORGE_RELEASES = 'https://maven.neoforged.net/releases/net/neoforged';
const NEOFORGE_MIRROR = 'https://bmclapi2.bangbang93.com/maven/net/neoforged';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const QUILT_MIRROR = 'https://bmclapi2.bangbang93.com/quilt-meta/v3';

function compareParts(a, b) {
  const left = String(a).split(/[.\-+]/).map((part) => Number(part) || 0);
  const right = String(b).split(/[.\-+]/).map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function markRecommendations(list) {
  const sorted = list.slice().sort((a, b) => {
    if (a.stable !== b.stable) return a.stable ? -1 : 1;
    return compareParts(b.version, a.version);
  });
  const stable = sorted.find((item) => item.stable) || sorted[0];
  sorted.forEach((item, index) => {
    item.recommended = item === stable;
    item.latest = index === 0;
  });
  return sorted;
}

async function fetchFirstJson(urls) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await net.fetchJson(url, { timeout: 10000, retries: 1 });
    } catch (err) {
      lastError = err;
      logger.warn('加载器元数据获取失败:', url, err.message);
    }
  }
  throw new Error(`无法获取加载器版本列表：${lastError ? lastError.message : '网络错误'}`);
}

async function fetchFirstText(urls) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await net.fetchText(url, { timeout: 10000, retries: 1 });
    } catch (err) {
      lastError = err;
      logger.warn('加载器元数据获取失败:', url, err.message);
    }
  }
  throw new Error(`无法获取加载器版本列表：${lastError ? lastError.message : '网络错误'}`);
}

function orderedUrls(official, mirror) {
  let source = 'auto';
  try { source = settings.get().downloadSource || 'auto'; } catch (err) { /* 使用默认源 */ }
  if (source === 'official') return [official];
  return source === 'bmclapi' ? [mirror, official] : [official, mirror];
}

async function fabricVersions(mcVersion) {
  const encoded = encodeURIComponent(mcVersion);
  const data = await fetchFirstJson(orderedUrls(
    `${FABRIC_META}/versions/loader/${encoded}`,
    `${FABRIC_MIRROR}/versions/loader/${encoded}`,
  ));
  if (!Array.isArray(data)) throw new Error('Fabric 版本列表格式不正确');
  const list = data
    .filter((item) => item && item.loader && item.loader.version)
    .map((item) => ({
      type: 'fabric',
      mcVersion,
      version: item.loader.version,
      stable: Boolean(item.loader.stable),
    }));
  if (!list.length) throw new Error(`Minecraft ${mcVersion} 没有可用的 Fabric 版本`);
  return markRecommendations(list);
}

async function fabricProfile(mcVersion, loaderVersion) {
  const encodedMc = encodeURIComponent(mcVersion);
  const encodedLoader = encodeURIComponent(loaderVersion);
  const data = await fetchFirstJson(orderedUrls(
    `${FABRIC_META}/versions/loader/${encodedMc}/${encodedLoader}/profile/json`,
    `${FABRIC_MIRROR}/versions/loader/${encodedMc}/${encodedLoader}/profile/json`,
  ));
  if (!data || !data.id || !Array.isArray(data.libraries)) {
    throw new Error('Fabric 启动配置格式不正确');
  }
  return data;
}

function parseForgeVersions(xml, mcVersion) {
  const versions = [];
  const pattern = /<version>([^<]+)<\/version>/g;
  let match;
  const prefix = `${mcVersion}-`;
  while ((match = pattern.exec(xml)) !== null) {
    const full = match[1].trim();
    if (!full.startsWith(prefix)) continue;
    const version = full.slice(prefix.length);
    if (!version) continue;
    versions.push({ type: 'forge', mcVersion, version, full });
  }
  const unique = new Map(versions.map((item) => [item.version, item]));
  return Array.from(unique.values()).sort((a, b) => compareParts(b.version, a.version));
}

async function forgeVersions(mcVersion) {
  let promos = {};
  try {
    const data = await net.fetchJson(FORGE_PROMOTIONS, { timeout: 8000, retries: 1 });
    promos = (data && data.promos) || {};
  } catch (err) {
    logger.warn('Forge 推荐版本获取失败:', err.message);
  }

  const xml = await fetchFirstText(orderedUrls(
    `${FORGE_MAVEN}/maven-metadata.xml`,
    `${FORGE_MIRROR}/maven-metadata.xml`,
  ));
  const list = parseForgeVersions(xml, mcVersion);
  if (!list.length) throw new Error(`Minecraft ${mcVersion} 没有可用的 Forge 版本`);

  const recommended = promos[`${mcVersion}-recommended`] || '';
  const latest = promos[`${mcVersion}-latest`] || '';
  const byVersion = new Map(list.map((item) => [item.version, item]));
  for (const version of [recommended, latest]) {
    if (version && !byVersion.has(version)) {
      const item = { type: 'forge', mcVersion, version, full: `${mcVersion}-${version}` };
      byVersion.set(version, item);
      list.push(item);
    }
  }

  const sorted = list
    .map((item) => ({
      type: 'forge',
      mcVersion,
      version: item.version,
      full: item.full,
      stable: true,
      recommended: item.version === recommended,
      latest: item.version === latest,
    }))
    .sort((a, b) => compareParts(b.version, a.version));

  if (!sorted.some((item) => item.recommended)) {
    sorted[0].recommended = true;
  }
  return sorted;
}

function forgeInstallerUrls(mcVersion, loaderVersion) {
  const full = `${mcVersion}-${loaderVersion}`;
  return {
    full,
    official: `${FORGE_MAVEN}/${encodeURIComponent(full)}/forge-${encodeURIComponent(full)}-installer.jar`,
    mirror: `${FORGE_MIRROR}/${encodeURIComponent(full)}/forge-${encodeURIComponent(full)}-installer.jar`,
  };
}

/**
 * NeoForge 的版本号和 Minecraft 版本不是一一对应：
 *   1.20.1  -> net.neoforged:forge:1.20.1-47.x
 *   1.20.2+ -> net.neoforged:neoforge:20.2.x / 21.1.x
 */
function neoForgeTarget(mcVersion) {
  const parts = String(mcVersion || '').split('.').map((part) => Number(part) || 0);
  if (parts[0] !== 1) return null;
  const minor = parts[1];
  const patch = parts[2] || 0;
  if (minor < 20 || (minor === 20 && patch < 1)) return null;
  if (minor === 20 && patch === 1) {
    return { artifact: 'forge', legacy: true, prefix: '1.20.1-' };
  }
  return { artifact: 'neoforge', legacy: false, prefix: `${minor}.${patch}.` };
}

function parseMavenVersions(xml) {
  const versions = [];
  const pattern = /<version>([^<]+)<\/version>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const version = match[1].trim();
    if (version) versions.push(version);
  }
  return Array.from(new Set(versions));
}

async function neoForgeVersions(mcVersion) {
  const target = neoForgeTarget(mcVersion);
  if (!target) {
    throw new Error(`Minecraft ${mcVersion} 没有可用的 NeoForge 版本（NeoForge 从 1.20.1 开始支持）`);
  }

  const xml = await fetchFirstText(orderedUrls(
    `${NEOFORGE_RELEASES}/${target.artifact}/maven-metadata.xml`,
    `${NEOFORGE_MIRROR}/${target.artifact}/maven-metadata.xml`,
  ));
  const list = parseMavenVersions(xml)
    .filter((version) => version.startsWith(target.prefix))
    .map((full) => {
      const display = target.legacy ? full.slice(target.prefix.length) : full;
      return {
        type: 'neoforge',
        mcVersion,
        version: display,
        full,
        stable: !/(?:^|[-.])beta/i.test(full) && !/(?:^|[-.])alpha/i.test(full),
      };
    })
    .filter((item) => item.version);

  if (!list.length) {
    throw new Error(`Minecraft ${mcVersion} 没有可用的 NeoForge 版本`);
  }
  return markRecommendations(list);
}

function neoForgeInstallerUrls(mcVersion, loaderVersion) {
  const target = neoForgeTarget(mcVersion);
  if (!target) throw new Error(`Minecraft ${mcVersion} 不支持 NeoForge`);
  let full = String(loaderVersion || '').trim();
  if (!full) throw new Error('缺少 NeoForge 版本号');
  if (target.legacy && !full.startsWith(`${mcVersion}-`)) {
    full = `${mcVersion}-${full}`;
  }
  const file = `${target.artifact}-${full}-installer.jar`;
  return {
    full,
    artifact: target.artifact,
    official: `${NEOFORGE_RELEASES}/${target.artifact}/${encodeURIComponent(full)}/${file}`,
    mirror: `${NEOFORGE_MIRROR}/${target.artifact}/${encodeURIComponent(full)}/${file}`,
  };
}

async function quiltVersions(mcVersion) {
  const encoded = encodeURIComponent(mcVersion);
  const data = await fetchFirstJson(orderedUrls(
    `${QUILT_META}/versions/loader/${encoded}`,
    `${QUILT_MIRROR}/versions/loader/${encoded}`,
  ));
  if (!Array.isArray(data)) throw new Error('Quilt 版本列表格式不正确');
  const list = data
    .filter((item) => item && item.loader && item.loader.version)
    .map((item) => ({
      type: 'quilt',
      mcVersion,
      version: item.loader.version,
      stable: Boolean(item.loader.stable),
    }));
  if (!list.length) throw new Error(`Minecraft ${mcVersion} 没有可用的 Quilt 版本`);
  return markRecommendations(list);
}

async function quiltProfile(mcVersion, loaderVersion) {
  const encodedMc = encodeURIComponent(mcVersion);
  const encodedLoader = encodeURIComponent(loaderVersion);
  const data = await fetchFirstJson(orderedUrls(
    `${QUILT_META}/versions/loader/${encodedMc}/${encodedLoader}/profile/json`,
    `${QUILT_MIRROR}/versions/loader/${encodedMc}/${encodedLoader}/profile/json`,
  ));
  if (!data || !data.id || !Array.isArray(data.libraries)) {
    throw new Error('Quilt 启动配置格式不正确');
  }
  return data;
}

module.exports = {
  compareParts,
  fabricVersions,
  fabricProfile,
  forgeVersions,
  forgeInstallerUrls,
  neoForgeTarget,
  neoForgeVersions,
  neoForgeInstallerUrls,
  quiltVersions,
  quiltProfile,
};