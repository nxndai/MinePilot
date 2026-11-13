'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, safeStorage } = require('electron');
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
const uninstall = require('./src/core/uninstall');
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
const savesCore = require('./src/core/saves');
const modsCore = require('./src/core/mods');
const modmanager = require('./src/core/modmanager');
const modpack = require('./src/core/modpack');
const mojang = require('./src/core/mojang');
const installer = require('./src/core/installer');
const launcher = require('./src/core/launcher');
const javaCore = require('./src/core/java');
const loaders = require('./src/core/loaders');
const accounts = require('./src/core/accounts');
const auth = require('./src/core/auth');
const microsoft = require('./src/core/microsoft');
const skinmanager = require('./src/core/skinmanager');
const appearance = require('./src/core/appearance');
const monitor = require('./src/core/monitor');
const memory = require('./src/core/memory');
const platform = require('./src/core/platform');
const diagnostics = require('./src/core/diagnostics');
const updater = require('./src/core/updater');
const plugins = require('./src/core/plugins');
const content = require('./src/core/content');
const netplay = require('./src/core/netplay');

// 桌面版把 Microsoft 令牌交给 Chromium 的系统安全存储加密，而不是直接
// 写入明文 accounts.json。safeStorage 在 Linux 缺少钥匙串时 may return false，
// accounts 模块会自动退回明文并在界面上给出警告。
accounts.setSecureStore({
  backend: 'Electron safeStorage',
  isAvailable: () => {
    try { return safeStorage.isEncryptionAvailable(); } catch (err) { return false; }
  },
  encrypt: (value) => safeStorage.encryptString(String(value)).toString('base64'),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(String(value), 'base64')),
});

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

/**
 * 切换账户时同步 authMode / offlineName，并广播一次状态，保证所有页面
 * 使用与启动游戏相同的账户。账户存储本身仍是唯一事实来源。
 */
function applyAccountSelection(account) {
  const patch = account && account.type === 'microsoft'
    ? { authMode: 'microsoft' }
    : { authMode: 'offline', offlineName: (account && account.name) || settings.get().offlineName };
  const next = settings.update(patch);
  const payload = { mode: next.authMode, microsoft: accounts.summary() };
  send('settings:changed', next);
  send('auth:changed', payload);
  return { next, payload };
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
    else diagnostics.clearLatest();
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

  ipcMain.handle('app:remove', async () => {
    if (process.platform !== 'win32') {
      return { ok: false, error: '仅 Windows 支持删除启动器' };
    }
    if (!app.isPackaged) {
      return { ok: false, error: '开发模式下不能删除启动器' };
    }
    const appDir = path.dirname(process.execPath);
    try {
      const uninstaller = path.join(appDir, 'Uninstall.exe');
      if (fs.existsSync(uninstaller)) {
        // 新版卸载器支持 /WAITPID：等启动器退出后再删除，避免 IPC 还没返回
        // 就把窗口强制结束。它同样只删除程序、快捷方式和卸载登记，保留 data。
        const child = spawn(uninstaller, ['/S', `/WAITPID=${process.pid}`], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        const started = await new Promise((resolve) => {
          child.once('spawn', () => resolve(true));
          child.once('error', (err) => {
            logger.error('启动卸载程序失败:', err.message);
            resolve(false);
          });
        });
        if (!started) return { ok: false, error: '无法启动卸载程序，请稍后重试' };
        child.unref();
        logger.info('已启动卸载程序:', uninstaller);
        setTimeout(() => { app.quit(); }, 700);
        return { ok: true, mode: 'uninstaller', appDir, dataDir: config.root() };
      }

      const result = uninstall.scheduleRemoval({
        appDir,
        dataDir: config.root(),
        scriptDir: path.join(config.root(), 'uninstall'),
        pid: process.pid,
        // 自动化删除测试时不能动真实的桌面快捷方式和卸载登记。
        cleanShell: process.env.MINEPILOT_TEST_KEEP_SHELL !== '1',
      });
      if (!result.ok) return result;
      logger.info('已安排删除启动器:', appDir, result.scriptPath);
      // 先让 IPC 结果返回，再退出，给清理脚本留出启动时间。
      setTimeout(() => { app.quit(); }, 800);
      return { ok: true, mode: 'script', appDir, dataDir: config.root() };
    } catch (err) {
      logger.error('安排删除启动器失败:', err.stack || err.message);
      return { ok: false, error: err.message };
    }
  });

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

  ipcMain.handle('auth:accounts', () => ({
    ok: true,
    activeId: accounts.summary().activeId || '',
    accounts: accounts.list(),
    encryption: accounts.encryptionInfo(),
  }));

  ipcMain.handle('auth:select', (event, id) => {
    try {
      const account = accounts.select(String(id || ''));
      const { next, payload } = applyAccountSelection(account);
      return { ok: true, account, mode: next.authMode, microsoft: payload.microsoft };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('auth:add-offline', (event, payload) => {
    try {
      const account = accounts.addOffline(payload && payload.name, payload && payload.note);
      const { next, payload: changed } = applyAccountSelection(account);
      return { ok: true, account, mode: next.authMode, microsoft: changed.microsoft };
    } catch (err) {
      return { ok: false, code: err.code || 'BAD_NAME', error: err.message };
    }
  });

  ipcMain.handle('auth:update-account', (event, payload) => {
    try {
      const account = accounts.updateAccount(String(payload && payload.id || ''), { note: payload && payload.note });
      send('auth:changed', { mode: settings.get().authMode, microsoft: accounts.summary() });
      return { ok: true, account };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('auth:remove-account', (event, id) => {
    try {
      const result = accounts.removeAccount(String(id || ''));
      if (!result.ok) return result;
      const store = accounts.list();
      const nextAccount = store.find((item) => item.active) || null;
      if (nextAccount) applyAccountSelection(nextAccount);
      else {
        const next = settings.update({ authMode: 'offline' });
        send('settings:changed', next);
        send('auth:changed', { mode: next.authMode, microsoft: accounts.summary() });
      }
      return { ok: true, activeId: result.activeId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

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
      const result = await accounts.refreshActive();
      send('auth:changed', { mode: s.authMode, microsoft: accounts.summary() });
      return { ok: true, account: result.account };
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

  async function versionTarget(versionId) {
    const s = settings.get();
    const id = String(versionId || s.lastVersion || '').trim();
    if (!id) {
      const error = new Error('请先选择目标版本');
      error.code = 'NO_TARGET';
      throw error;
    }
    const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
    const target = list.find((version) => version.id === id);
    if (!target) {
      const error = new Error('目标版本不存在，请刷新版本列表');
      error.code = 'NO_TARGET';
      throw error;
    }
    return target;
  }

  function saveError(err) {
    return { ok: false, code: err.code || 'SAVE_FAILED', error: err.message };
  }

  ipcMain.handle('saves:list', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      const result = savesCore.list(target);
      return Object.assign(result, {
        instance: {
          id: target.id,
          mcVersion: target.mcVersion || '',
          isolation: Boolean(target.isolation),
          gameDir: target.gameDir,
        },
      });
    } catch (err) {
      logger.warn('读取存档列表失败:', err.message);
      return saveError(err);
    }
  });

  ipcMain.handle('saves:backups', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      return {
        ok: true,
        targetVersionId: target.id,
        backupsDir: savesCore.backupsDir(target),
        backups: savesCore.listBackups(target),
      };
    } catch (err) {
      return saveError(err);
    }
  });

  ipcMain.handle('saves:backup', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      return savesCore.backup(target, String(payload.world || ''));
    } catch (err) {
      logger.warn('备份存档失败:', err.message);
      return saveError(err);
    }
  });

  ipcMain.handle('saves:restore', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      const result = savesCore.restore(target, String(payload.file || ''), {
        overwrite: Boolean(payload.overwrite),
        folder: payload.folder ? String(payload.folder) : '',
      });
      return Object.assign(result, {
        saves: savesCore.list(target).saves,
        backups: savesCore.listBackups(target),
      });
    } catch (err) {
      logger.warn('恢复存档失败:', err.message);
      return saveError(err);
    }
  });

  ipcMain.handle('saves:delete', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      return Object.assign(savesCore.remove(target, String(payload.world || ''), {
        backup: payload.backup !== false,
      }), {
        saves: savesCore.list(target).saves,
        backups: savesCore.listBackups(target),
      });
    } catch (err) {
      logger.warn('删除存档失败:', err.message);
      return saveError(err);
    }
  });

  ipcMain.handle('saves:export', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      const result = await dialog.showSaveDialog(senderWindow(event), {
        title: '导出存档',
        defaultPath: path.join(settings.get().gameDir, `${payload.world || 'world'}.zip`),
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      return savesCore.exportWorld(target, String(payload.world || ''), result.filePath);
    } catch (err) {
      logger.warn('导出存档失败:', err.message);
      return saveError(err);
    }
  });

  ipcMain.handle('saves:import', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      let filePath = String(payload.path || '').trim();
      if (!filePath) {
        const picked = await dialog.showOpenDialog(senderWindow(event), {
          title: '导入存档 ZIP',
          defaultPath: settings.get().gameDir,
          properties: ['openFile'],
          filters: [{ name: '存档 ZIP', extensions: ['zip'] }],
        });
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
        filePath = picked.filePaths[0];
      }
      const result = savesCore.importWorld(target, filePath, {
        overwrite: Boolean(payload.overwrite),
      });
      return Object.assign(result, {
        saves: savesCore.list(target).saves,
        backups: savesCore.listBackups(target),
      });
    } catch (err) {
      logger.warn('导入存档失败:', err.message);
      return saveError(err);
    }
  });

  ipcMain.handle('saves:open-folder', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      const dir = payload.backups ? savesCore.backupsDir(target) : savesCore.savesDir(target);
      const error = await shell.openPath(dir);
      if (error) return { ok: false, error };
      return { ok: true, path: dir };
    } catch (err) {
      return saveError(err);
    }
  });

  ipcMain.handle('content:list', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      const type = String(payload.type || 'resourcepack');
      const items = content.list(target, type, { world: payload.world ? String(payload.world) : '' });
      return {
        ok: true,
        type,
        items,
        worlds: content.listWorlds(target.gameDir),
        instance: {
          id: target.id,
          mcVersion: target.mcVersion || '',
          isolation: Boolean(target.isolation),
          gameDir: target.gameDir,
        },
      };
    } catch (err) {
      logger.warn('读取内容列表失败:', err.message);
      return { ok: false, code: err.code || 'CONTENT_LIST_FAILED', error: err.message };
    }
  });

  ipcMain.handle('content:preview', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      return content.preview(target, String(payload.type || ''), String(payload.id || ''), { world: payload.world ? String(payload.world) : '' });
    } catch (err) {
      return { ok: false, code: err.code || 'CONTENT_PREVIEW_FAILED', error: err.message };
    }
  });

  ipcMain.handle('content:set-enabled', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      return content.setEnabled(
        target,
        String(payload.type || ''),
        String(payload.id || ''),
        Boolean(payload.enabled),
        { world: payload.world ? String(payload.world) : '' },
      );
    } catch (err) {
      return { ok: false, code: err.code || 'CONTENT_TOGGLE_FAILED', error: err.message };
    }
  });

  ipcMain.handle('content:import', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      let filePath = String(payload.path || '').trim();
      if (!filePath) {
        const picked = await dialog.showOpenDialog(senderWindow(event), {
          title: '导入游戏内容',
          defaultPath: settings.get().gameDir,
          properties: ['openFile'],
          filters: [{ name: 'ZIP 内容包', extensions: ['zip'] }],
        });
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
        filePath = picked.filePaths[0];
      }
      return content.importFile(target, String(payload.type || ''), filePath, {
        overwrite: Boolean(payload.overwrite),
        name: payload.name ? String(payload.name) : '',
      });
    } catch (err) {
      return { ok: false, code: err.code || 'CONTENT_IMPORT_FAILED', error: err.message };
    }
  });

  ipcMain.handle('content:import-base64', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      const base64 = String(payload.data || '').replace(/^data:[^;]+;base64,/, '');
      if (!base64) return { ok: false, code: 'EMPTY_FILE', error: '上传的内容文件为空' };
      if (base64.length > 280 * 1024 * 1024) {
        return { ok: false, code: 'CONTENT_TOO_LARGE', error: '内容包超过桌面版上传上限（约 200 MB）' };
      }
      return content.importBuffer(target, String(payload.type || ''), Buffer.from(base64, 'base64'), String(payload.name || 'content.zip'), {
        overwrite: Boolean(payload.overwrite),
      });
    } catch (err) {
      return { ok: false, code: err.code || 'CONTENT_IMPORT_FAILED', error: err.message };
    }
  });

  ipcMain.handle('content:remove', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      return content.remove(target, String(payload.type || ''), String(payload.id || ''), {
        world: payload.world ? String(payload.world) : '',
      });
    } catch (err) {
      return { ok: false, code: err.code || 'CONTENT_REMOVE_FAILED', error: err.message };
    }
  });

  ipcMain.handle('content:open-folder', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      const dir = content.openDir(target, String(payload.type || ''));
      const error = await shell.openPath(dir);
      if (error) return { ok: false, error };
      return { ok: true, path: dir };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('content:search', async (event, payload = {}) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    try {
      const target = await versionTarget(payload.targetVersionId);
      const result = await content.searchModrinth(target, String(payload.type || ''), {
        query: String(payload.query || ''),
        gameVersion: payload.gameVersion ? String(payload.gameVersion) : '',
        limit: payload.limit,
        offset: payload.offset,
      });
      return Object.assign({ ok: true }, result);
    } catch (err) {
      return { ok: false, code: err.code || 'CONTENT_SEARCH_FAILED', error: err.message };
    }
  });

  ipcMain.handle('content:install', async (event, payload = {}) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    try {
      const target = await versionTarget(payload.targetVersionId);
      const type = String(payload.type || '');
      const result = await content.installModrinth(target, type, {
        projectId: String(payload.projectId || ''),
        versionId: payload.versionId ? String(payload.versionId) : '',
        gameVersion: payload.gameVersion ? String(payload.gameVersion) : '',
        enable: Boolean(payload.enable),
      }, {
        onProgress: (progress) => send('content:progress', Object.assign({
          type,
          projectId: String(payload.projectId || ''),
          targetVersionId: target.id,
        }, progress)),
      });
      send('content:done', Object.assign({ type, targetVersionId: target.id }, result));
      return result;
    } catch (err) {
      logger.warn('安装游戏内容失败:', err.message);
      const failure = { ok: false, code: err.code || 'CONTENT_INSTALL_FAILED', error: err.message };
      send('content:error', failure);
      return failure;
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
      if (Number(result.totalHits) === 0) {
        logger.warn(`模组搜索无结果: source=${source} gameVersion=${result.gameVersion || '-'} loader=${result.loader || '-'} query=${JSON.stringify(result.query || '')} category=${result.category || '-'}`);
      } else {
        logger.info(`模组搜索: source=${source} gameVersion=${result.gameVersion || '-'} loader=${result.loader || '-'} query=${JSON.stringify(result.query || '')} total=${result.totalHits}`);
      }
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
        includeOptional: Boolean(request.includeOptional),
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

  ipcMain.handle('mods:updates', async (event, payload = {}) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    const targetVersionId = String((payload && payload.targetVersionId) || '').trim();
    if (!targetVersionId) return { ok: false, code: 'NO_TARGET', error: '请先选择目标版本' };
    try {
      const s = settings.get();
      const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
      const target = list.find((version) => version.id === targetVersionId);
      if (!target) return { ok: false, code: 'NO_TARGET', error: '目标版本不存在，请刷新版本列表' };
      const installed = modmanager.list(target);
      const result = await modsCore.checkUpdates({
        target,
        mods: installed.mods,
        gameVersion: target.mcVersion,
        loader: modsCore.loaderForVersion(target),
      });
      return Object.assign({ ok: true }, result);
    } catch (err) {
      logger.warn('检查模组更新失败:', err.message);
      return { ok: false, code: err.code || 'MOD_UPDATE_CHECK_FAILED', error: err.message };
    }
  });

  ipcMain.handle('mods:set-enabled-many', async (event, payload = {}) => {
    const targetVersionId = String((payload && payload.targetVersionId) || '').trim();
    const filenames = Array.isArray(payload && payload.filenames) ? payload.filenames : [];
    const enabled = Boolean(payload && payload.enabled);
    if (!targetVersionId) return { ok: false, code: 'NO_TARGET', error: '请先选择目标版本' };
    if (!filenames.length || filenames.length > 500) {
      return { ok: false, code: 'BAD_MOD_FILE', error: '请选择要批量操作的模组' };
    }
    try {
      const s = settings.get();
      const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
      const target = list.find((version) => version.id === targetVersionId);
      if (!target) return { ok: false, code: 'NO_TARGET', error: '目标版本不存在，请刷新版本列表' };
      const changed = [];
      const failed = [];
      for (const raw of filenames) {
        const filename = String(raw || '').trim();
        if (!filename) continue;
        try {
          const result = modmanager.setEnabled(target, filename, enabled);
          if (result && result.changed) changed.push(filename);
        } catch (err) {
          failed.push({ filename, error: err.message });
        }
      }
      return {
        ok: failed.length === 0,
        changed,
        failed,
        enabled,
        list: modmanager.list(target),
      };
    } catch (err) {
      logger.warn('批量切换模组状态失败:', err.message);
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
        mode: payload && payload.mode === 'new' ? 'new' : 'current',
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

  ipcMain.handle('modpack:download', async (event, payload = {}) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    if (packImporting) return { ok: false, code: 'BUSY', error: '已有整合包正在导入，请稍候' };
    const request = payload || {};
    const url = String(request.url || '').trim();
    const title = String(request.title || '').trim();
    if (!url) return { ok: false, code: 'BAD_PACK_URL', error: '缺少整合包下载地址' };
    const controller = new AbortController();
    packImporting = { filePath: url, targetVersionId: '', controller };
    try {
      const result = await modpack.installFromUrl({
        url,
        sha1: request.sha1 ? String(request.sha1) : '',
        filename: request.filename ? String(request.filename) : '',
        size: Number(request.size) || 0,
        signal: controller.signal,
        onProgress: (progress) => send('modpack:progress', Object.assign({ title }, progress)),
      });
      send('modpack:done', result);
      return result;
    } catch (err) {
      logger.warn('在线整合包下载失败:', err.message);
      const canceled = controller.signal.aborted;
      const failure = {
        ok: false,
        code: canceled ? 'CANCELED' : (err.code || 'PACK_DOWNLOAD_FAILED'),
        error: canceled ? '已取消下载' : err.message,
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
    const mcVersion = String(payload.mcVersion || '').trim();
    const type = ['fabric', 'forge', 'neoforge', 'quilt'].includes(payload.type) ? payload.type : 'fabric';
    try {
      if (!mcVersion) return { ok: false, error: '缺少 Minecraft 版本号' };
      const loadersByType = {
        fabric: loaders.fabricVersions,
        forge: loaders.forgeVersions,
        neoforge: loaders.neoForgeVersions,
        quilt: loaders.quiltVersions,
      };
      const list = await loadersByType[type](mcVersion);
      logger.info('加载器版本查询:', `${type} ${mcVersion}`, '可选', list.length);
      return { ok: true, type, mcVersion, versions: list };
    } catch (err) {
      logger.warn('加载器版本查询失败:', `${type} ${mcVersion}`, err.message);
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
    const pick = await javaCore.pickFor(required, s.javaPath, false, versionId);
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

  ipcMain.handle('java:install', async (event, payload) => {
    try {
      requireOnlineDownloads();
      const request = payload && typeof payload === 'object' ? payload : { major: payload };
      const win = senderWindow(event);
      const result = await javaCore.installJava(Number(request.major) || 21, (progress) => {
        if (win && !win.isDestroyed()) win.webContents.send('java:progress', progress);
      }, null, { vendor: request.vendor });
      return { ok: true, java: result };
    } catch (err) {
      logger.error('安装 Java 失败:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('java:add-path', async (event, payload = {}) => {
    let target = String((payload && payload.path) || '').trim();
    if (!target) {
      const result = await dialog.showOpenDialog(senderWindow(event), {
        title: '选择 Java 可执行文件或安装目录',
        properties: ['openFile'],
        filters: platform.isWindows
          ? [{ name: 'Java 可执行文件', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }]
          : [{ name: '所有文件', extensions: ['*'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
      target = result.filePaths[0];
    }
    try {
      if (fs.statSync(target).isDirectory()) target = javaCore.findJavaExe(target) || target;
    } catch (err) { /* 交给 inspect 处理 */ }
    const info = javaCore.inspect(target);
    if (!info) return { ok: false, code: 'BAD_JAVA', error: '这个文件不是可用的 Java 可执行文件' };
    const s = settings.get();
    const extra = Array.from(new Set([...(s.javaExtraPaths || []), info.path]));
    const ignore = (s.javaIgnorePaths || []).filter((item) => path.resolve(item) !== path.resolve(info.path));
    settings.update({ javaExtraPaths: extra, javaIgnorePaths: ignore, javaPath: info.path });
    const list = await javaCore.detect(true);
    return { ok: true, java: info, list, message: `已添加 Java ${info.major}（${info.vendor}）并设为默认` };
  });

  ipcMain.handle('java:remove-path', async (event, payload = {}) => {
    const target = String((payload && payload.path) || '').trim();
    if (!target) return { ok: false, error: '缺少 Java 路径' };
    const resolved = path.resolve(target);
    const s = settings.get();
    const extra = (s.javaExtraPaths || []).filter((item) => path.resolve(item) !== resolved);
    const ignore = Array.from(new Set([...(s.javaIgnorePaths || []), resolved]));
    const patch = { javaExtraPaths: extra, javaIgnorePaths: ignore };
    const overrides = {};
    for (const [versionId, javaPath] of Object.entries(s.javaVersionOverrides || {})) {
      if (path.resolve(String(javaPath || '')) !== resolved) overrides[versionId] = javaPath;
    }
    patch.javaVersionOverrides = overrides;
    if (s.javaPath && path.resolve(s.javaPath) === resolved) patch.javaPath = '';
    settings.update(patch);
    const list = await javaCore.detect(true);
    return { ok: true, list, message: '已从列表中隐藏该 Java，不会删除磁盘文件' };
  });

  ipcMain.handle('java:vendors', () => ({ ok: true, vendors: Object.values(javaCore.JAVA_VENDORS) }));
  ipcMain.handle('java:open-folder', async () => openDirectory(config.runtimeDir()));

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

  ipcMain.handle('skin:apply', async () => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    try {
      const s = settings.get();
      if (s.authMode !== 'microsoft') {
        return {
          ok: false,
          code: 'OFFLINE_SKIN',
          error: '离线账户没有 Mojang 皮肤档案，游戏内不会显示本地皮肤。请登录 Microsoft 正版账户，或安装支持本地皮肤的模组。',
        };
      }
      const active = skinmanager.activeSkinPayload();
      const profile = await accounts.profileFor(s);
      const uploaded = await accounts.uploadSkin(profile.accessToken, active.buffer, active.model);
      const account = accounts.updateActiveSkin(uploaded);
      logger.info('本地皮肤已上传到 Microsoft 账户:', profile.name, active.name);
      return { ok: true, account };
    } catch (err) {
      logger.warn('上传本地皮肤失败:', err.message);
      return { ok: false, code: err.code || 'SKIN_APPLY_FAILED', error: err.message };
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

  ipcMain.handle('diagnostics:share', async (event, id) => {
    try {
      const record = diagnostics.get(id);
      if (!record) return { ok: false, error: '没有可分享的诊断记录' };
      const text = diagnostics.shareMarkdown(record);
      clipboard.writeText(text);
      return {
        ok: true,
        copied: true,
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
        note: '已复制脱敏摘要。公开分享前仍请检查是否包含不想公开的信息。',
      };
    } catch (err) {
      logger.warn('生成诊断分享摘要失败:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('diagnostics:action', async (event, payload = {}) => {
    const record = diagnostics.get(String((payload && payload.id) || ''));
    if (!record) return { ok: false, error: '诊断记录不存在' };
    const actionId = String((payload && payload.actionId) || '');
    if (actionId !== 'disable-optifine') {
      return { ok: false, code: 'UNKNOWN_ACTION', error: '不支持这个诊断操作' };
    }
    const versionId = String(record.versionId || '').trim();
    if (!versionId) return { ok: false, code: 'NO_TARGET', error: '诊断记录没有关联游戏版本' };
    try {
      const s = settings.get();
      const versions = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
      const target = versions.find((version) => version.id === versionId);
      if (!target) return { ok: false, code: 'NO_TARGET', error: '诊断对应的游戏版本已不存在' };
      const list = modmanager.list(target);
      const targets = list.mods.filter((mod) => mod.enabled
        && /optifine/i.test([mod.name, mod.modId, mod.filename].filter(Boolean).join(' ')));
      if (!targets.length) {
        return { ok: false, code: 'NOT_FOUND', error: '当前实例没有找到已启用的 OptiFine 文件' };
      }
      const changed = [];
      for (const mod of targets) {
        const result = modmanager.setEnabled(target, mod.filename, false);
        if (result && result.changed) changed.push(mod.filename);
      }
      return {
        ok: true,
        actionId,
        changed,
        count: changed.length,
        list: modmanager.list(target),
        message: `已禁用 ${changed.length} 个 OptiFine 文件，重新启动游戏即可验证。`,
      };
    } catch (err) {
      logger.warn('执行诊断修复操作失败:', err.message);
      return { ok: false, code: err.code || 'DIAG_ACTION_FAILED', error: err.message };
    }
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

  ipcMain.handle('plugins:inspect', async (event, options = {}) => {
    let filePath = String(options && options.filePath || '').trim();
    if (!filePath) {
      const picked = await dialog.showOpenDialog(senderWindow(event), {
        title: '选择 MinePilot 插件',
        properties: ['openFile'],
        filters: [{ name: '插件压缩包', extensions: ['zip'] }],
      });
      if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
      filePath = picked.filePaths[0];
    }
    try {
      return Object.assign({ ok: true }, plugins.inspect(filePath));
    } catch (err) {
      return { ok: false, code: err.code || 'PLUGIN_INSPECT_FAILED', error: err.message };
    }
  });

  ipcMain.handle('plugins:inspect-base64', async (event, payload = {}) => {
    let temp = '';
    try {
      const base64 = String(payload.data || '');
      if (!base64 || base64.length > 36 * 1024 * 1024) throw new Error('插件压缩包过大或为空');
      temp = path.join(config.cacheDir(), `plugin-inspect-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
      fs.writeFileSync(temp, Buffer.from(base64, 'base64'));
      return Object.assign({ ok: true }, plugins.inspect(temp));
    } catch (err) {
      return { ok: false, code: err.code || 'PLUGIN_INSPECT_FAILED', error: err.message };
    } finally {
      if (temp) { try { fs.rmSync(temp, { force: true }); } catch (err) { /* ignore */ } }
    }
  });

  ipcMain.handle('plugins:market', async (event, payload = {}) => {
    try {
      const s = settings.get();
      const url = String(payload.url || s.pluginIndexUrl || '').trim();
      return await plugins.marketIndex(url);
    } catch (err) {
      return { ok: false, code: err.code || 'PLUGIN_MARKET_FAILED', error: err.message };
    }
  });

  ipcMain.handle('plugins:market-install', async (event, payload = {}) => {
    try {
      const entry = payload && payload.entry;
      if (!entry) return { ok: false, error: '缺少插件索引条目' };
      return await plugins.installFromMarket(entry, { overwrite: Boolean(payload.overwrite) });
    } catch (err) {
      return { ok: false, code: err.code || 'PLUGIN_INSTALL_FAILED', error: err.message, plugin: err.plugin || null };
    }
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

  ipcMain.handle('netplay:state', async () => ({
    ok: true,
    profiles: netplay.profiles(settings.get()),
    processes: netplay.snapshot(),
    addresses: netplay.localAddresses(),
    guides: netplay.guides(),
    platform: process.platform,
  }));

  ipcMain.handle('netplay:start', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      const profile = netplay.profiles(settings.get()).find((item) => item.id === String(payload.id || ''));
      if (!profile) return { ok: false, error: '联机配置不存在，请先保存配置' };
      const win = senderWindow(event);
      const emit = (message) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send(message.type === 'log' ? 'netplay:log' : 'netplay:state', message.payload);
        }
      };
      const result = netplay.start(profile, {
        gameDir: target.gameDir || target.dir || '',
        player: settings.get().offlineName || '',
      }, emit);
      return Object.assign({ ok: true }, result, { addresses: netplay.localAddresses() });
    } catch (err) {
      logger.warn('启动联机工具失败:', err.message);
      return { ok: false, code: err.code || 'NETPLAY_START_FAILED', error: err.message };
    }
  });

  ipcMain.handle('netplay:stop', async (event, id) => netplay.stop(String(id || '')));
  ipcMain.handle('netplay:logs', async (event, id) => ({ ok: true, logs: netplay.logs(String(id || '')) }));

  ipcMain.handle('netplay:browse', async (event) => {
    const picked = await dialog.showOpenDialog(senderWindow(event), {
      title: '选择联机工具可执行文件',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: '可执行程序', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }]
        : [{ name: '所有文件', extensions: ['*'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, filePath: picked.filePaths[0] };
  });

  ipcMain.handle('netplay:check-ports', async (event, payload = {}) => {
    try {
      return await netplay.checkPorts({ port: payload.port });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('netplay:share', async (event, payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      const profile = netplay.profiles(settings.get()).find((item) => item.id === String(payload.id || ''));
      if (!profile) return { ok: false, error: '联机配置不存在，请先保存配置' };
      return netplay.buildShareText(profile, {
        gameDir: target.gameDir || target.dir || '',
        player: settings.get().offlineName || '',
        port: payload.port,
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('netplay:export-profiles', async (event) => {
    const list = netplay.profiles(settings.get());
    if (!list.length) return { ok: false, error: '还没有可导出的联机配置' };
    const picked = await dialog.showSaveDialog(senderWindow(event), {
      title: '导出联机配置',
      defaultPath: path.join(app.getPath('documents'), 'minepilot-netplay.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    try {
      const data = netplay.exportProfiles(list);
      fs.writeFileSync(picked.filePath, JSON.stringify(data, null, 2), 'utf8');
      return { ok: true, filePath: picked.filePath, count: data.profiles.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('netplay:import-profiles', async (event) => {
    const picked = await dialog.showOpenDialog(senderWindow(event), {
      title: '导入联机配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    try {
      const raw = fs.readFileSync(picked.filePaths[0], 'utf8');
      const result = netplay.importProfiles(raw);
      const existing = netplay.profiles(settings.get()).slice();
      let added = 0;
      let replaced = 0;
      for (const profile of result.profiles) {
        const index = existing.findIndex((item) => item.id === profile.id);
        if (index >= 0) {
          existing[index] = profile;
          replaced += 1;
        } else {
          existing.push(profile);
          added += 1;
        }
      }
      settings.update({ netplayProfiles: existing.slice(0, 50) });
      return { ok: true, added, replaced, warnings: result.warnings };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('auth:profile-detail', () => {
    try {
      const summary = accounts.summary();
      const list = accounts.list();
      let active = list.find((item) => item.active) || null;
      // 没有显式账户记录时（纯离线模式），按当前离线名给出同样的详情，
      // 避免界面上一片「—」。
      if (!active) {
        const name = String(settings.get().offlineName || '').trim() || 'Steve';
        const profile = auth.offlineProfile ? auth.offlineProfile(name) : null;
        active = {
          id: 'offline',
          type: 'offline',
          name,
          uuid: (profile && profile.uuid) || (auth.offlineUuid ? auth.offlineUuid(name) : ''),
          note: '',
          active: true,
          expiresAt: 0,
          expired: false,
          createdAt: 0,
          lastUsedAt: 0,
        };
      }
      let skin = { source: 'default', sourceText: '默认（Steve/Alex）', name: '' };
      try {
        const library = skinmanager.list();
        const selected = (library.skins || []).find((item) => item.id === library.activeSkin);
        if (selected) skin = { source: 'local', sourceText: '本地皮肤库', name: selected.name || '' };
      } catch (err) { /* 皮肤库不可用不影响详情 */ }
      if (skin.source === 'default' && active && active.type === 'microsoft') {
        skin = { source: 'mojang', sourceText: 'Mojang 档案', name: active.name };
      }
      return {
        ok: true,
        account: active,
        accountCount: list.length,
        encryption: summary.encryption,
        skin,
        version: app.getVersion(),
        dataDir: config.root(),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('auth:export-clean', async (event) => {
    try {
      const s = settings.get();
      const safeAccounts = accounts.list().map((item) => ({
        id: item.id,
        type: item.type,
        name: item.name,
        uuid: item.uuid,
        note: item.note,
        active: item.active,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
        expiresAt: item.type === 'microsoft' ? item.expiresAt : 0,
      }));
      const payload = {
        exportedAt: new Date().toISOString(),
        app: { version: app.getVersion(), platform: process.platform, arch: process.arch },
        accounts: safeAccounts,
        secrets: {
          curseforgeApiKey: Boolean(s.curseforgeApiKey),
          gistToken: Boolean(s.gistToken),
          updateFeedUrl: Boolean(s.updateFeedUrl),
        },
        note: '脱敏导出：不含 access/refresh token 与密钥明文，只能用于备份账号标识和排查问题。',
      };
      const picked = await dialog.showSaveDialog(senderWindow(event), {
        title: '导出账户信息（脱敏）',
        defaultPath: path.join(app.getPath('documents'), `minepilot-accounts-${Date.now()}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(picked.filePath, JSON.stringify(payload, null, 2), 'utf8');
      return { ok: true, filePath: picked.filePath, count: safeAccounts.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

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

  ipcMain.handle('logs:read', async () => {
    try {
      const target = path.join(config.logsDir(), 'minepilot.log');
      const stat = fs.statSync(target);
      const size = Math.min(stat.size, 400 * 1024);
      const fd = fs.openSync(target, 'r');
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, stat.size - size);
      fs.closeSync(fd);
      return {
        ok: true,
        path: target,
        content: diagnostics.redact(buffer.toString('utf8')),
        truncated: stat.size > size,
      };
    } catch (err) {
      return { ok: false, error: err.message, path: path.join(config.logsDir(), 'minepilot.log') };
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
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.MINEPILOT_SHOT_DELAY) || 2600));
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

app.on('before-quit', () => {
  try { netplay.stopAll(); } catch (err) { /* ignore */ }
});

process.on('uncaughtException', (err) => {
  logger.error('未捕获异常:', err.stack || err.message);
});
process.on('unhandledRejection', (err) => {
  logger.error('未处理的 Promise 拒绝:', err && (err.stack || err.message));
});