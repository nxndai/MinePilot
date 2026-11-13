'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const platform = require('./platform');

const ALLOWED_KEYS = [
  'gameDir', 'javaPath', 'memoryMb', 'fullscreen', 'width', 'height',
  'jvmArgs', 'downloadThreads', 'useMirror', 'downloadAssets', 'offlineName',
  'lastVersion', 'firstRun', 'autoOpenLog', 'lastPlayed', 'javaMajorOverride',
  'keepLauncherOpen', 'authMode', 'versionIsolation', 'gameDataDir',
  'curseforgeApiKey', 'downloadSource', 'theme', 'backgroundType',
  'backgroundColor', 'uiScale', 'animations', 'updateFeedUrl', 'autoCheckUpdates',
  'onlineDownloads', 'language', 'memoryAuto', 'memoryOptimize',
  'javaExtraPaths', 'javaIgnorePaths', 'javaVersionOverrides', 'javaVendor', 'gistToken',
  'pluginIndexUrl', 'netplayProfiles', 'netplayAutoStartGame', 'netplayStopOnGameExit',
];

function defaultGameDir() {
  return platform.defaultGameDir();
}

function recommendedMemory(totalMemoryMb) {
  const totalMb = Number(totalMemoryMb) || Math.floor(os.totalmem() / 1048576);
  let value;
  if (totalMb <= 4096) value = Math.floor(totalMb * 0.5);
  else if (totalMb <= 6144) value = 3072;
  else if (totalMb <= 8192) value = 4096;
  else if (totalMb <= 12288) value = 6144;
  else if (totalMb <= 16384) value = 8192;
  else if (totalMb <= 24576) value = 10240;
  else value = 12288;
  // 给系统和其他程序留出空间；低内存机器仍保证至少 2 GB。
  value = Math.min(value, Math.floor(totalMb * 0.6));
  value = Math.max(2048, Math.min(12288, value));
  return Math.floor(value / 512) * 512;
}

function defaultMemory() {
  return recommendedMemory();
}

function defaults() {
  return {
    gameDir: defaultGameDir(),
    gameDataDir: '',
    javaPath: '',
    javaExtraPaths: [],
    javaIgnorePaths: [],
    javaVersionOverrides: {},
    javaVendor: 'temurin',
    memoryMb: defaultMemory(),
    memoryAuto: true,
    memoryOptimize: true,
    fullscreen: false,
    width: 1280,
    height: 720,
    jvmArgs: '',
    downloadThreads: 16,
    useMirror: true,
    downloadAssets: true,
    offlineName: 'Steve',
    lastVersion: '',
    firstRun: true,
    autoOpenLog: true,
    lastPlayed: {},
    keepLauncherOpen: true,
    authMode: 'offline',
    versionIsolation: false,
    curseforgeApiKey: '',
    downloadSource: 'auto',
    theme: 'dark',
    backgroundType: 'default',
    backgroundColor: '#0b1020',
    uiScale: 1,
    animations: true,
    updateFeedUrl: '',
    autoCheckUpdates: true,
    // 默认关闭在线下载：只使用本地已有的游戏文件，避免首次启动即联网拉取内容。
    onlineDownloads: false,
    // 启动器语言：中文（zh-CN）或英文（en-US）。游戏语言会跟随此设置。
    language: 'zh-CN',
    // 插件市场索引；为空时仍可手动填写任意 GitHub / HTTPS JSON 地址。
    pluginIndexUrl: 'https://raw.githubusercontent.com/nxndai/MinePilot/main/docs/plugin-index.json',
    // 联机工具只保存用户自己的可执行文件与参数，不随启动器分发第三方二进制。
    netplayProfiles: [],
    // 开房间后是否顺带启动游戏，以及游戏退出时是否自动停掉联机工具。
    netplayAutoStartGame: false,
    netplayStopOnGameExit: true,
  };
}

let current = null;

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitize(patch, base) {
  const next = Object.assign({}, base);
  for (const key of ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    let value = patch[key];
    switch (key) {
      case 'memoryMb':
        value = clampInt(value, 512, 65536, base.memoryMb);
        break;
      case 'downloadThreads':
        value = clampInt(value, 1, 32, base.downloadThreads);
        break;
      case 'uiScale': {
        const parsed = Number(value);
        value = Number.isFinite(parsed) ? Math.max(0.8, Math.min(1.4, parsed)) : base.uiScale;
        break;
      }
      case 'width':
        value = clampInt(value, 640, 7680, base.width);
        break;
      case 'height':
        value = clampInt(value, 480, 4320, base.height);
        break;
      case 'fullscreen':
      case 'useMirror':
      case 'downloadAssets':
      case 'firstRun':
      case 'autoOpenLog':
      case 'keepLauncherOpen':
      case 'versionIsolation':
      case 'animations':
      case 'autoCheckUpdates':
      case 'onlineDownloads':
      case 'memoryAuto':
      case 'memoryOptimize':
      case 'netplayAutoStartGame':
      case 'netplayStopOnGameExit':
        value = Boolean(value);
        break;
      case 'language':
        value = value === 'en-US' ? 'en-US' : 'zh-CN';
        break;
      case 'authMode':
        value = value === 'microsoft' ? 'microsoft' : 'offline';
        break;
      case 'theme':
        value = value === 'light' ? 'light' : 'dark';
        break;
      case 'backgroundType':
        value = ['default', 'color', 'image'].includes(value) ? value : 'default';
        break;
      case 'backgroundColor':
        value = /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : base.backgroundColor;
        break;
      case 'downloadSource':
        value = ['auto', 'bmclapi', 'official'].includes(value) ? value : 'auto';
        break;
      case 'lastPlayed':
        value = value && typeof value === 'object' ? Object.assign({}, value) : {};
        break;
      case 'gameDir':
      case 'gameDataDir':
      case 'javaPath':
      case 'jvmArgs':
      case 'offlineName':
      case 'lastVersion':
        value = String(value == null ? '' : value);
        break;
      case 'curseforgeApiKey':
        value = String(value == null ? '' : value).trim().slice(0, 200);
        break;
      case 'gistToken':
        value = String(value == null ? '' : value).trim().slice(0, 200);
        break;
      case 'pluginIndexUrl':
        value = String(value == null ? '' : value).trim().slice(0, 500);
        if (value && !/^https:\/\//i.test(value)) value = '';
        break;
      case 'netplayProfiles':
        value = Array.isArray(value)
          ? value.slice(0, 20).map((item, index) => {
            const raw = item && typeof item === 'object' ? item : {};
            return {
              id: String(raw.id || `net-${index + 1}`).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80) || `net-${index + 1}`,
              name: String(raw.name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 60),
              tool: ['terracotta', 'easytier', 'frp', 'custom'].includes(raw.tool) ? raw.tool : 'custom',
              executable: String(raw.executable || '').trim().slice(0, 500),
              args: Array.isArray(raw.args)
                ? raw.args.slice(0, 40).map((arg) => String(arg || '').replace(/[\u0000-\u001f]/g, '').slice(0, 300)).filter(Boolean)
                : [],
              cwd: String(raw.cwd || '').trim().slice(0, 500),
              autoCopy: raw.autoCopy !== false,
            };
          })
          : [];
        break;
      case 'javaVendor':
        value = ['temurin', 'zulu', 'corretto'].includes(value) ? value : 'temurin';
        break;
      case 'javaExtraPaths':
      case 'javaIgnorePaths':
        value = Array.isArray(value)
          ? Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 50)
          : [];
        break;
      case 'javaVersionOverrides':
        value = value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value)
            .map(([key, item]) => [String(key || '').slice(0, 120), String(item || '').trim()])
            .filter(([key, item]) => key && item)
            .slice(0, 200))
          : {};
        break;
      case 'updateFeedUrl':
        value = String(value == null ? '' : value).trim().slice(0, 500);
        if (value && !/^https?:\/\//i.test(value)) value = '';
        break;
      default:
        break;
    }
    next[key] = value;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'downloadSource')
    && !Object.prototype.hasOwnProperty.call(patch, 'useMirror')) {
    next.useMirror = next.downloadSource !== 'official';
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'useMirror')
    && !Object.prototype.hasOwnProperty.call(patch, 'downloadSource')) {
    next.downloadSource = next.useMirror ? 'auto' : 'official';
  }
  delete next.totalMemoryMb;
  delete next.recommendedMemoryMb;
  return next;
}

function load() {
  if (current) return current;
  const base = defaults();
  try {
    const raw = fs.readFileSync(config.configFile(), 'utf8');
    const parsed = JSON.parse(raw);
    current = sanitize(parsed, base);
    if (!Object.prototype.hasOwnProperty.call(parsed, 'downloadSource')) {
      current.downloadSource = current.useMirror ? 'auto' : 'official';
    }
  } catch (err) {
    current = base;
  }
  return current;
}

function save() {
  const file = config.configFile();
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.error('保存设置失败:', err.message);
  }
}

function get() {
  const data = load();
  return Object.assign({}, data, {
    lastPlayed: Object.assign({}, data.lastPlayed),
    totalMemoryMb: Math.floor(os.totalmem() / 1048576),
    recommendedMemoryMb: recommendedMemory(),
  });
}

function update(patch) {
  const base = get();
  current = sanitize(patch || {}, base);
  save();
  return get();
}

module.exports = {
  get,
  update,
  defaults,
  recommendedMemory,
  gameDir: () => get().gameDir,
  dataDir: () => config.root(),
};