'use strict';

/**
 * MinePilot Web 后端。
 *
 * 当 Electron 运行时被系统安全策略拦截时，由原生引导程序启动本服务，
 * 再用 Microsoft Edge 的应用窗口加载同一套界面。它只监听 127.0.0.1。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

const APP_ROOT = __dirname;
const RENDERER_DIR = path.join(APP_ROOT, 'renderer');
const ASSETS_DIR = path.join(APP_ROOT, 'assets');
const SHELL_OPEN_EXE = path.join(APP_ROOT, 'MinePilot.exe');
const EXPLORER_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
const CMD_EXE = process.env.ComSpec || 'cmd.exe';
const RUNDLL32_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');
const pkg = require('./package.json');

const dataRoot = process.env.MINEPILOT_HOME
  ? path.resolve(process.env.MINEPILOT_HOME)
  : path.join(APP_ROOT, 'data');
config.init(dataRoot);
updater.configure({
  currentVersion: pkg.version,
  downloadsDir: path.join(config.root(), 'updates'),
  onProgress: (progress) => broadcast('update:progress', progress),
});

const sandboxEnv = Object.keys(process.env).filter((key) => /^(DSH_|CODEX_SANDBOX|MINEPILOT_)/i.test(key));
logger.info(`数据目录: ${dataRoot}`);
logger.info(`运行环境: ${sandboxEnv.length ? sandboxEnv.join(', ') : '未检测到沙箱标记'}`);

const DEFAULT_PORT = 46321;
const portArgIndex = process.argv.indexOf('--port');
const requestedPort = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : DEFAULT_PORT;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

let installing = null;
let modInstalling = null;
let packImporting = null;
let currentLaunch = null;
let memoryCleaning = null;
let pendingAuth = null;
let shuttingDown = false;
const clients = new Set();
let everConnected = false;
let shutdownTimer = null;

function broadcast(channel, payload) {
  if (!clients.size) return;
  const line = `data: ${JSON.stringify({ channel, payload })}\n\n`;
  for (const response of clients) {
    try {
      response.write(line);
    } catch (err) {
      clients.delete(response);
    }
  }
}

function applyAccountSelection(account) {
  const patch = account && account.type === 'microsoft'
    ? { authMode: 'microsoft' }
    : { authMode: 'offline', offlineName: (account && account.name) || settings.get().offlineName };
  const next = settings.update(patch);
  broadcast('settings:changed', next);
  broadcast('auth:changed', { mode: next.authMode, microsoft: accounts.summary() });
  return next;
}

function shutdownNow() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const response of clients) {
    try { response.end(); } catch (err) { /* ignore */ }
  }
  clients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

function scheduleShutdown() {
  if (!everConnected || shuttingDown) return;
  clearTimeout(shutdownTimer);
  shutdownTimer = setTimeout(() => {
    if (clients.size === 0) shutdownNow();
  }, 8000);
  shutdownTimer.unref();
}

function runAndWait(exe, args, timeoutMs = 5000, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // 打开目录/链接的子进程不能带 SW_HIDE：那会让 Explorer/浏览器把窗口也隐藏起来。
      child = spawn(exe, args, { windowsHide: options.hidden !== false, stdio: 'ignore' });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.once('error', (err) => finish({ ok: false, error: err.message }));
    child.once('exit', (code) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, error: `退出码 ${code}` });
    });

    // 超时不等于成功：如果系统处理程序一直没有响应，宁可让界面显示错误，
    // 也不能静默地当作“已经打开”。
    const timer = setTimeout(() => {
      try { child.unref(); } catch (err) { /* ignore */ }
      finish({ ok: false, error: '等待系统响应超时' });
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });
}

async function openPath(target) {
  if (!target) return { ok: false, error: '路径为空' };
  const resolved = path.resolve(String(target));
  if (!fs.existsSync(resolved)) return { ok: false, error: '路径不存在' };
  logger.info('请求打开目录:', resolved);

  const attempts = [];

  if (!platform.isWindows) {
    const opener = platform.openCommand();
    if (opener) {
      const result = await runAndWait(opener, [resolved], 4000, { hidden: false });
      if (result.ok) {
        logger.info('已通过系统文件管理器打开目录:', resolved);
        return { ok: true, via: opener };
      }
      attempts.push(`${opener}: ${result.error || '失败'}`);
    }
    return { ok: false, error: `系统未能打开该目录（${attempts.join('；')}）` };
  }

  // 优先显式启动 explorer.exe。部分系统上 ShellExecute 会返回成功但
  // 实际没有打开窗口，因此不能只信助手进程的退出码。
  try {
    await spawnDetached(EXPLORER_EXE, [resolved]);
    logger.info('已通过 explorer 打开目录:', resolved);
    return { ok: true, via: 'explorer' };
  } catch (err) {
    attempts.push(`Explorer: ${err.message}`);
    logger.warn('explorer 打开目录失败:', err.message);
  }

  // 回退：同一个 MinePilot.exe 以 --open 模式调用 ShellExecuteW。
  if (fs.existsSync(SHELL_OPEN_EXE)) {
    const helper = await runAndWait(SHELL_OPEN_EXE, ['--open', resolved], 4000, { hidden: false });
    if (helper.ok) {
      logger.info('已通过 ShellExecute 打开目录:', resolved);
      return { ok: true, via: 'shell' };
    }
    attempts.push(`Shell: ${helper.error || '失败'}`);
  } else {
    attempts.push('Shell: 缺少 MinePilot.exe');
  }

  // 第三层：cmd 的 start 使用系统 shell 关联。
  const quoted = `"${resolved.replace(/"/g, '""')}"`;
  const cmd = await runAndWait(CMD_EXE, ['/d', '/c', `start "" ${quoted}`], 3000, { hidden: false });
  if (cmd.ok) {
    logger.info('已通过 start 打开目录:', resolved);
    return { ok: true, via: 'start' };
  }
  attempts.push(`start: ${cmd.error || '失败'}`);

  logger.warn('打开目录失败:', resolved, attempts.join('；'));
  return { ok: false, error: `系统未能打开该目录（${attempts.join('；')}）` };
}

function spawnDetached(exe, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      try { child.unref(); } catch (err) { /* ignore */ }
      resolve();
    });
  });
}

async function openExternal(url) {
  const target = String(url || '');
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: '不支持的链接' };
  logger.info('请求打开链接:', target);

  const attempts = [];

  if (!platform.isWindows) {
    const opener = platform.openCommand();
    if (opener) {
      const result = await runAndWait(opener, [target], 4000, { hidden: false });
      if (result.ok) {
        logger.info('已通过系统默认浏览器打开链接:', target);
        return { ok: true, via: opener };
      }
      attempts.push(`${opener}: ${result.error || '失败'}`);
    }
    return { ok: false, error: `系统未能打开浏览器（${attempts.join('；')}）` };
  }

  // 优先调用 Windows 的 URL 协议处理器；直接启动 msedge.exe 可能只留下
  // 后台进程，不会显示浏览器窗口。
  try {
    await spawnDetached(RUNDLL32_EXE, ['url.dll,FileProtocolHandler', target]);
    logger.info('已通过 URL 协议处理器打开链接:', target);
    return { ok: true, via: 'rundll32' };
  } catch (err) {
    attempts.push(`Rundll32: ${err.message}`);
  }

  // 再交给资源管理器处理 URL 关联，它会调用系统默认浏览器。
  try {
    await spawnDetached(EXPLORER_EXE, [target]);
    logger.info('已通过资源管理器打开链接:', target);
    return { ok: true, via: 'explorer' };
  } catch (err) {
    attempts.push(`Explorer: ${err.message}`);
  }

  // 回退：ShellExecute 助手，交给系统默认浏览器。
  if (fs.existsSync(SHELL_OPEN_EXE)) {
    const helper = await runAndWait(SHELL_OPEN_EXE, ['--open', target], 4000, { hidden: false });
    if (helper.ok) return { ok: true, via: 'shell' };
    attempts.push(`Shell: ${helper.error || '失败'}`);
  } else {
    attempts.push('Shell: 缺少 MinePilot.exe');
  }

  const quoted = `"${target.replace(/"/g, '""')}"`;
  const cmd = await runAndWait(CMD_EXE, ['/d', '/c', `start "" ${quoted}`], 3000, { hidden: false });
  if (cmd.ok) {
    logger.info('已通过系统默认浏览器打开链接:', target);
    return { ok: true, via: 'start' };
  }
  attempts.push(`start: ${cmd.error || '失败'}`);

  logger.warn('打开链接失败:', target, attempts.join('；'));
  return { ok: false, error: `系统未能打开浏览器（${attempts.join('；')}）` };
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
      appVersion: pkg.version,
    }));
    if (record.crashed) diagnostics.save(record);
    else diagnostics.clearLatest();
    return record;
  } catch (err) {
    logger.warn('生成崩溃诊断失败:', err.message);
    return null;
  }
}

async function versionTarget(versionId) {
  const s = settings.get();
  const id = String(versionId || s.lastVersion || '').trim();
  if (!id) throw Object.assign(new Error('请先选择目标版本'), { code: 'NO_TARGET' });
  const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
  const target = list.find((version) => version.id === id);
  if (!target) throw Object.assign(new Error('目标版本不存在，请刷新版本列表'), { code: 'NO_TARGET' });
  return target;
}

const handlers = {
  'app:info': async () => ({
    name: 'MinePilot',
    version: pkg.version,
    dataDir: config.root(),
    gameDir: settings.get().gameDir,
    platform: process.platform,
    arch: process.arch,
    electron: 'Microsoft Edge',
    node: process.versions.node,
    mode: 'web',
  }),

  'settings:get': async () => settings.get(),

  'settings:update': async (patch) => {
    const next = settings.update(patch || {});
    broadcast('settings:changed', next);
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'authMode')) {
      broadcast('auth:changed', { mode: next.authMode, microsoft: accounts.summary() });
    }
    return next;
  },

  'auth:status': async () => ({
    ok: true,
    mode: settings.get().authMode,
    microsoft: accounts.summary(),
  }),

  'auth:accounts': async () => ({
    ok: true,
    activeId: accounts.summary().activeId || '',
    accounts: accounts.list(),
    encryption: accounts.encryptionInfo(),
  }),

  'auth:select': async (id) => {
    try {
      const account = accounts.select(String(id || ''));
      const next = applyAccountSelection(account);
      return { ok: true, account, mode: next.authMode, microsoft: accounts.summary() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  'auth:add-offline': async (payload) => {
    try {
      const account = accounts.addOffline(payload && payload.name, payload && payload.note);
      const next = applyAccountSelection(account);
      return { ok: true, account, mode: next.authMode, microsoft: accounts.summary() };
    } catch (err) {
      return { ok: false, code: err.code || 'BAD_NAME', error: err.message };
    }
  },

  'auth:update-account': async (payload) => {
    try {
      const account = accounts.updateAccount(String(payload && payload.id || ''), { note: payload && payload.note });
      broadcast('auth:changed', { mode: settings.get().authMode, microsoft: accounts.summary() });
      return { ok: true, account };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  'auth:remove-account': async (id) => {
    try {
      const result = accounts.removeAccount(String(id || ''));
      if (!result.ok) return result;
      const nextAccount = accounts.list().find((item) => item.active) || null;
      if (nextAccount) applyAccountSelection(nextAccount);
      else {
        const next = settings.update({ authMode: 'offline' });
        broadcast('settings:changed', next);
        broadcast('auth:changed', { mode: next.authMode, microsoft: accounts.summary() });
      }
      return { ok: true, activeId: result.activeId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  'auth:login-start': async () => {
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
  },

  'auth:login-poll': async () => {
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
      broadcast('settings:changed', next);
      broadcast('auth:changed', { mode: next.authMode, microsoft: summary });
      return { ok: true, mode: 'microsoft', account: summary };
    } catch (err) {
      // 网络抖动时保留设备代码，允许界面点“重试检查”；
      // 其余认证错误（过期、拒绝、Xbox 未建档等）需要重新获取代码。
      const retryable = err.code === 'NETWORK';
      if (!retryable && pendingAuth === pending) pendingAuth = null;
      logger.warn('Microsoft 登录轮询失败:', err.code || 'AUTH_FAILED', err.message);
      return { ok: false, code: err.code || 'AUTH_FAILED', error: err.message, retryable };
    }
  },

  'auth:login-cancel': async () => {
    if (pendingAuth) {
      try { pendingAuth.controller.abort(); } catch (err) { /* ignore */ }
      pendingAuth = null;
    }
    return { ok: true };
  },

  'auth:logout': async () => {
    accounts.clearMicrosoft();
    const next = settings.update({ authMode: 'offline' });
    broadcast('settings:changed', next);
    broadcast('auth:changed', { mode: next.authMode, microsoft: accounts.summary() });
    return { ok: true, mode: next.authMode };
  },

  'auth:refresh': async () => {
    try {
      const s = settings.get();
      if (s.authMode !== 'microsoft') return { ok: false, code: 'OFFLINE', error: '当前不是 Microsoft 账户' };
      const result = await accounts.refreshActive();
      broadcast('auth:changed', { mode: s.authMode, microsoft: accounts.summary() });
      return { ok: true, account: result.account };
    } catch (err) {
      return { ok: false, code: err.code || 'AUTH_FAILED', error: err.message };
    }
  },

  'versions:list': async () => {
    try {
      const s = settings.get();
      const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
      return { ok: true, versions: list };
    } catch (err) {
      logger.error('读取版本列表失败:', err.message);
      return { ok: false, error: err.message };
    }
  },

  'saves:list': async (payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      return Object.assign(savesCore.list(target), {
        instance: {
          id: target.id,
          mcVersion: target.mcVersion || '',
          isolation: Boolean(target.isolation),
          gameDir: target.gameDir,
        },
      });
    } catch (err) {
      return { ok: false, code: err.code || 'SAVE_FAILED', error: err.message };
    }
  },

  'saves:backups': async (payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      return {
        ok: true,
        targetVersionId: target.id,
        backupsDir: savesCore.backupsDir(target),
        backups: savesCore.listBackups(target),
      };
    } catch (err) {
      return { ok: false, code: err.code || 'SAVE_FAILED', error: err.message };
    }
  },

  'saves:backup': async (payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      return savesCore.backup(target, String(payload.world || ''));
    } catch (err) {
      return { ok: false, code: err.code || 'SAVE_FAILED', error: err.message };
    }
  },

  'saves:restore': async (payload = {}) => {
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
      return { ok: false, code: err.code || 'SAVE_FAILED', error: err.message };
    }
  },

  'saves:delete': async (payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      return Object.assign(savesCore.remove(target, String(payload.world || ''), {
        backup: payload.backup !== false,
      }), {
        saves: savesCore.list(target).saves,
        backups: savesCore.listBackups(target),
      });
    } catch (err) {
      return { ok: false, code: err.code || 'SAVE_FAILED', error: err.message };
    }
  },

  'saves:export': async (payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      const dir = path.join(config.cacheDir(), 'save-export');
      fs.mkdirSync(dir, { recursive: true });
      const fileName = `${String(payload.world || 'world').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.zip`;
      const output = path.join(dir, fileName);
      const result = savesCore.exportWorld(target, String(payload.world || ''), output);
      return Object.assign(result, {
        downloadBase64: fs.readFileSync(output).toString('base64'),
      });
    } catch (err) {
      return { ok: false, code: err.code || 'SAVE_FAILED', error: err.message };
    }
  },

  'saves:import': async (payload = {}) => {
    let tempFile = '';
    try {
      const target = await versionTarget(payload.targetVersionId);
      let filePath = String(payload.path || '').trim();
      if (!filePath && payload.dataBase64) {
        const base64 = String(payload.dataBase64).replace(/^data:[^;]+;base64,/, '');
        if (base64.length > 1400 * 1024 * 1024) {
          return { ok: false, code: 'SAVE_TOO_LARGE', error: '存档压缩包超过浏览器版上传上限（约 1 GB），请使用桌面版导入' };
        }
        const buffer = Buffer.from(base64, 'base64');
        if (!buffer.length) return { ok: false, code: 'BAD_ZIP', error: '上传的存档压缩包为空' };
        const dir = path.join(config.cacheDir(), 'save-import');
        fs.mkdirSync(dir, { recursive: true });
        tempFile = path.join(dir, `upload-${Date.now().toString(36)}.zip`);
        fs.writeFileSync(tempFile, buffer);
        filePath = tempFile;
      }
      if (!filePath) return { ok: false, code: 'NO_SAVE', error: '没有选择存档压缩包' };
      const result = savesCore.importWorld(target, filePath, {
        overwrite: Boolean(payload.overwrite),
      });
      return Object.assign(result, {
        saves: savesCore.list(target).saves,
        backups: savesCore.listBackups(target),
      });
    } catch (err) {
      return { ok: false, code: err.code || 'SAVE_FAILED', error: err.message };
    } finally {
      if (tempFile) {
        try { fs.rmSync(tempFile, { force: true }); } catch (err) { /* ignore */ }
      }
    }
  },

  'saves:open-folder': async (payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      const dir = payload.backups ? savesCore.backupsDir(target) : savesCore.savesDir(target);
      return await openPath(dir);
    } catch (err) {
      return { ok: false, code: err.code || 'SAVE_FAILED', error: err.message };
    }
  },

  'content:list': async (payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      const type = String(payload.type || 'resourcepack');
      return {
        ok: true,
        type,
        items: content.list(target, type, { world: payload.world ? String(payload.world) : '' }),
        worlds: content.listWorlds(target.gameDir),
        instance: {
          id: target.id,
          mcVersion: target.mcVersion || '',
          isolation: Boolean(target.isolation),
          gameDir: target.gameDir,
        },
      };
    } catch (err) {
      return { ok: false, code: err.code || 'CONTENT_LIST_FAILED', error: err.message };
    }
  },

  'content:preview': async (payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      return content.preview(target, String(payload.type || ''), String(payload.id || ''), { world: payload.world ? String(payload.world) : '' });
    } catch (err) {
      return { ok: false, code: err.code || 'CONTENT_PREVIEW_FAILED', error: err.message };
    }
  },

  'content:set-enabled': async (payload = {}) => {
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
  },

  'content:import': async () => ({ ok: false, code: 'WEB_IMPORT_UNSUPPORTED', error: '浏览器版请使用文件上传导入内容包' }),

  'content:import-base64': async (payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      const base64 = String(payload.data || '').replace(/^data:[^;]+;base64,/, '');
      if (!base64) return { ok: false, code: 'EMPTY_FILE', error: '上传的内容文件为空' };
      if (base64.length > 18 * 1024 * 1024) {
        return { ok: false, code: 'CONTENT_TOO_LARGE', error: '浏览器版单次上传上限约 13 MB，请使用桌面版导入大文件' };
      }
      return content.importBuffer(target, String(payload.type || ''), Buffer.from(base64, 'base64'), String(payload.name || 'content.zip'), {
        overwrite: Boolean(payload.overwrite),
      });
    } catch (err) {
      return { ok: false, code: err.code || 'CONTENT_IMPORT_FAILED', error: err.message };
    }
  },

  'content:remove': async (payload = {}) => {
    try {
      const target = await versionTarget(payload.targetVersionId);
      return content.remove(target, String(payload.type || ''), String(payload.id || ''), {
        world: payload.world ? String(payload.world) : '',
      });
    } catch (err) {
      return { ok: false, code: err.code || 'CONTENT_REMOVE_FAILED', error: err.message };
    }
  },

  'content:open-folder': async () => ({ ok: false, code: 'WEB_NO_FOLDER', error: '浏览器版无法打开本地文件夹' }),

  'content:search': async (payload = {}) => {
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
  },

  'content:install': async (payload = {}) => {
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
        onProgress: (progress) => broadcast('content:progress', Object.assign({
          type,
          projectId: String(payload.projectId || ''),
          targetVersionId: target.id,
        }, progress)),
      });
      broadcast('content:done', Object.assign({ type, targetVersionId: target.id }, result));
      return result;
    } catch (err) {
      const failure = { ok: false, code: err.code || 'CONTENT_INSTALL_FAILED', error: err.message };
      broadcast('content:error', failure);
      return failure;
    }
  },

  'mods:search': async (payload = {}) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    try {
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
  },

  'mods:versions': async (payload = {}) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    try {
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
  },

  'mods:categories': async (payload = {}) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    try {
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
  },

  'mods:dependencies': async (payload = {}) => {
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
  },

  'mods:install': async (payload = {}) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    if (modInstalling) return { ok: false, code: 'BUSY', error: '已有模组正在安装，请稍候' };
    const request = payload || {};
    const projectId = String(request.projectId || '').trim();
    const targetVersionId = String(request.targetVersionId || '').trim();
    if (!projectId) return { ok: false, code: 'BAD_PROJECT', error: '缺少模组项目 ID' };
    if (!targetVersionId) return { ok: false, code: 'NO_TARGET', error: '请选择要安装到的版本' };

    const controller = new AbortController();
    const requestId = `${projectId}-${Date.now()}`;
    // 先占位，避免两个请求在读取版本列表的 await 期间同时通过忙检查。
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
        onProgress: (progress) => broadcast('mod:progress', Object.assign({
          projectId,
          targetVersionId,
          requestId,
        }, progress)),
      });
      const payloadResult = Object.assign({ ok: true, requestId }, result);
      broadcast('mod:done', payloadResult);
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
      broadcast('mod:error', failure);
      return failure;
    } finally {
      modInstalling = null;
    }
  },

  'mods:cancel': async () => {
    if (!modInstalling) return { ok: true, canceled: false };
    try { modInstalling.controller.abort(); } catch (err) { /* ignore */ }
    modInstalling = null;
    return { ok: true, canceled: true };
  },

  'mods:installed': async (payload = {}) => {
    const targetVersionId = String((payload && payload.targetVersionId) || '').trim();
    if (!targetVersionId) return { ok: false, code: 'NO_TARGET', error: '请先选择目标版本' };
    try {
      const s = settings.get();
      const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
      const target = list.find((version) => version.id === targetVersionId);
      if (!target) return { ok: false, code: 'NO_TARGET', error: '目标版本不存在，请刷新版本列表' };
      return modmanager.list(target);
    } catch (err) {
      return { ok: false, code: err.code || 'MOD_LIST_FAILED', error: err.message };
    }
  },

  'mods:set-enabled': async (payload = {}) => {
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
      return Object.assign({ ok: true }, modmanager.setEnabled(target, filename, enabled));
    } catch (err) {
      return { ok: false, code: err.code || 'MOD_TOGGLE_FAILED', error: err.message };
    }
  },

  'mods:updates': async (payload = {}) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    const targetVersionId = String((payload && payload.targetVersionId) || '').trim();
    if (!targetVersionId) return { ok: false, code: 'NO_TARGET', error: '请先选择目标版本' };
    try {
      const target = await versionTarget(targetVersionId);
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
  },

  'mods:set-enabled-many': async (payload = {}) => {
    const targetVersionId = String((payload && payload.targetVersionId) || '').trim();
    const filenames = Array.isArray(payload && payload.filenames) ? payload.filenames : [];
    const enabled = Boolean(payload && payload.enabled);
    if (!targetVersionId) return { ok: false, code: 'NO_TARGET', error: '请先选择目标版本' };
    if (!filenames.length || filenames.length > 500) {
      return { ok: false, code: 'BAD_MOD_FILE', error: '请选择要批量操作的模组' };
    }
    try {
      const target = await versionTarget(targetVersionId);
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
      return { ok: false, code: err.code || 'MOD_TOGGLE_FAILED', error: err.message };
    }
  },

  'modpack:inspect': async (payload = {}) => {
    const filePath = String((payload && payload.path) || '').trim();
    if (!filePath) return { ok: false, code: 'NO_PACK', error: '没有选择整合包文件' };
    try {
      return Object.assign({ ok: true }, await modpack.inspect(filePath));
    } catch (err) {
      return { ok: false, code: err.code || 'PACK_INSPECT_FAILED', error: err.message };
    }
  },

  'modpack:pick': async () => ({
    ok: false,
    code: 'WEB_UNSUPPORTED',
    error: '浏览器版不能打开 Windows 文件选择器，请使用桌面版导出的整合包路径，或改用桌面版客户端。',
  }),

  'modpack:import': async (payload = {}) => {
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
      if (!target && targetVersionId) return { ok: false, code: 'NO_TARGET', error: '目标版本不存在，请刷新版本列表' };
      const result = await modpack.importPack(filePath, {
        target,
        mode: payload && payload.mode === 'new' ? 'new' : 'current',
        signal: controller.signal,
        onProgress: (progress) => broadcast('modpack:progress', Object.assign({ filePath }, progress)),
      });
      broadcast('modpack:done', result);
      return result;
    } catch (err) {
      const canceled = controller.signal.aborted;
      const failure = {
        ok: false,
        code: canceled ? 'CANCELED' : (err.code || 'PACK_IMPORT_FAILED'),
        error: canceled ? '已取消导入' : err.message,
      };
      broadcast('modpack:error', failure);
      return failure;
    } finally {
      packImporting = null;
    }
  },

  'modpack:download': async (payload = {}) => {
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
        onProgress: (progress) => broadcast('modpack:progress', Object.assign({ title }, progress)),
      });
      broadcast('modpack:done', result);
      return result;
    } catch (err) {
      const canceled = controller.signal.aborted;
      const failure = {
        ok: false,
        code: canceled ? 'CANCELED' : (err.code || 'PACK_DOWNLOAD_FAILED'),
        error: canceled ? '已取消下载' : err.message,
      };
      broadcast('modpack:error', failure);
      return failure;
    } finally {
      packImporting = null;
    }
  },

  'modpack:cancel': async () => {
    if (!packImporting) return { ok: true, canceled: false };
    try { packImporting.controller.abort(); } catch (err) { /* ignore */ }
    return { ok: true, canceled: true };
  },

  'modpack:export': async (payload = {}) => {
    const targetVersionId = String((payload && payload.targetVersionId) || '').trim();
    const format = payload && payload.format === 'zip' ? 'zip' : 'mrpack';
    if (!targetVersionId) return { ok: false, code: 'NO_TARGET', error: '请先选择要导出的实例' };
    try {
      const s = settings.get();
      const list = await versionsCore.listVersions(s.gameDir, s.lastPlayed, s.versionIsolation, s.gameDataDir);
      const target = list.find((version) => version.id === targetVersionId);
      if (!target) return { ok: false, code: 'NO_TARGET', error: '目标版本不存在，请刷新版本列表' };
      const safeTitle = String(target.id || 'MinePilot整合包').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'MinePilot整合包';
      const exportRoot = path.resolve(config.root(), 'exports');
      let outputPath = String((payload && payload.outputPath) || '').trim()
        || path.join(exportRoot, `${safeTitle}.${format}`);
      const resolvedOutput = path.resolve(outputPath);
      if (resolvedOutput !== exportRoot && !resolvedOutput.startsWith(exportRoot + path.sep)) {
        return { ok: false, code: 'BAD_EXPORT_PATH', error: '导出路径必须位于启动器的 exports 目录内' };
      }
      outputPath = resolvedOutput;
      const exported = await modpack.exportPack(target, {
        format,
        outputPath,
        onProgress: (progress) => broadcast('modpack:progress', Object.assign({ targetVersionId }, progress)),
      });
      broadcast('modpack:done', exported);
      return exported;
    } catch (err) {
      return { ok: false, code: err.code || 'PACK_EXPORT_FAILED', error: err.message };
    }
  },

  'versions:delete': async (versionId) => {
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
  },

  'versions:open-folder': async (versionId) => openPath(mojang.versionFolder(settings.get().gameDir, versionId)),

  'versions:open-mods': async (versionId) => {
    const s = settings.get();
    const dir = path.join(versionsCore.effectiveDir(s.gameDir, versionId, versionsCore.isolateFor(s.gameDir, versionId, s.versionIsolation), s.gameDataDir), 'mods');
    fs.mkdirSync(dir, { recursive: true });
    return openPath(dir);
  },

  'game:open-folder': async (versionId) => {
    const s = settings.get();
    const dir = versionId
      ? versionsCore.effectiveDir(s.gameDir, versionId, versionsCore.isolateFor(s.gameDir, versionId, s.versionIsolation), s.gameDataDir)
      : s.gameDir;
    fs.mkdirSync(dir, { recursive: true });
    return openPath(dir);
  },

  'manifest:get': async (options = {}) => {
    try {
      requireOnlineDownloads();
      const manifest = await mojang.getManifest(Boolean(options && options.force), settings.get().downloadSource || 'auto');
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
  },

  'install:start': async (payload) => {
    if (!onlineDownloadsEnabled()) return onlineDownloadsBlocked();
    if (installing) return { ok: false, error: '已有安装任务正在进行，请稍候' };
    const request = typeof payload === 'string' ? { versionId: payload } : (payload || {});
    const versionId = String(request.versionId || '').trim();
    const loader = request.loader === 'fabric' || request.loader === 'forge' ? request.loader : 'vanilla';
    const loaderVersion = String(request.loaderVersion || '').trim();
    if (!versionId) return { ok: false, error: '缺少版本号' };
    if (loader !== 'vanilla' && !loaderVersion) return { ok: false, error: '缺少加载器版本' };
    const controller = new AbortController();
    installing = { versionId, loader, controller };
    try {
      const result = await installer.installVersion(versionId, {
        loader,
        loaderVersion,
        signal: controller.signal,
        onProgress: (progress) => broadcast('install:progress', Object.assign({ versionId, requestId: versionId, loader }, progress)),
      });
      broadcast('install:done', Object.assign({ versionId }, result, { requestId: versionId, loader }));
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
      broadcast('install:error', { versionId, requestId: versionId, loader, code: err.code || '', error: message, aborted });
      return { ok: false, error: message, aborted, code: err.code };
    } finally {
      installing = null;
    }
  },

  'install:cancel': async () => {
    if (!installing) return { ok: false, error: '当前没有安装任务' };
    installing.controller.abort();
    return { ok: true };
  },

  'loader:versions': async (payload = {}) => {
    try {
      const mcVersion = String(payload.mcVersion || '').trim();
      const type = payload.type === 'forge' ? 'forge' : 'fabric';
      if (!mcVersion) return { ok: false, error: '缺少 Minecraft 版本号' };
      const list = type === 'forge'
        ? await loaders.forgeVersions(mcVersion)
        : await loaders.fabricVersions(mcVersion);
      return { ok: true, type, mcVersion, versions: list };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  'launch:start': async (versionId) => {
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

    try {
      const result = await launcher.launch(versionId, {
        javaPath: pick.java.path,
        javaMajor: pick.java.major,
        javaBits: pick.java.bits,
        onLog: (text) => {
          monitor.pushLog(text);
          broadcast('launch:log', { versionId, text });
        },
        onExit: (info) => {
          const record = analyzeGameExit(Object.assign({ versionId }, info));
          monitor.detach(Object.assign({ versionId }, info));
          currentLaunch = null;
          if (record && record.crashed) broadcast('crash:detected', record);
          broadcast('launch:exit', Object.assign({ versionId }, info, {
            diagnostics: summarizeDiagnostics(record),
          }));
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
        javaMajor: pick.java.major,
        gameDir: result.gameDir,
        portable: result.portable,
      };
    } catch (err) {
      logger.error('启动失败:', versionId, err.message);
      return { ok: false, code: err.code || 'LAUNCH_FAILED', error: err.message };
    }
  },

  'java:detect': async () => {
    try {
      const list = await javaCore.detect(true);
      return { ok: true, list };
    } catch (err) {
      return { ok: false, error: err.message, list: [] };
    }
  },

  'java:install': async (payload) => {
    try {
      requireOnlineDownloads();
      const request = payload && typeof payload === 'object' ? payload : { major: payload };
      const result = await javaCore.installJava(Number(request.major) || 21, (progress) => broadcast('java:progress', progress), null, { vendor: request.vendor });
      return { ok: true, java: result };
    } catch (err) {
      logger.error('安装 Java 失败:', err.message);
      return { ok: false, error: err.message };
    }
  },

  'java:add-path': async (payload = {}) => {
    let target = String((payload && payload.path) || '').trim();
    if (!target) return { ok: false, code: 'WEB_UNSUPPORTED', error: '浏览器版不能打开文件选择器，请填写 Java 可执行文件路径' };
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
  },

  'java:remove-path': async (payload = {}) => {
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
  },

  'java:vendors': async () => ({ ok: true, vendors: Object.values(javaCore.JAVA_VENDORS) }),
  'java:open-folder': async () => openPath(config.runtimeDir()),

  'skin:list': async () => {
    try {
      return skinmanager.list();
    } catch (err) {
      logger.error('读取本地皮肤库失败:', err.message);
      return { ok: false, error: err.message, skins: [], capes: [], activeSkin: '', activeCape: '' };
    }
  },

  'skin:import': async (payload = {}) => {
    try {
      return skinmanager.importData(payload);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  'skin:set-active': async (payload = {}) => {
    try {
      return skinmanager.setActive(payload.kind, payload.id, payload.model);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  'skin:apply': async () => {
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
  },

  'skin:clear-active': async (payload = {}) => {
    try {
      return skinmanager.clearActive(payload.kind);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  'skin:remove': async (payload = {}) => {
    try {
      return skinmanager.remove(payload.kind, payload.id);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  'skin:rename': async (payload = {}) => {
    try {
      return skinmanager.rename(payload.kind, payload.id, payload.name);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  'theme:background': async () => appearance.background(),

  'theme:set-background': async (payload = {}) => {
    try {
      return appearance.setBackgroundData(payload);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  'theme:clear-background': async () => appearance.clearBackground(),

  'ui:set-zoom': async (scale) => ({ ok: true, factor: Math.max(0.8, Math.min(1.4, Number(scale) || 1)), cssFallback: true }),

  'monitor:state': async () => monitor.snapshot(),

  'monitor:kill': async () => monitor.kill(),

  'memory:stats': async () => memory.stats(),

  'memory:clean': async () => {
    if (memoryCleaning) return { ok: false, code: 'BUSY', error: '正在清理内存，请稍候' };
    const skipPids = [process.pid];
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
  },

  'diagnostics:latest': async () => {
    try {
      return { ok: true, record: diagnostics.latest(), history: diagnostics.history() };
    } catch (err) {
      return { ok: false, error: err.message, record: null, history: [] };
    }
  },

  'diagnostics:get': async (id) => {
    try {
      return { ok: true, record: diagnostics.get(id) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  'diagnostics:history': async () => ({ ok: true, history: diagnostics.history() }),

  'diagnostics:export': async (id) => {
    try {
      const record = diagnostics.get(id);
      if (!record) return { ok: false, error: '没有可导出的诊断记录' };
      const stamp = new Date(record.createdAt || Date.now());
      const date = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}${String(stamp.getSeconds()).padStart(2, '0')}`;
      const target = path.join(config.root(), 'exports', `MinePilot-Diagnostic-${date}.zip`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const exported = diagnostics.exportReport(record, target);
      const stat = fs.statSync(target);
      const payload = { ok: true, diagnosticId: record.id, path: target, fileName: path.basename(target), bytes: stat.size };
      // 浏览器版通过 base64 让用户直接下载；超过 8 MB 时只返回保存路径。
      if (stat.size <= 8 * 1024 * 1024) payload.downloadBase64 = fs.readFileSync(target).toString('base64');
      return payload;
    } catch (err) {
      logger.warn('导出诊断报告失败:', err.message);
      return { ok: false, error: err.message };
    }
  },

  'diagnostics:open-folder': async () => openPath(path.join(config.root(), 'diagnostics')),

  'diagnostics:share': async (id) => {
    try {
      const record = diagnostics.get(id);
      if (!record) return { ok: false, error: '没有可分享的诊断记录' };
      const text = diagnostics.shareMarkdown(record);
      return {
        ok: true,
        copied: false,
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
        note: '浏览器版无法直接写系统剪贴板，已返回脱敏摘要，请手动复制。',
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  'diagnostics:action': async (payload = {}) => {
    const record = diagnostics.get(String((payload && payload.id) || ''));
    if (!record) return { ok: false, error: '诊断记录不存在' };
    const actionId = String((payload && payload.actionId) || '');
    if (actionId !== 'disable-optifine') {
      return { ok: false, code: 'UNKNOWN_ACTION', error: '不支持这个诊断操作' };
    }
    const versionId = String(record.versionId || '').trim();
    if (!versionId) return { ok: false, code: 'NO_TARGET', error: '诊断记录没有关联游戏版本' };
    try {
      const target = await versionTarget(versionId);
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
      return { ok: false, code: err.code || 'DIAG_ACTION_FAILED', error: err.message };
    }
  },

  'updater:state': async () => updater.snapshot(),

  'updater:check': async () => {
    const state = await updater.check();
    broadcast('update:state', state);
    return state;
  },

  'updater:download': async () => {
    try {
      const result = await updater.download();
      const state = updater.snapshot();
      broadcast('update:state', state);
      return Object.assign({ ok: true }, result, { state });
    } catch (err) {
      return { ok: false, error: err.message, state: updater.snapshot() };
    }
  },

  'updater:cancel': async () => updater.cancel(),
  'updater:open-downloads': async () => openPath(path.join(config.root(), 'updates')),
  'updater:install': async () => ({
    ok: false,
    desktopOnly: true,
    error: '浏览器版不能自动替换正在运行的程序。请打开更新下载目录，手动运行安装包。',
  }),

  'plugins:list': async () => {
    try { return { ok: true, plugins: plugins.list(), apiVersion: plugins.API_VERSION }; } catch (err) { return { ok: false, error: err.message, plugins: [] }; }
  },

  'plugins:source': async (id) => {
    try { return plugins.source(id); } catch (err) { return { ok: false, error: err.message }; }
  },

  'plugins:inspect': async () => ({
    ok: false,
    browser: true,
    error: '浏览器版请选择插件 ZIP 文件上传检查。',
  }),

  'plugins:inspect-base64': async (payload = {}) => {
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
  },

  'plugins:market': async (payload = {}) => {
    try {
      const s = settings.get();
      const url = String(payload.url || s.pluginIndexUrl || '').trim();
      return await plugins.marketIndex(url);
    } catch (err) {
      return { ok: false, code: err.code || 'PLUGIN_MARKET_FAILED', error: err.message };
    }
  },

  'plugins:market-install': async (payload = {}) => {
    try {
      if (!payload.entry) return { ok: false, error: '缺少插件索引条目' };
      return await plugins.installFromMarket(payload.entry, { overwrite: Boolean(payload.overwrite) });
    } catch (err) {
      return { ok: false, code: err.code || 'PLUGIN_INSTALL_FAILED', error: err.message, plugin: err.plugin || null };
    }
  },

  'plugins:install': async () => ({
    ok: false,
    browser: true,
    error: '浏览器版请选择插件 ZIP 文件上传安装。',
  }),

  'plugins:install-base64': async (payload = {}) => {
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
  },

  'plugins:set-enabled': async (id, enabled) => {
    try { return plugins.setEnabled(id, enabled); } catch (err) { return { ok: false, error: err.message }; }
  },

  'plugins:remove': async (id) => {
    try { return plugins.remove(id); } catch (err) { return { ok: false, error: err.message }; }
  },

  'plugins:open-folder': async () => openPath(plugins.pluginsDir()),

  'netplay:state': async () => ({
    ok: true,
    desktopOnly: true,
    profiles: settings.get().netplayProfiles || [],
    processes: [],
    addresses: [],
    guides: netplay.guides(),
    platform: 'web',
    error: '浏览器版无法启动本机联机工具；请使用桌面版，或按页面引导手动运行。',
  }),

  'netplay:start': async () => ({
    ok: false,
    desktopOnly: true,
    error: '浏览器版不能启动本机程序。请使用桌面版，或手动运行 Terracotta / EasyTier / frp。',
  }),

  'netplay:stop': async () => ({ ok: false, desktopOnly: true, error: '浏览器版不能停止本机程序。' }),
  'netplay:logs': async () => ({ ok: true, logs: [] }),
  'netplay:browse': async () => ({ ok: false, browser: true, error: '浏览器版请手动填写本机程序路径。' }),

  'logs:tail': async (filePath) => {
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
  },

  'logs:read': async () => {
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
  },

  'logs:open-folder': async () => openPath(config.logsDir()),

  'shell:open-path': async (target) => openPath(target),
  'shell:open-external': async (url) => openExternal(url),

  'dialog:pick-folder': async () => null,
  'dialog:pick-file': async () => null,

  'app:quit': async () => {
    setTimeout(shutdownNow, 120);
    return { ok: true };
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 24 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

function serveStatic(req, res, pathname) {
  let base = RENDERER_DIR;
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (relative.startsWith('assets/')) {
    base = ASSETS_DIR;
    relative = relative.slice('assets/'.length);
  }
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  serveFile(res, target);
}

const server = http.createServer(async (req, res) => {
  if (process.env.MINEPILOT_DEBUG === '1') {
    console.log(`[req] ${req.method} ${req.url}`);
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`).pathname);
  } catch (err) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, clients: clients.size, connected: everConnected }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/download') {
    let filePath = '';
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      filePath = String(requestUrl.searchParams.get('path') || '');
    } catch (err) { /* 忽略 */ }
    const resolved = path.resolve(filePath);
    const roots = ['exports', 'uploads'].map((name) => path.resolve(dataRoot, name));
    const allowed = roots.some((root) => resolved !== root && resolved.startsWith(root + path.sep));
    if (!filePath || !allowed) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    let stat;
    try { stat = fs.statSync(resolved); } catch (err) { stat = null; }
    if (!stat || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(resolved))}`,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(resolved).pipe(res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    everConnected = true;
    clearTimeout(shutdownTimer);
    req.on('close', () => {
      clients.delete(res);
      scheduleShutdown();
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/pack-upload') {
    let uploadName = 'pack.zip';
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      uploadName = String(requestUrl.searchParams.get('name') || 'pack.zip').replace(/^.*[\\/]/, '');
    } catch (err) { /* 使用默认名称 */ }
    uploadName = uploadName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(-120) || 'pack.zip';
    if (!/\.(mrpack|zip)$/i.test(uploadName)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '只支持 .mrpack 或 .zip 整合包' }));
      return;
    }
    const uploadDir = path.join(dataRoot, 'uploads', Date.now().toString(36));
    fs.mkdirSync(uploadDir, { recursive: true });
    const uploadPath = path.join(uploadDir, uploadName);
    const stream = fs.createWriteStream(uploadPath);
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024 * 1024) {
        tooLarge = true;
        req.destroy();
        stream.destroy();
      }
    });
    req.on('error', () => {
      try { stream.destroy(); } catch (err) { /* ignore */ }
      try { fs.rmSync(uploadPath, { force: true }); } catch (err) { /* ignore */ }
    });
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '无法保存上传的整合包' }));
      }
    });
    stream.on('finish', () => {
      if (tooLarge) {
        try { fs.rmSync(uploadPath, { force: true }); } catch (err) { /* ignore */ }
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '整合包超过 1 GB，无法通过浏览器上传' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, path: uploadPath, fileName: uploadName, bytes }));
    });
    req.pipe(stream);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/invoke') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '请求格式错误' }));
      return;
    }
    const channel = payload && payload.channel;
    const args = Array.isArray(payload && payload.args) ? payload.args : [];
    if (!channel || !Object.prototype.hasOwnProperty.call(handlers, channel)) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: `未知接口：${channel || ''}` }));
      return;
    }
    try {
      const result = await handlers[channel](...args);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result }));
    } catch (err) {
      logger.error('接口失败:', channel, err.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, pathname);
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

const keepAlive = setInterval(() => {
  for (const response of clients) {
    try { response.write(': ping\n\n'); } catch (err) { clients.delete(response); }
  }
}, 15000);
keepAlive.unref();

let retryPort = Number.isFinite(requestedPort) ? requestedPort : DEFAULT_PORT;
let attempts = 0;

function startServer() {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempts < 20) {
      attempts += 1;
      retryPort += 1;
      setTimeout(startServer, 30);
      return;
    }
    logger.error('Web 服务启动失败:', err.message);
    process.exit(1);
  });
  server.listen(retryPort, '127.0.0.1', () => {
    const actual = server.address().port;
    fs.writeFileSync(path.join(dataRoot, 'web-port.txt'), String(actual), 'utf8');
    logger.info('MinePilot Web 已启动:', `http://127.0.0.1:${actual}`);
    console.log(`MINEPILOT_WEB_READY http://127.0.0.1:${actual}`);
  });
}

setTimeout(() => {
  if (!everConnected) {
    logger.warn('Web 界面长时间未连接，退出。');
    shutdownNow();
  }
}, 90000).unref();

process.on('SIGINT', shutdownNow);
process.on('SIGTERM', shutdownNow);
process.on('uncaughtException', (err) => {
  logger.error('Web 后端未捕获异常:', err.stack || err.message);
});
process.on('unhandledRejection', (err) => {
  logger.error('Web 后端未处理拒绝:', err && err.stack ? err.stack : String(err));
});

startServer();
