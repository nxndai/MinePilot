'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

app.setName('MinePilot');

// 独立应用版优先使用程序目录旁的 data，做到真正的便携；
// 如果 data 不存在，则使用 Electron 默认的 %APPDATA%\MinePilot。
const exeDir = path.dirname(process.execPath);
// macOS 的 .app 内部不适合写便携数据，使用系统标准的 Application Support；
// Windows / Linux 继续优先使用程序目录旁的 data，保持便携。
const isMacBundle = process.platform === 'darwin' && /[\\/]Contents[\\/]MacOS$/i.test(exeDir);
const portableDataDir = isMacBundle ? '' : path.join(exeDir, 'data');
const envDataDir = process.env.MINEPILOT_HOME ? path.resolve(process.env.MINEPILOT_HOME) : '';
const portableHome = !envDataDir && portableDataDir && fs.existsSync(portableDataDir) ? portableDataDir : '';

if (envDataDir || portableHome) {
  try {
    const dataHome = envDataDir || portableHome;
    // 先创建 Chromium 配置目录，否则首次启动时单实例锁文件可能因父目录不存在而创建失败。
    fs.mkdirSync(path.join(dataHome, 'chromium'), { recursive: true });
    fs.mkdirSync(path.join(dataHome, 'crash'), { recursive: true });
    app.setPath('userData', path.join(dataHome, 'chromium'));
    app.setPath('crashDumps', path.join(dataHome, 'crash'));
  } catch (err) {
    /* 数据目录不可写时忽略 */
  }
}
if (process.env.MINEPILOT_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}
if (process.env.MINEPILOT_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}
if (process.env.MINEPILOT_SINGLE_PROCESS === '1') {
  app.commandLine.appendSwitch('single-process');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.minepilot.launcher');
}

const isShot = process.argv.includes('--shot');
const initialViewArg = process.argv.find((arg) => arg.startsWith('--view='));
const initialView = initialViewArg ? initialViewArg.slice('--view='.length).replace(/[^a-z]/gi, '') : '';
if (!isShot) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
  }
}

const config = require('./src/core/config');
const settings = require('./src/core/settings');
const ONLINE_DOWNLOADS_OFF = '在线下载已关闭。请先在「设置 → 下载」中勾选“在线下载”。';
function onlineDownloadsEnabled() {
  return settings.get().onlineDownloads === true;
}
function onlineDownloadsBlocked() {
  return { ok: false, code: 'ONLINE_DOWNLOADS_DISABLED', error: ONLINE_DOWNLOADS_OFF };
}
function requireOnlineDownloads() {
  if (onlineDownloadsEnabled()) return;
  const err = new Error(ONLINE_DOWNLOADS_OFF);
  err.code = 'ONLINE_DOWNLOADS_DISABLED';
  throw err;
}
const logger = require('./src/core/logger');
const versionsCore = require('./src/core/versions');
const modsCore = require('./src/core/mods');
const modmanager = require('./src/core/modmanager');
const modpack = require('./src/core/modpack');
const mojang = require('./src/core/mojang');
const installer = require('./src/core/installer');
const launcher = require('./src/core/launcher');
const javaCore = require('./src/core/java');
const loaders = require('./src/core/loaders');
const accounts = require('./src/core/accounts');
const microsoft = require('./src/core/microsoft');
const skinmanager = require('./src/core/skinmanager');
const appearance = require('./src/core/appearance');
const monitor = require('./src/core/monitor');
const memory = require('./src/core/memory');
const platform = require('./src/core/platform');
const diagnostics = require('./src/core/diagnostics');
const updater = require('./src/core/updater');
const plugins = require('./src/core/plugins');

let mainWindow = null;
let installing = null;
let modInstalling = null;
let packImporting = null;
let currentLaunch = null;
let memoryCleaning = null;
let pendingAuth = null;
let shotTarget = null;
let dumpTarget = null;

if (isShot) {
  const index = process.argv.indexOf('--shot');
  shotTarget = path.resolve(process.argv[index + 1] || 'shot.png');
}
const dumpArg = process.argv.find((arg) => arg.startsWith('--dump='));
if (dumpArg) dumpTarget = path.resolve(dumpArg.slice('--dump='.length));
const clickPlugin = process.argv.includes('--click-plugin');
const clickUpdate = process.argv.includes('--click-update');
const toggleOnline = process.argv.includes('--toggle-online');

function senderWindow(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win || mainWindow;
}

function send(channel, payload) {
  const win = mainWindow;
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function summarizeDiagnostics(record) {
  if (!record) return null;
  return {
    id: record.id,
    crashed: record.crashed,
    killed: record.killed,
    severity: record.severity,
    title: record.title,
    summary: record.summary,
    versionId: record.versionId,
    createdAt: record.createdAt,
  };
}

function analyzeGameExit(info) {
  try {
    const record = diagnostics.analyze(Object.assign({}, info, {
      logTail: monitor.logTail(),
      killRequested: monitor.killRequested(),
      appVersion: app.getVersion(),
    }));
    if (record.crashed) diagnostics.save(record);
    return record;
  } catch (err) {
    logger.warn('生成崩溃诊断失败:', err.message);
    return null;
  }
}


const EXPLORER_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
const CMD_EXE = process.env.ComSpec || 'cmd.exe';
const RUNDLL32_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');

/** 启动一个可见的独立进程，并等到系统真正创建它。 */
function spawnVisible(exe, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    child.once('error', (err) => finish(reject, err));
    child.once('spawn', () => {
      child.unref();
      finish(resolve, child);
    });
  });
}

/**
 * 直接调用 explorer.exe，而不是只依赖 Electron 的 shell.openPath。
 * 某些 Windows 关联损坏时 shell.openPath 会返回成功但什么都不打开。
 */
async function openDirectory(rawTarget) {
  const target = String(rawTarget || '').trim();
  if (!target) return { ok: false, error: '路径为空' };
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) return { ok: false, error: '路径不存在：' + resolved };

  logger.info('请求打开目录:', resolved);
  const attempts = [];

  if (!platform.isWindows) {
    const shellError = await shell.openPath(resolved);
    if (!shellError) {
      logger.info('已通过系统文件管理器打开目录:', resolved);
      return { ok: true, via: 'shell' };
    }
    attempts.push('Shell: ' + shellError);
    const opener = platform.openCommand();
    if (opener) {
      try {
        await spawnVisible(opener, [resolved]);
        logger.info('已通过系统命令打开目录:', resolved);
        return { ok: true, via: opener };
      } catch (err) {
        attempts.push(`${opener}: ` + err.message);
      }
    }
    logger.warn('打开目录失败:', resolved, attempts.join('；'));
    return { ok: false, error: '系统未能打开该目录（' + attempts.join('；') + '）' };
  }

  try {
    await spawnVisible(EXPLORER_EXE, [resolved]);
    logger.info('已通过 Explorer 打开目录:', resolved);
    return { ok: true, via: 'explorer' };
  } catch (err) {
    attempts.push('Explorer: ' + err.message);
    logger.warn('Explorer 打开目录失败:', err.message);
  }

  const shellError = await shell.openPath(resolved);
  if (!shellError) {
    logger.info('已通过系统关联打开目录:', resolved);
    return { ok: true, via: 'shell' };
  }
  attempts.push('Shell: ' + shellError);

  try {
    await spawnVisible(CMD_EXE, ['/d', '/c', 'start', '', resolved]);
    logger.info('已通过 start 打开目录:', resolved);
    return { ok: true, via: 'start' };
  } catch (err) {
    attempts.push('start: ' + err.message);
  }

  logger.warn('打开目录失败:', resolved, attempts.join('；'));
  return { ok: false, error: '系统未能打开该目录（' + attempts.join('；') + '）' };
}

/**
 * 打开外部链接：Windows 优先调用系统 URL 协议处理器（rundll32），
 * 再回退到 Electron Shell、资源管理器和 cmd start。直接启动 msedge.exe
 * 在部分环境下只会创建后台进程，不会显示浏览器窗口，因此不作为首选。
 */
async function openExternalSafe(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '不支持的链接' };

  logger.info('请求打开链接:', url);
  const attempts = [];

  if (!platform.isWindows) {
    try {
      await shell.openExternal(url);
      logger.info('已通过系统默认浏览器打开链接:', url);
      return { ok: true, via: 'shell' };
    } catch (err) {
      attempts.push('Shell: ' + err.message);
    }
    const opener = platform.openCommand();
    if (opener) {
      try {
        await spawnVisible(opener, [url]);
        logger.info('已通过系统命令打开链接:', url);
        return { ok: true, via: opener };
      } catch (err) {
        attempts.push(`${opener}: ` + err.message);
      }
    }
    logger.warn('打开链接失败:', url, attempts.join('；'));
    return { ok: false, error: '系统未能打开浏览器（' + attempts.join('；') + '）' };
  }

  // 优先调用 Windows 的 URL 协议处理器。它比直接启动 msedge.exe 更接近
  // 用户双击链接的行为，也不会只留下后台浏览器进程。
  try {
    await spawnVisible(RUNDLL32_EXE, ['url.dll,FileProtocolHandler', url]);
    logger.info('已通过 URL 协议处理器打开链接:', url);
    return { ok: true, via: 'rundll32' };
  } catch (err) {
    attempts.push('Rundll32: ' + err.message);
  }

  // 再交给 Electron 的系统 Shell 关联，让默认浏览器自己决定窗口行为。
  try {
    await shell.openExternal(url);
    logger.info('已通过系统关联打开链接:', url);
    return { ok: true, via: 'shell' };
  } catch (err) {
    attempts.push('Shell: ' + err.message);
  }

  try {
    await spawnVisible(EXPLORER_EXE, [url]);
    logger.info('已通过资源管理器打开链接:', url);
    return { ok: true, via: 'explorer' };
  } catch (err) {
    attempts.push('Explorer: ' + err.message);
  }

  try {
    await spawnVisible(CMD_EXE, ['/d', '/c', 'start', '', url]);
    logger.info('已通过系统默认浏览器打开链接:', url);
    return { ok: true, via: 'start' };
  } catch (err) {
    attempts.push('start: ' + err.message);
  }

  logger.warn('打开链接失败:', url, attempts.join('；'));
  return { ok: false, error: '系统未能打开浏览器（' + attempts.join('；') + '）' };
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: 'MinePilot',
    version: app.getVersion(),
    dataDir: config.root(),
    gameDir: settings.get().gameDir,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
  }));

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:update', (event, patch) => {
    const next = settings.update(patch || {});
    send('settings:changed', next);
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'authMode')) {
      send('auth:changed', { mode: next.authMode, microsoft: accounts.summary() });
    }
    return next;
  });

  ipcMain.handle('auth:status', () => ({
    ok: true,
    mode: settings.get().authMode,
    microsoft: accounts.summary(),
  }));

  ipcMain.handle('auth:login-start', async () => {
    if (pendingAuth) {
      try { pendingAuth.controller.abort(); } catch (err) { /* ignore */ }
    }
    const start = await microsoft.startDeviceCode();
    pendingAuth = {
      deviceCode: start.deviceCode,
      interval: start.interval,
      expiresIn: start.expiresIn,
      expiresAt: Date.now() + start.expiresIn * 1000,
      controller: new AbortController(),
    };
    return {
      ok: true,
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      verificationUriComplete: start.verificationUriComplete,
      expiresIn: start.expiresIn,
      interval: start.interval,
      message: start.message,
    };
  });

  ipcMain.handle('auth:login-poll', async () => {
    const pending = pendingAuth;
    if (!pending) return { ok: false, code: 'NO_PENDING', error: '没有正在进行的登录，请重新获取代码' };
    if (Date.now() >= pending.expiresAt) {
      pendingAuth = null;
      return { ok: false, code: 'EXPIRED', error: '登录代码已过期，请重新获取' };
    }
    try {
      const state = await microsoft.pollDeviceCodeOnce(pending.deviceCode, {
        signal: pending.controller.signal,
      });
      if (pendingAuth !== pending) {
        return { ok: false, code: 'SUPERSEDED', error: '登录流程已更新，请重新尝试' };
      }
      if (state.status === 'pending' || state.status === 'slow_down') {
        if (state.status === 'slow_down') {
          pending.interval = Math.min((pending.interval || 5) + 5, 30);
        }
        return { ok: true, pending: true, interval: pending.interval || 5 };
      }

      const account = await microsoft.completeLogin(state.oauth);
      if (pendingAuth !== pending) {
        return { ok: false, code: 'SUPERSEDED', error: '登录流程已更新，请重新尝试' };
      }
      const summary = accounts.setMicrosoft(account);
      const next = settings.update({ authMode: 'microsoft' });
      pendingAuth = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('settings:changed', next);
        mainWindow.webContents.send('auth:changed', { mode: next.authMode, microsoft: summary });
      }
      return { ok: true, mode: 'microsoft', account: summary };
    } catch (err) {
      const retryable = err.code === 'NETWORK';
      if (!retryable && pendingAuth === pending) pendingAuth = null;
      logger.warn('Microsoft 登录轮询失败:', err.code || 'AUTH_FAILED', err.message);
      return { ok: false, code: err.code || 'AUTH_FAILED', error: err.message, retryable };
    }
  });

  ipcMain.handle('auth:login-cancel', () => {
    if (pendingAuth) {
      try { pendingAuth.controller.abort(); } catch (err) { /* ignore */ }
      pendingAuth = null;
    }
    return { ok: true };
  });

  ipcMain.handle('auth:logout', () => {
    accounts.clearMicrosoft();
    const next = settings.update({ authMode: 'offline' });
    send('settings:changed', next);
    send('auth:changed', { mode: next.authMode, microsoft: accounts.summary() });
    return { ok: true, mode: next.authMode };
  });

  ipcMain.handle('auth:refresh', async () => {
    try {
      const s = settings.get();
      if (s.authMode !== 'microsoft') return { ok: false, code: 'OFFLINE', error: '当前不是 Microsoft 账户' };
      await accounts.profileFor(Object.assign({}, s, { authMode: 'microsoft' }));
      return { ok: true, account: accounts.summary() };
    } catch (err) {
      return { ok: false, code: err.code || 'AUTH_FAILED', error: err.message };
    }
  });

  ipcMain.handle('versions:list', async () => {
    try {
      const s = settings.get();
      const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
      return { ok: true, versions: list };
    } catch (err) {
      logger.error('读取版本列表失败:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('mods:search', async (event, payload = {}) => {
    try {
      requireOnlineDownloads();
      const s = settings.get();
      const source = payload && payload.source === 'curseforge' ? 'curseforge' : 'modrinth';
      const result = await modsCore.search(Object.assign({}, payload, {
        source,
        apiKey: source === 'curseforge' ? s.curseforgeApiKey : '',
      }));
      return Object.assign({ ok: true }, result);
    } catch (err) {
      logger.warn('模组搜索失败:', err.message);
      return { ok: false, code: err.code || 'SEARCH_FAILED', error: err.message };
    }
  });

  ipcMain.handle('mods:versions', async (event, payload = {}) => {
    try {
      requireOnlineDownloads();
      const s = settings.get();
      const source = payload && payload.source === 'curseforge' ? 'curseforge' : 'modrinth';
      const result = await modsCore.getVersions(Object.assign({}, payload, {
        source,
        apiKey: source === 'curseforge' ? s.curseforgeApiKey : '',
      }));
      return Object.assign({ ok: true }, result);
    } catch (err) {
      return { ok: false, code: err.code || 'VERSIONS_FAILED', error: err.message };
    }
  });

  ipcMain.handle('mods:dependencies', async (event, payload = {}) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    const request = payload || {};
    const projectId = String(request.projectId || '').trim();
    const targetVersionId = String(request.targetVersionId || '').trim();
    if (!projectId) return { ok: false, code: 'BAD_PROJECT', error: '缺少模组项目 ID' };
    if (!targetVersionId) return { ok: false, code: 'NO_TARGET', error: '请选择要安装到的版本' };
    try {
      const s = settings.get();
      const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
      const target = list.find((version) => version.id === targetVersionId);
      if (!target) return { ok: false, code: 'NO_TARGET', error: '目标版本不存在，请刷新版本列表' };
      const source = request.source === 'curseforge' ? 'curseforge' : 'modrinth';
      const result = await modsCore.dependencies({
        target,
        projectId,
        versionId: request.versionId ? String(request.versionId) : '',
        gameVersion: String(request.gameVersion || target.mcVersion || '').trim(),
        loader: modsCore.normalizeLoader(request.loader || modsCore.loaderForVersion(target)),
        source,
        title: String(request.title || '').trim(),
        apiKey: source === 'curseforge' ? s.curseforgeApiKey : '',
      });
      return Object.assign({ ok: true }, result);
    } catch (err) {
      logger.warn('模组依赖检查失败:', err.message);
      return { ok: false, code: err.code || 'DEPENDENCY_FAILED', error: err.message };
    }
  });

  ipcMain.handle('mods:categories', async (event, payload = {}) => {
    try {
      requireOnlineDownloads();
      const s = settings.get();
      const source = payload && payload.source === 'curseforge' ? 'curseforge' : 'modrinth';
      const result = await modsCore.categories({
        source,
        apiKey: source === 'curseforge' ? s.curseforgeApiKey : '',
      });
      return Object.assign({ ok: true }, result);
    } catch (err) {
      return { ok: false, code: err.code || 'CATEGORIES_FAILED', error: err.message };
    }
  });

  ipcMain.handle('mods:install', async (event, payload = {}) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    if (modInstalling) return { ok: false, code: 'BUSY', error: '已有模组正在安装，请稍候' };
    const request = payload || {};
    const projectId = String(request.projectId || '').trim();
    const targetVersionId = String(request.targetVersionId || '').trim();
    if (!projectId) return { ok: false, code: 'BAD_PROJECT', error: '缺少模组项目 ID' };
    if (!targetVersionId) return { ok: false, code: 'NO_TARGET', error: '请选择要安装到的版本' };

    const controller = new AbortController();
    const requestId = `${projectId}-${Date.now()}`;
    modInstalling = { projectId, targetVersionId, controller };

    try {
      const s = settings.get();
      const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
      const target = list.find((version) => version.id === targetVersionId);
      if (!target) return { ok: false, code: 'NO_TARGET', error: '目标版本不存在，请刷新版本列表' };

      const loader = modsCore.normalizeLoader(request.loader || modsCore.loaderForVersion(target));
      const gameVersion = String(request.gameVersion || target.mcVersion || '').trim();
      const source = request.source === 'curseforge' ? 'curseforge' : 'modrinth';

      const result = await modsCore.install({
        target,
        projectId,
        versionId: request.versionId ? String(request.versionId) : '',
        gameVersion,
        loader,
        source,
        apiKey: source === 'curseforge' ? s.curseforgeApiKey : '',
        signal: controller.signal,
        onProgress: (progress) => send('mod:progress', Object.assign({
          projectId,
          targetVersionId,
          requestId,
        }, progress)),
      });
      const payloadResult = Object.assign({ ok: true, requestId }, result);
      send('mod:done', payloadResult);
      return payloadResult;
    } catch (err) {
      logger.warn('模组安装失败:', err.message);
      const canceled = controller.signal.aborted;
      const failure = {
        ok: false,
        code: canceled ? 'CANCELED' : (err.code || 'MOD_INSTALL_FAILED'),
        error: canceled ? '已取消' : err.message,
        projectId,
        targetVersionId,
      };
      send('mod:error', failure);
      return failure;
    } finally {
      modInstalling = null;
    }
  });

  ipcMain.handle('mods:cancel', async () => {
    if (!modInstalling) return { ok: true, canceled: false };
    try { modInstalling.controller.abort(); } catch (err) { /* ignore */ }
    modInstalling = null;
    return { ok: true, canceled: true };
  });

  ipcMain.handle('mods:installed', async (event, payload = {}) => {
    const targetVersionId = String((payload && payload.targetVersionId) || '').trim();
    if (!targetVersionId) return { ok: false, code: 'NO_TARGET', error: '请先选择目标版本' };
    try {
      const s = settings.get();
      const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
      const target = list.find((version) => version.id === targetVersionId);
      if (!target) return { ok: false, code: 'NO_TARGET', error: '目标版本不存在，请刷新版本列表' };
      return modmanager.list(target);
    } catch (err) {
      logger.warn('读取已安装模组失败:', err.message);
      return { ok: false, code: err.code || 'MOD_LIST_FAILED', error: err.message };
    }
  });

  ipcMain.handle('mods:set-enabled', async (event, payload = {}) => {
    const targetVersionId = String((payload && payload.targetVersionId) || '').trim();
    const filename = String((payload && payload.filename) || '').trim();
    const enabled = Boolean(payload && payload.enabled);
    if (!targetVersionId) return { ok: false, code: 'NO_TARGET', error: '请先选择目标版本' };
    if (!filename) return { ok: false, code: 'BAD_MOD_FILE', error: '缺少模组文件名' };
    try {
      const s = settings.get();
      const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
      const target = list.find((version) => version.id === targetVersionId);
      if (!target) return { ok: false, code: 'NO_TARGET', error: '目标版本不存在，请刷新版本列表' };
      const result = modmanager.setEnabled(target, filename, enabled);
      return Object.assign({ ok: true }, result);
    } catch (err) {
      logger.warn('切换模组状态失败:', err.message);
      return { ok: false, code: err.code || 'MOD_TOGGLE_FAILED', error: err.message };
    }
  });

  ipcMain.handle('modpack:inspect', async (event, payload = {}) => {
    const filePath = String((payload && payload.path) || '').trim();
    if (!filePath) return { ok: false, code: 'NO_PACK', error: '没有选择整合包文件' };
    try {
      const result = await modpack.inspect(filePath);
      return Object.assign({ ok: true }, result);
    } catch (err) {
      logger.warn('读取整合包失败:', err.message);
      return { ok: false, code: err.code || 'PACK_INSPECT_FAILED', error: err.message };
    }
  });

  ipcMain.handle('modpack:pick', async (event) => {
    const result = await dialog.showOpenDialog(senderWindow(event), {
      title: '选择整合包',
      defaultPath: settings.get().gameDir,
      properties: ['openFile'],
      filters: [
        { name: 'Minecraft 整合包', extensions: ['mrpack', 'zip'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('modpack:import', async (event, payload = {}) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    if (packImporting) return { ok: false, code: 'BUSY', error: '已有整合包正在导入，请稍候' };
    const filePath = String((payload && payload.path) || '').trim();
    const targetVersionId = String((payload && payload.targetVersionId) || '').trim();
    if (!filePath) return { ok: false, code: 'NO_PACK', error: '没有选择整合包文件' };
    const controller = new AbortController();
    packImporting = { filePath, targetVersionId, controller };
    try {
      const s = settings.get();
      const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
      const target = targetVersionId
        ? list.find((version) => version.id === targetVersionId) || null
        : null;
      if (!target && targetVersionId) {
        return { ok: false, code: 'NO_TARGET', error: '目标版本不存在，请刷新版本列表' };
      }
      const result = await modpack.importPack(filePath, {
        target,
        signal: controller.signal,
        onProgress: (progress) => send('modpack:progress', Object.assign({ filePath }, progress)),
      });
      send('modpack:done', result);
      return result;
    } catch (err) {
      logger.warn('导入整合包失败:', err.message);
      const canceled = controller.signal.aborted;
      const failure = {
        ok: false,
        code: canceled ? 'CANCELED' : (err.code || 'PACK_IMPORT_FAILED'),
        error: canceled ? '已取消导入' : err.message,
      };
      send('modpack:error', failure);
      return failure;
    } finally {
      packImporting = null;
    }
  });

  ipcMain.handle('modpack:cancel', async () => {
    if (!packImporting) return { ok: true, canceled: false };
    try { packImporting.controller.abort(); } catch (err) { /* ignore */ }
    return { ok: true, canceled: true };
  });

  ipcMain.handle('modpack:export', async (event, payload = {}) => {
    const targetVersionId = String((payload && payload.targetVersionId) || '').trim();
    const format = payload && payload.format === 'zip' ? 'zip' : 'mrpack';
    if (!targetVersionId) return { ok: false, code: 'NO_TARGET', error: '请先选择要导出的实例' };
    try {
      const s = settings.get();
      const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
      const target = list.find((version) => version.id === targetVersionId);
      if (!target) return { ok: false, code: 'NO_TARGET', error: '目标版本不存在，请刷新版本列表' };
      const safeTitle = String(target.id || 'MinePilot整合包').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'MinePilot整合包';
      const result = await dialog.showSaveDialog(senderWindow(event), {
        title: '导出整合包',
        defaultPath: path.join(app.getPath('downloads'), `${safeTitle}.${format}`),
        filters: [
          format === 'mrpack'
            ? { name: 'Modrinth 整合包', extensions: ['mrpack'] }
            : { name: 'ZIP 整合包', extensions: ['zip'] },
        ],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      const exported = await modpack.exportPack(target, {
        format,
        outputPath: result.filePath,
        onProgress: (progress) => send('modpack:progress', Object.assign({ targetVersionId }, progress)),
      });
      send('modpack:done', exported);
      return exported;
    } catch (err) {
      logger.warn('导出整合包失败:', err.message);
      return { ok: false, code: err.code || 'PACK_EXPORT_FAILED', error: err.message };
    }
  });

  ipcMain.handle('versions:delete', async (event, versionId) => {
    try {
      const s = settings.get();
      versionsCore.deleteVersion(s.gameDir, versionId);
      const lastPlayed = Object.assign({}, s.lastPlayed);
      delete lastPlayed[versionId];
      settings.update({ lastPlayed });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('versions:open-folder', async (event, versionId) => {
    const dir = mojang.versionFolder(settings.get().gameDir, versionId);
    if (!fs.existsSync(dir)) return { ok: false, error: '版本目录不存在' };
    return openDirectory(dir);
  });

  ipcMain.handle('versions:open-mods', async (event, versionId) => {
    const s = settings.get();
    const dir = path.join(versionsCore.effectiveDir(s.gameDir, versionId, versionsCore.isolateFor(s.gameDir, versionId, s.versionIsolation), s.gameDataDir), 'mods');
    fs.mkdirSync(dir, { recursive: true });
    return openDirectory(dir);
  });

  ipcMain.handle('game:open-folder', async (event, versionId) => {
    const s = settings.get();
    const dir = versionId
      ? versionsCore.effectiveDir(s.gameDir, versionId, versionsCore.isolateFor(s.gameDir, versionId, s.versionIsolation), s.gameDataDir)
      : s.gameDir;
    fs.mkdirSync(dir, { recursive: true });
    return openDirectory(dir);
  });

  ipcMain.handle('manifest:get', async (event, options = {}) => {
    try {
      requireOnlineDownloads();
      const manifest = await mojang.getManifest(Boolean(options.force), settings.get().downloadSource || 'auto');
      const versions = (manifest.versions || [])
        .filter((item) => item && item.id)
        .map((item) => ({
          id: item.id,
          type: item.type,
          releaseTime: item.releaseTime,
          time: item.time,
          url: item.url,
        }));
      return { ok: true, latest: manifest.latest || {}, versions };
    } catch (err) {
      logger.error('获取版本列表失败:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('install:start', async (event, payload) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    if (installing) return { ok: false, error: '已有安装任务正在进行，请稍候' };
    const request = typeof payload === 'string' ? { versionId: payload } : (payload || {});
    const versionId = String(request.versionId || '').trim();
    const supportedLoaders = ['fabric', 'forge', 'neoforge', 'quilt'];
    const loader = supportedLoaders.includes(request.loader) ? request.loader : 'vanilla';
    const loaderVersion = String(request.loaderVersion || '').trim();
    if (!versionId) return { ok: false, error: '缺少版本号' };
    if (loader !== 'vanilla' && !loaderVersion) return { ok: false, error: '缺少加载器版本' };
    const controller = new AbortController();
    installing = { versionId, loader, controller };
    const win = senderWindow(event);

    try {
      const result = await installer.installVersion(versionId, {
        loader,
        loaderVersion,
        signal: controller.signal,
        onProgress: (progress) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('install:progress', Object.assign({ versionId, requestId: versionId, loader }, progress));
          }
        },
      });
      if (win && !win.isDestroyed()) {
        win.webContents.send('install:done', Object.assign({ versionId }, result, { requestId: versionId, loader }));
      }
      return {
        ok: true,
        versionId: result.versionId || versionId,
        loader,
        totalBytes: result.totalBytes,
        elapsed: result.elapsed,
      };
    } catch (err) {
      const aborted = controller.signal.aborted || err.code === 'ABORTED';
      const message = aborted ? '已取消安装' : err.message;
      logger.warn('安装失败:', versionId, message);
      if (win && !win.isDestroyed()) {
        win.webContents.send('install:error', { versionId, requestId: versionId, loader, code: err.code || '', error: message, aborted });
      }
      return { ok: false, error: message, aborted, code: err.code };
    } finally {
      installing = null;
    }
  });

  ipcMain.handle('install:cancel', () => {
    if (installing) {
      installing.controller.abort();
      return { ok: true };
    }
    return { ok: false, error: '当前没有安装任务' };
  });

  ipcMain.handle('loader:versions', async (event, payload = {}) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    try {
      const mcVersion = String(payload.mcVersion || '').trim();
      const type = ['fabric', 'forge', 'neoforge', 'quilt'].includes(payload.type) ? payload.type : 'fabric';
      if (!mcVersion) return { ok: false, error: '缺少 Minecraft 版本号' };
      const loadersByType = {
        fabric: loaders.fabricVersions,
        forge: loaders.forgeVersions,
        neoforge: loaders.neoForgeVersions,
        quilt: loaders.quiltVersions,
      };
      const list = await loadersByType[type](mcVersion);
      return { ok: true, type, mcVersion, versions: list };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('launch:start', async (event, versionId) => {
    if (!versionId) return { ok: false, code: 'INVALID_VERSION', error: '缺少版本号' };
    if (currentLaunch && currentLaunch.process && currentLaunch.process.exitCode === null) {
      return { ok: false, code: 'ALREADY_RUNNING', error: '游戏已经在运行中' };
    }

    const s = settings.get();
    let meta;
    try {
      meta = await mojang.loadVersion(s.gameDir, versionId);
    } catch (err) {
      return { ok: false, code: 'INVALID_VERSION', error: err.message };
    }

    const required = javaCore.requiredJava(meta.jarId || meta.id, meta.javaMajor);
    const pick = await javaCore.pickFor(required, s.javaPath);
    if (!pick.java) {
      return { ok: false, code: 'NO_JAVA', required, error: `未检测到 Java ${required}，请先安装 Java 运行环境` };
    }
    if (!pick.compatible) {
      return {
        ok: false,
        code: 'JAVA_TOO_OLD',
        required,
        found: pick.java.major,
        java: pick.java.path,
        error: `当前 Java 版本为 ${pick.java.major}，该游戏需要 Java ${required}`,
      };
    }

    const win = senderWindow(event);
    try {
      const result = await launcher.launch(versionId, {
        javaPath: pick.java.path,
        javaMajor: pick.java.major,
        javaBits: pick.java.bits,
        onLog: (text) => {
          monitor.pushLog(text);
          if (win && !win.isDestroyed()) win.webContents.send('launch:log', { versionId, text });
        },
        onProgress: (progress) => {
          if (win && !win.isDestroyed()) win.webContents.send('launch:progress', Object.assign({ versionId }, progress));
        },
        onExit: (info) => {
          const record = analyzeGameExit(Object.assign({ versionId }, info));
          monitor.detach(Object.assign({ versionId }, info));
          currentLaunch = null;
          if (win && !win.isDestroyed()) {
            if (record && record.crashed) win.webContents.send('crash:detected', record);
            win.webContents.send('launch:exit', Object.assign({ versionId }, info, {
              diagnostics: summarizeDiagnostics(record),
            }));
          }
        },
      });
      currentLaunch = result;
      monitor.attach(result);
      const current = settings.get();
      const lastPlayed = Object.assign({}, current.lastPlayed);
      lastPlayed[versionId] = Date.now();
      settings.update({ lastVersion: versionId, lastPlayed });
      return {
        ok: true,
        pid: result.pid,
        logPath: result.logPath,
        java: pick.java.path,
        integrity: result.integrity,
        javaMajor: pick.java.major,
        gameDir: result.gameDir,
        portable: result.portable,
      };
    } catch (err) {
      logger.error('启动失败:', versionId, err.message);
      return { ok: false, code: err.code || 'LAUNCH_FAILED', error: err.message };
    }
  });

  ipcMain.handle('java:detect', async () => {
    try {
      const list = await javaCore.detect(true);
      return { ok: true, list };
    } catch (err) {
      return { ok: false, error: err.message, list: [] };
    }
  });

  ipcMain.handle('java:install', async (event, major) => {
    try {
      requireOnlineDownloads();
      const win = senderWindow(event);
      const result = await javaCore.installJava(major, (progress) => {
        if (win && !win.isDestroyed()) win.webContents.send('java:progress', progress);
      });
      return { ok: true, java: result };
    } catch (err) {
      logger.error('安装 Java 失败:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('skin:list', () => {
    try {
      return skinmanager.list();
    } catch (err) {
      logger.error('读取本地皮肤库失败:', err.message);
      return { ok: false, error: err.message, skins: [], capes: [], activeSkin: '', activeCape: '' };
    }
  });

  ipcMain.handle('skin:import', (event, payload = {}) => {
    try {
      return skinmanager.importData(payload);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('skin:set-active', (event, payload = {}) => {
    try {
      return skinmanager.setActive(payload.kind, payload.id, payload.model);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('skin:clear-active', (event, payload = {}) => {
    try {
      return skinmanager.clearActive(payload.kind);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('skin:remove', (event, payload = {}) => {
    try {
      return skinmanager.remove(payload.kind, payload.id);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('skin:rename', (event, payload = {}) => {
    try {
      return skinmanager.rename(payload.kind, payload.id, payload.name);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('theme:background', () => appearance.background());

  ipcMain.handle('theme:set-background', (event, payload = {}) => {
    try {
      return appearance.setBackgroundData(payload);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('theme:clear-background', () => appearance.clearBackground());

  ipcMain.handle('ui:set-zoom', (event, scale) => {
    try {
      const win = senderWindow(event);
      const factor = Math.max(0.8, Math.min(1.4, Number(scale) || 1));
      if (win && !win.isDestroyed()) win.webContents.setZoomFactor(factor);
      return { ok: true, factor };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('monitor:state', () => monitor.snapshot());

  ipcMain.handle('monitor:kill', () => monitor.kill());

  ipcMain.handle('memory:stats', () => memory.stats());

  ipcMain.handle('memory:clean', async () => {
    if (memoryCleaning) return { ok: false, code: 'BUSY', error: '正在清理内存，请稍候' };
    const skipPids = [process.pid];
    try {
      const metrics = app.getAppMetrics();
      for (const metric of metrics) skipPids.push(Number(metric.pid));
    } catch (err) {
      // 读取不到 Electron 进程列表时仍然可以清理其他进程。
    }
    if (currentLaunch && currentLaunch.pid) skipPids.push(Number(currentLaunch.pid));
    memoryCleaning = memory.clean({
      skipPids,
      tempDir: path.join(config.root(), 'temp'),
      allowSystemWide: !(currentLaunch && currentLaunch.pid),
      elevate: process.env.MINEPILOT_NO_ELEVATE !== '1',
    });
    try {
      const result = await memoryCleaning;
      if (!result.ok) logger.warn('内存清理失败:', result.error);
      else logger.info('内存清理完成:', `mode=${result.mode || 'unknown'}`, `deep=${result.deep === true}`, `admin=${result.admin === true}`, `trimmed=${result.trimmed}`, `freed=${result.freedMb}MB`);
      return result;
    } finally {
      memoryCleaning = null;
    }
  });

  ipcMain.handle('diagnostics:latest', () => {
    try {
      return { ok: true, record: diagnostics.latest(), history: diagnostics.history() };
    } catch (err) {
      return { ok: false, error: err.message, record: null, history: [] };
    }
  });

  ipcMain.handle('diagnostics:get', (event, id) => {
    try {
      return { ok: true, record: diagnostics.get(id) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('diagnostics:history', () => ({ ok: true, history: diagnostics.history() }));

  ipcMain.handle('diagnostics:export', async (event, id) => {
    try {
      const record = diagnostics.get(id);
      if (!record) return { ok: false, error: '没有可导出的诊断记录' };
      const stamp = new Date(record.createdAt || Date.now());
      const date = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}${String(stamp.getSeconds()).padStart(2, '0')}`;
      const result = await dialog.showSaveDialog(senderWindow(event), {
        title: '导出诊断报告',
        defaultPath: path.join(app.getPath('downloads'), `MinePilot-Diagnostic-${date}.zip`),
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      const target = /\.zip$/i.test(result.filePath) ? result.filePath : `${result.filePath}.zip`;
      const exported = diagnostics.exportReport(record, target);
      return Object.assign({ ok: true, diagnosticId: record.id }, exported);
    } catch (err) {
      logger.warn('导出诊断报告失败:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('diagnostics:open-folder', async () => {
    return openDirectory(path.join(config.root(), 'diagnostics'));
  });

  ipcMain.handle('updater:state', () => updater.snapshot());

  ipcMain.handle('updater:check', async () => {
    const state = await updater.check();
    send('update:state', state);
    return state;
  });

  ipcMain.handle('updater:download', async () => {
    try {
      const result = await updater.download();
      const state = updater.snapshot();
      send('update:state', state);
      return Object.assign({ ok: true }, result, { state });
    } catch (err) {
      return { ok: false, error: err.message, state: updater.snapshot() };
    }
  });

  ipcMain.handle('updater:cancel', () => updater.cancel());
  ipcMain.handle('updater:open-downloads', async () => openDirectory(path.join(config.root(), 'updates')));

  ipcMain.handle('plugins:list', () => {
    try { return { ok: true, plugins: plugins.list(), apiVersion: plugins.API_VERSION }; } catch (err) { return { ok: false, error: err.message, plugins: [] }; }
  });

  ipcMain.handle('plugins:source', (event, id) => {
    try { return plugins.source(id); } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('plugins:install', async (event, options = {}) => {
    let filePath = options && options.filePath;
    if (!filePath) {
      const picked = await dialog.showOpenDialog(senderWindow(event), {
        title: '安装 MinePilot 插件',
        properties: ['openFile'],
        filters: [{ name: '插件压缩包', extensions: ['zip'] }],
      });
      if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
      filePath = picked.filePaths[0];
    }
    try {
      return plugins.install(filePath, { overwrite: Boolean(options && options.overwrite), enabled: options.enabled !== false });
    } catch (err) {
      return { ok: false, code: err.code || 'PLUGIN_INSTALL_FAILED', error: err.message, plugin: err.plugin || null, filePath };
    }
  });

  ipcMain.handle('plugins:install-base64', async (event, payload = {}) => {
    let temp = '';
    try {
      const base64 = String(payload.data || '');
      if (!base64 || base64.length > 36 * 1024 * 1024) throw new Error('插件压缩包过大或为空');
      temp = path.join(config.cacheDir(), `plugin-upload-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
      fs.writeFileSync(temp, Buffer.from(base64, 'base64'));
      return plugins.install(temp, { overwrite: Boolean(payload.overwrite), enabled: payload.enabled !== false });
    } catch (err) {
      return { ok: false, code: err.code || 'PLUGIN_INSTALL_FAILED', error: err.message, plugin: err.plugin || null };
    } finally {
      if (temp) { try { fs.rmSync(temp, { force: true }); } catch (err) { /* ignore */ } }
    }
  });

  ipcMain.handle('plugins:set-enabled', (event, id, enabled) => {
    try { return plugins.setEnabled(id, enabled); } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('plugins:remove', (event, id) => {
    try { return plugins.remove(id); } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('plugins:open-folder', async () => openDirectory(plugins.pluginsDir()));

  ipcMain.handle('updater:install', async () => {
    try {
      const target = updater.installTarget();
      if (!target) return { ok: false, error: '还没有下载完成的更新安装包' };
      if (platform.isLinux) {
        try { fs.chmodSync(target, 0o755); } catch (err) { /* ignore */ }
      }
      const error = await shell.openPath(target);
      if (error) return { ok: false, error };
      updater.markInstalled();
      setTimeout(() => { app.quit(); }, 900);
      return { ok: true, path: target, message: '安装程序已启动，MinePilot 即将退出。' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('logs:tail', async (event, filePath) => {
    try {
      const target = filePath || path.join(config.logsDir(), 'minepilot.log');
      const stat = fs.statSync(target);
      const size = Math.min(stat.size, 200 * 1024);
      const fd = fs.openSync(target, 'r');
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, stat.size - size);
      fs.closeSync(fd);
      return { ok: true, text: buffer.toString('utf8') };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('logs:open-folder', async () => openDirectory(config.logsDir()));

  ipcMain.handle('dialog:pick-folder', async (event, options = {}) => {
    const result = await dialog.showOpenDialog(senderWindow(event), {
      title: options.title || '选择文件夹',
      defaultPath: options.defaultPath || settings.get().gameDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-file', async (event, options = {}) => {
    const result = await dialog.showOpenDialog(senderWindow(event), {
      title: options.title || '选择文件',
      defaultPath: options.defaultPath || '',
      properties: ['openFile'],
      filters: options.filters || [{ name: '可执行文件', extensions: ['exe'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('shell:open-path', async (event, target) => openDirectory(target));

  ipcMain.handle('shell:open-external', async (event, url) => openExternalSafe(url));

  ipcMain.on('win:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('win:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.on('win:close', () => {
    if (mainWindow) mainWindow.close();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 1020,
    minHeight: 660,
    frame: false,
    show: false,
    backgroundColor: '#0b0e14',
    title: 'MinePilot',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'MinePilot.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.executeJavaScript('window.__mpErrors = []; window.addEventListener("error", (event) => { window.__mpErrors.push(String(event.message || event.error)); }); window.addEventListener("unhandledrejection", (event) => { window.__mpErrors.push(String(event.reason && event.reason.message || event.reason)); }); true;').catch(() => {});
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), initialView ? { query: { view: initialView } } : undefined);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isShot) captureScreenshot();
  });

  const notifyState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('win:state', { maximized: mainWindow.isMaximized() });
    }
  };
  mainWindow.on('maximize', notifyState);
  mainWindow.on('unmaximize', notifyState);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      openExternalSafe(url).catch((err) => logger.warn('打开窗口链接失败:', err.message));
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
}

async function captureScreenshot() {
  try {
    await new Promise((resolve) => setTimeout(resolve, 2600));
    if (dumpTarget) {
      try {
        await mainWindow.webContents.executeJavaScript(`window.__mpClickPlugin = ${clickPlugin ? 'true' : 'false'}; window.__mpClickUpdate = ${clickUpdate ? 'true' : 'false'}; window.__mpToggleOnline = ${toggleOnline ? 'true' : 'false'}; true;`);
        const data = await mainWindow.webContents.executeJavaScript(`(async () => {
          const q = (id) => document.getElementById(id);
          const rect = (id) => { const node = q(id); if (!node) return null; const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility }; };
          const text = (id) => { const node = q(id); return node ? node.textContent.trim().slice(0, 500) : null; };
          if (window.__mpToggleOnline) {
            const toggle = q('set-online-downloads');
            if (toggle && !toggle.checked) {
              toggle.click();
              await new Promise((resolve) => setTimeout(resolve, 900));
            }
          }
          if (window.__mpClickUpdate) {
            const button = q('btn-check-update');
            if (button) {
              button.click();
              await new Promise((resolve) => setTimeout(resolve, 700));
            }
          }
          if (window.__mpClickPlugin) {
            const button = document.querySelector('#plugin-commands .plugin-command');
            if (button) {
              button.click();
              await new Promise((resolve) => setTimeout(resolve, 500));
              window.__pluginClick = { toast: Array.from(document.querySelectorAll('#toasts .toast')).map((node) => node.textContent), clicked: true };
            } else {
              window.__pluginClick = { toast: [], clicked: false };
            }
          }
          return {
            title: document.title,
            view: window.MP && MP.state ? MP.state.view : null,
            body: { scrollWidth: document.body.scrollWidth, clientWidth: document.body.clientWidth, scrollHeight: document.body.scrollHeight, clientHeight: document.body.clientHeight },
            text: document.body.innerText.slice(0, 20000),
            diagnostics: {
              emptyHidden: q('diag-empty') ? q('diag-empty').classList.contains('hidden') : null,
              contentHidden: q('diag-content') ? q('diag-content').classList.contains('hidden') : null,
              title: text('diag-title'), summary: text('diag-summary'), exitCode: text('diag-exit-code'), duration: text('diag-duration'),
              causes: document.querySelectorAll('#diag-causes .diag-cause').length,
              suggestions: document.querySelectorAll('#diag-suggestions li').length,
              logChars: q('diag-log') ? q('diag-log').textContent.length : null,
              hero: rect('diag-hero'), log: rect('diag-log'), history: document.querySelectorAll('#diag-history .diag-history-row').length,
            },
            download: {
              online: window.MP && MP.state.settings ? Boolean(MP.state.settings.onlineDownloads) : null,
              noticeHidden: q('dl-offline-notice') ? q('dl-offline-notice').classList.contains('hidden') : null,
              settingsToggle: q('set-online-downloads') ? q('set-online-downloads').checked : null,
              listText: text('dl-list'),
              searchDisabled: q('dl-search') ? q('dl-search').disabled : null,
            },
            settings: {
              feed: q('set-update-feed') ? q('set-update-feed').value : null,
              language: window.MP && MP.state.settings ? MP.state.settings.language : null,
              htmlLang: document.documentElement.lang,
              navHome: document.querySelector('.nav-item[data-view="home"] span') ? document.querySelector('.nav-item[data-view="home"] span').textContent.trim() : null,
              navSettings: document.querySelector('.nav-item[data-view="settings"] span') ? document.querySelector('.nav-item[data-view="settings"] span').textContent.trim() : null,
              languageSelect: q('set-language') ? q('set-language').value : null,
              pageTitle: document.querySelector('#view-home h1') ? document.querySelector('#view-home h1').textContent.trim() : null,
              memoryAuto: q('set-memory-auto') ? q('set-memory-auto').checked : null,
              memoryDisabled: q('set-memory') ? q('set-memory').disabled : null,
              memoryValue: q('set-memory') ? Number(q('set-memory').value) : null,
              memoryLabel: text('memory-value'),
              memoryAutoHint: text('memory-auto-hint'),
              memoryTotalHint: text('memory-total-hint'),
              memoryOptimize: q('set-memory-optimize') ? q('set-memory-optimize').checked : null,
              memoryOptimizeHint: text('memory-optimize-hint'),
              cleanerPercent: text('cleaner-percent'),
              cleanerDetail: text('cleaner-detail'),
              cleanerHead: text('settings-memory-text'),
              cleanerTopDisabled: q('btn-clean-memory-top') ? q('btn-clean-memory-top').disabled : null,
              cleanerResult: text('cleaner-result'),
              cleanerDisabled: q('btn-clean-memory') ? q('btn-clean-memory').disabled : null,
              cleanerCard: rect('memory-cleaner-card'),
              cleanerButton: rect('btn-clean-memory'),
              updateStatus: text('update-status-text'),
              pluginRows: document.querySelectorAll('#plugin-list .plugin-row').length,
              pluginCommands: document.querySelectorAll('#plugin-commands .plugin-command').length,
              pluginText: text('plugin-list'),
              updateCard: rect('view-settings') ? true : null,
            },
            errors: window.__mpErrors || [],
            pluginClick: window.__pluginClick || null,
            updateStatus: text('update-status-text'),
            aboutStatus: text('about-update-status'),
            updateNotes: text('about-update-notes-text'),
          };
        })()`);
        fs.writeFileSync(dumpTarget, JSON.stringify(data, null, 2), 'utf8');
        console.log('DUMP_SAVED', dumpTarget);
      } catch (err) {
        console.error('DUMP_FAILED', err.message);
      }
    }
    const image = await mainWindow.webContents.capturePage();
    fs.writeFileSync(shotTarget, image.toPNG());
    console.log('SHOT_SAVED', shotTarget);
  } catch (err) {
    console.error('SHOT_FAILED', err.message);
  } finally {
    app.quit();
  }
}

app.whenReady().then(() => {
  const dataRoot = envDataDir || portableHome || app.getPath('userData');
  config.init(dataRoot);
  logger.info('MinePilot 启动，数据目录:', dataRoot);
  updater.configure({
    currentVersion: app.getVersion(),
    downloadsDir: path.join(config.root(), 'updates'),
    onProgress: (progress) => send('update:progress', progress),
  });
  registerIpc();

  createWindow();

  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      if (!settings.get().autoCheckUpdates) return;
      const state = await updater.check();
      send('update:state', state);
    }, 1500);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

process.on('uncaughtException', (err) => {
  logger.error('未捕获异常:', err.stack || err.message);
});
process.on('unhandledRejection', (err) => {
  logger.error('未处理的 Promise 拒绝:', err && (err.stack || err.message));
});