'use strict';

/**
 * 联机 / 内网穿透工具集成。
 *
 * MinePilot 不捆绑 Terracotta、EasyTier 或 frp 的可执行文件，也不替用户
 * 申请第三方账户。这里只负责运行用户明确配置的本地工具，展示本机地址，
 * 并在界面中给出官方下载/配置引导。所有进程参数直接传给 spawn（shell:false），
 * 不经过 shell，避免把界面输入拼接成命令。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const logger = require('./logger');

const TOOL_GUIDES = [
  {
    id: 'terracotta',
    name: 'Terracotta',
    url: 'https://github.com/burningtnt/Terracotta',
    summary: 'Minecraft 专用的虚拟局域网工具，通常需要所有玩家加入同一房间。',
    setup: '下载官方发布的可执行文件，按官方说明创建/加入房间；把可执行文件和启动参数填到下方配置。',
  },
  {
    id: 'easytier',
    name: 'EasyTier',
    url: 'https://github.com/EasyTier/EasyTier',
    summary: '通用 P2P 虚拟局域网，需要配置网络名称和密钥；适合自建联机网络。',
    setup: '安装 EasyTier 后，用官方命令加入同一虚拟网络；把启动命令写入下方配置。',
  },
  {
    id: 'frp',
    name: 'FRP',
    url: 'https://github.com/fatedier/frp',
    summary: '需要一台有公网 IP 的服务器；适合有服务器和端口映射经验的用户。',
    setup: '在服务器运行 frps，在本机配置 frpc 的 TCP 隧道到 25565；把 frpc 可执行文件与参数写入下方配置。',
  },
];

const MAX_LOG_LINES = 160;
const MAX_ARGS = 40;

const processes = new Map();

function profiles(settings) {
  return settings && Array.isArray(settings.netplayProfiles) ? settings.netplayProfiles : [];
}

function cleanArgs(value) {
  return (Array.isArray(value) ? value : [])
    .slice(0, MAX_ARGS)
    .map((item) => String(item == null ? '' : item).replace(/[\u0000-\u001f]/g, '').slice(0, 500))
    .filter(Boolean);
}

function expandArgs(args, context = {}) {
  return cleanArgs(args).map((arg) => arg
    .replace(/\{gameDir\}/gi, context.gameDir || '')
    .replace(/\{player\}/gi, context.player || '')
    .replace(/\{address\}/gi, context.address || ''));
}

function validateProfile(profile) {
  const id = String(profile && profile.id || '').trim();
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(id)) throw new Error('联机配置 id 无效');
  const executable = path.resolve(String(profile && profile.executable || '').trim());
  if (!executable) throw new Error('请选择联机工具的可执行文件');
  let stat;
  try { stat = fs.statSync(executable); } catch (err) { throw new Error('联机工具的可执行文件不存在'); }
  if (!stat.isFile()) throw new Error('联机工具路径不是文件');
  if (/\.(bat|cmd|ps1|vbs)$/i.test(executable)) throw new Error('为了安全，不能通过 shell 运行 .bat/.cmd/.ps1 脚本；请填写 .exe 或可执行程序');
  const cwd = profile.cwd ? path.resolve(String(profile.cwd)) : path.dirname(executable);
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error('工作目录不是文件夹');
  } catch (err) {
    throw new Error(`工作目录不可用：${cwd}`);
  }
  return {
    id,
    name: String(profile.name || '').trim().slice(0, 60) || id,
    tool: String(profile.tool || 'custom').slice(0, 20),
    executable,
    args: cleanArgs(profile.args),
    cwd,
    autoCopy: profile.autoCopy !== false,
  };
}

function localAddresses(port = 25565) {
  const target = normalizePort(port);
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const item of addresses || []) {
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      if (item.internal) continue;
      if (/^169\.254\./.test(item.address)) continue;
      result.push({ name, address: item.address, port: target, text: `${item.address}:${target}` });
    }
  }
  return result;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 25565;
  return port;
}

function isPrivateAddress(address) {
  return /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
    || /^127\./.test(address);
}

/** 尝试建立一次 TCP 连接，用来判断端口有没有在监听。 */
function probeTcp(host, port, timeout = 1800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * 检测指定端口（默认 25565）是否在本机监听。
 * 只能验证“本机能不能连上”，公网能不能连进来取决于路由/防火墙/穿透工具，
 * 这里只根据地址是否内网给出提示，不做外网探测。
 */
async function checkPorts(options = {}) {
  const port = normalizePort(options.port);
  const addresses = localAddresses(port);
  const checks = [];
  for (const item of addresses) {
    checks.push({
      name: item.name,
      address: item.address,
      text: item.text,
      listening: await probeTcp(item.address, port),
    });
  }
  const loopback = await probeTcp('127.0.0.1', port);
  const anyListening = loopback || checks.some((item) => item.listening);
  const privateOnly = addresses.length > 0 && addresses.every((item) => isPrivateAddress(item.address));
  let advice;
  if (!anyListening) {
    advice = `本机 ${port} 端口没有在监听。先在游戏里「对局域网开放」，或确认联机工具已经启动并转发到该端口。`;
  } else if (privateOnly) {
    advice = `本机 ${port} 已在监听，但地址都是内网地址。同一局域网的朋友可以直接用上面的地址；异地联机需要端口映射或联机工具。`;
  } else {
    advice = `本机 ${port} 已在监听。异机联机还需要路由器端口映射或联机工具，并确认防火墙放行。`;
  }
  return { ok: true, port, loopback, addresses: checks, anyListening, privateOnly, advice };
}

function quoteArg(value) {
  const text = String(value == null ? '' : value);
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/** 生成可以直接粘给朋友的联机信息。 */
function buildShareText(profile, context = {}) {
  const normalized = validateProfile(profile);
  const args = expandArgs(normalized.args, context);
  const command = [quoteArg(normalized.executable), ...args.map(quoteArg)].join(' ');
  const port = normalizePort(context.port);
  const address = (localAddresses(port)[0] || { text: `127.0.0.1:${port}` }).text;
  const lines = [
    `配置：${normalized.name}`,
    `工具：${normalized.tool}`,
    `启动命令：${command}`,
  ];
  if (address) lines.push(`局域网地址：${address}`);
  return { ok: true, command, address, text: lines.join('\n') };
}

/** 导出配置为可分享的 JSON（不含可执行文件的绝对路径检查，导入后再校验）。 */
function exportProfiles(list) {
  const profiles = (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: String(item.id || '').trim().slice(0, 80),
      name: String(item.name || '').slice(0, 60),
      tool: String(item.tool || 'custom').slice(0, 20),
      executable: String(item.executable || '').slice(0, 500),
      args: cleanArgs(item.args),
      cwd: String(item.cwd || '').slice(0, 500),
      autoCopy: item.autoCopy !== false,
    }))
    // 导出和导入用同一套 id 规则，避免“能导出但导入时被静默跳过”。
    .filter((item) => /^[a-zA-Z0-9._-]{1,80}$/.test(item.id));
  return { version: 1, exportedAt: new Date().toISOString(), profiles };
}

/** 导入配置：逐条校验，非法条目跳过并给出原因，不覆盖同 id 之外的数据。 */
function importProfiles(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.profiles) ? data.profiles : null);
  if (!list) throw new Error('文件里没有 profiles 数组');
  const profiles = [];
  const warnings = [];
  for (const item of list.slice(0, 200)) {
    const id = String(item && item.id || '').trim();
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(id)) {
      warnings.push(`跳过 id 不合法的配置：${id || '(空)'}`);
      continue;
    }
    if (!String(item.executable || '').trim()) {
      warnings.push(`跳过没有可执行文件的配置：${item.name || id}`);
      continue;
    }
    profiles.push({
      id,
      name: String(item.name || '').trim().slice(0, 60) || id,
      tool: String(item.tool || 'custom').slice(0, 20),
      executable: String(item.executable || '').trim().slice(0, 500),
      args: cleanArgs(item.args),
      cwd: String(item.cwd || '').trim().slice(0, 500),
      autoCopy: item.autoCopy !== false,
    });
  }
  if (!profiles.length) throw new Error('没有可导入的配置');
  return { ok: true, profiles, warnings };
}

function snapshot() {
  const result = [];
  for (const [id, item] of processes.entries()) {
    result.push({
      id,
      running: item.running,
      pid: item.child && item.child.pid ? item.child.pid : 0,
      startedAt: item.startedAt,
      exitCode: item.exitCode == null ? null : item.exitCode,
      error: item.error || '',
      logs: item.logs.slice(-40),
    });
  }
  return result;
}

function emit(onEvent, type, payload) {
  if (typeof onEvent !== 'function') return;
  try { onEvent({ type, payload }); } catch (err) { /* ignore */ }
}

function appendLog(item, line, onEvent) {
  const text = String(line || '').slice(0, 4000);
  item.logs.push(text);
  if (item.logs.length > MAX_LOG_LINES) item.logs.splice(0, item.logs.length - MAX_LOG_LINES);
  emit(onEvent, 'log', { id: item.id, line: text });
}

function start(profile, context = {}, onEvent) {
  const normalized = validateProfile(profile);
  const existing = processes.get(normalized.id);
  if (existing && existing.running) {
    return { ok: true, alreadyRunning: true, id: normalized.id, pid: existing.child && existing.child.pid };
  }
  const args = expandArgs(normalized.args, context);
  let child;
  try {
    child = spawn(normalized.executable, args, {
      cwd: normalized.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    logger.warn('启动联机工具失败:', normalized.id, err.message);
    return { ok: false, code: 'NETPLAY_SPAWN_FAILED', error: `无法启动联机工具：${err.message}` };
  }
  const item = {
    id: normalized.id,
    child,
    running: true,
    startedAt: Date.now(),
    exitCode: null,
    error: '',
    logs: [],
  };
  processes.set(normalized.id, item);
  appendLog(item, `$ ${path.basename(normalized.executable)} ${args.join(' ')}`.trim(), onEvent);
  child.stdout.on('data', (buffer) => {
    String(buffer).split(/\r?\n/).filter(Boolean).forEach((line) => appendLog(item, line, onEvent));
  });
  child.stderr.on('data', (buffer) => {
    String(buffer).split(/\r?\n/).filter(Boolean).forEach((line) => appendLog(item, line, onEvent));
  });
  child.on('error', (err) => {
    item.error = err.message;
    appendLog(item, `[错误] ${err.message}`, onEvent);
    emit(onEvent, 'state', { id: item.id, running: false, error: item.error });
  });
  child.on('exit', (code, signal) => {
    item.running = false;
    item.exitCode = code;
    appendLog(item, `[进程退出] code=${code == null ? '—' : code}${signal ? ` signal=${signal}` : ''}`, onEvent);
    emit(onEvent, 'state', { id: item.id, running: false, exitCode: code, signal: signal || '' });
    logger.info('联机工具已退出:', item.id, code);
  });
  emit(onEvent, 'state', { id: item.id, running: true, pid: child.pid, startedAt: item.startedAt });
  return {
    ok: true,
    id: normalized.id,
    pid: child.pid || 0,
    args,
    addresses: localAddresses(),
  };
}

function stop(id) {
  const item = processes.get(String(id || ''));
  if (!item) return { ok: true, running: false };
  if (!item.running) return { ok: true, running: false };
  try {
    if (process.platform === 'win32' && item.child.pid) {
      const killer = spawn('taskkill', ['/pid', String(item.child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => { try { item.child.kill(); } catch (err) { /* ignore */ } });
    } else {
      item.child.kill('SIGTERM');
    }
  } catch (err) {
    try { item.child.kill(); } catch (e) { /* ignore */ }
  }
  item.running = false;
  return { ok: true, running: false, id: item.id };
}

function stopAll() {
  for (const id of processes.keys()) stop(id);
  processes.clear();
}

function logs(id) {
  const item = processes.get(String(id || ''));
  return item ? item.logs.slice(-MAX_LOG_LINES) : [];
}

function guides() {
  return TOOL_GUIDES.map((item) => Object.assign({}, item));
}

module.exports = {
  profiles,
  checkPorts,
  buildShareText,
  exportProfiles,
  importProfiles,
  normalizePort,
  validateProfile,
  localAddresses,
  snapshot,
  start,
  stop,
  stopAll,
  logs,
  guides,
  expandArgs,
};