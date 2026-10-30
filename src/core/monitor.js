'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const logger = require('./logger');
const settings = require('./settings');
const procstats = require('./procstats');

const MAX_LOG_CHARS = 240 * 1024;
const MAX_LOG_LINES = 120;

let session = null;

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function attach(launch) {
  if (!launch || !launch.process || !launch.pid) return null;
  session = {
    process: launch.process,
    pid: Number(launch.pid),
    versionId: launch.versionId || '',
    player: launch.player || '',
    startedAt: Date.now(),
    logPath: launch.logPath || '',
    gameDir: launch.gameDir || '',
    memoryMb: Math.max(0, Number(launch.memoryMb) || settings.get().memoryMb || 0),
    portable: Boolean(launch.portable),
    logBuffer: '',
    lastCpuMs: null,
    lastSampleAt: 0,
    cpuPercent: 0,
    exited: false,
    exitInfo: null,
    killRequested: false,
  };
  logger.info('运行监控已连接:', session.versionId, 'PID', session.pid);
  return session;
}

function detach(info) {
  if (!session) return;
  session.exited = true;
  session.exitInfo = info || null;
  session.cpuPercent = 0;
  logger.info('运行监控已断开:', session.versionId, 'PID', session.pid);
}

function pushLog(text) {
  if (!session || !text) return;
  session.logBuffer += stripAnsi(text);
  if (session.logBuffer.length > MAX_LOG_CHARS) {
    session.logBuffer = session.logBuffer.slice(-Math.floor(MAX_LOG_CHARS * 0.75));
  }
}

function readLogTail() {
  if (session && session.logBuffer) {
    const lines = session.logBuffer.split(/\r?\n/);
    return lines.slice(-MAX_LOG_LINES).join('\n');
  }
  if (!session || !session.logPath) return '';
  try {
    const stat = fs.statSync(session.logPath);
    const size = Math.min(stat.size, MAX_LOG_CHARS);
    const fd = fs.openSync(session.logPath, 'r');
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, stat.size - size);
    fs.closeSync(fd);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    return lines.slice(-MAX_LOG_LINES).join('\n');
  } catch (err) {
    return '';
  }
}

function baseState() {
  const s = settings.get();
  return {
    ok: true,
    running: false,
    pid: 0,
    versionId: '',
    player: '',
    startedAt: 0,
    uptimeMs: 0,
    memoryMb: 0,
    memoryAllocatedMb: s.memoryMb,
    memorySystemMb: Math.round(os.totalmem() / 1048576),
    cpuPercent: 0,
    cpuTotalMs: 0,
    threads: 0,
    logTail: '',
    logPath: '',
    exited: false,
    exit: null,
    killRequested: false,
  };
}

async function snapshot() {
  const state = baseState();
  if (!session) return state;

  const now = Date.now();
  const processAlive = session.process && session.process.exitCode === null && !session.exited;
  let stats = null;
  if (!processAlive) {
    state.exited = Boolean(session.exited || (session.process && session.process.exitCode !== null));
    state.memoryAllocatedMb = session.memoryMb || state.memoryAllocatedMb;
    state.exit = session.exitInfo || (session.process && session.process.exitCode != null
      ? { code: session.process.exitCode, signal: null, duration: Math.max(0, now - session.startedAt) }
      : null);
    state.killRequested = session.killRequested;
    state.logTail = readLogTail();
    state.versionId = session.versionId;
    state.pid = session.pid;
    return state;
  }

  try {
    stats = await procstats.query(session.pid);
  } catch (err) {
    logger.warn('读取进程状态失败:', err.message);
  }

  if (session.lastCpuMs != null && stats && stats.available && session.lastSampleAt) {
    const deltaCpu = Math.max(0, Number(stats.cpuMs) - session.lastCpuMs);
    const deltaWall = Math.max(1, now - session.lastSampleAt);
    const cores = Math.max(1, os.cpus().length);
    session.cpuPercent = Math.max(0, Math.min(100, (deltaCpu / deltaWall) * 100 / cores));
  }
  if (stats && stats.available) {
    session.lastCpuMs = Number(stats.cpuMs) || 0;
    session.lastSampleAt = now;
  }

  state.running = true;
  state.memoryAllocatedMb = session.memoryMb || state.memoryAllocatedMb;
  state.pid = session.pid;
  state.versionId = session.versionId;
  state.player = session.player;
  state.startedAt = session.startedAt;
  state.uptimeMs = Math.max(0, now - session.startedAt);
  state.memoryMb = stats && stats.available ? Number((stats.memoryBytes / 1048576).toFixed(1)) : 0;
  state.memoryAvailable = Boolean(stats && stats.available);
  state.cpuPercent = Number(session.cpuPercent.toFixed(1));
  state.cpuTotalMs = stats && stats.available ? Math.round(stats.cpuMs) : 0;
  state.threads = stats && stats.available ? stats.threads : 0;
  state.logTail = readLogTail();
  state.logPath = session.logPath;
  state.gameDir = session.gameDir;
  state.portable = session.portable;
  state.killRequested = session.killRequested;
  if (stats && stats.available === false) state.statsError = '系统暂时无法读取进程资源';
  return state;
}

function kill() {
  return new Promise((resolve) => {
    if (!session || !session.process || session.process.exitCode !== null) {
      resolve({ ok: false, error: '当前没有运行中的游戏' });
      return;
    }
    const pid = session.pid;
    session.killRequested = true;
    const finish = (ok, error) => {
      if (ok) {
        logger.info('已请求结束游戏进程:', pid);
        resolve({ ok: true, pid });
        return;
      }
      logger.warn('结束游戏进程失败:', error || '未知错误');
      resolve({ ok: false, error: error || '无法结束游戏进程', pid });
    };

    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
        if (!err) {
          finish(true);
          return;
        }
        try {
          session.process.kill('SIGKILL');
          finish(true);
        } catch (killErr) {
          finish(false, String(stderr || err.message || killErr.message).trim());
        }
      });
      return;
    }

    // Unix 上启动器把 Java 放进了独立进程组，先结束整个进程组；
    // 老版本或特殊启动方式下再退回单进程结束。
    try {
      process.kill(-pid, 'SIGKILL');
      finish(true);
      return;
    } catch (err) {
      /* 进程组不存在时继续尝试单进程 */
    }
    try {
      session.process.kill('SIGKILL');
      finish(true);
    } catch (err) {
      finish(false, err.message);
    }
  });
}

function currentPid() {
  return session ? session.pid : 0;
}

function logTail() {
  return readLogTail();
}

function killRequested() {
  return Boolean(session && session.killRequested);
}

module.exports = { attach, detach, pushLog, snapshot, kill, currentPid, logTail, killRequested };
