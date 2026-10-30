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
  'onlineDownloads', 'language',
];

function defaultGameDir() {
  return platform.defaultGameDir();
}

function defaultMemory() {
  const totalMb = Math.floor(os.totalmem() / 1048576);
  const half = Math.floor(totalMb / 2 / 1024) * 1024;
  return Math.max(2048, Math.min(8192, half));
}

function defaults() {
  return {
    gameDir: defaultGameDir(),
    gameDataDir: '',
    javaPath: '',
    memoryMb: defaultMemory(),
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
  return Object.assign({}, data, { lastPlayed: Object.assign({}, data.lastPlayed) });
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
  gameDir: () => get().gameDir,
  dataDir: () => config.root(),
};