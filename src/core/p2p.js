'use strict';

/**
 * P2P 直连（Minecraft 局域网联机的点对点隧道）。
 *
 * 原理：HyperDHT 做 UDP 打洞（打不通时由 DHT 节点中转），我们把打通的
 * 数据流和本机 TCP 互相 pipe：
 *   房主：DHT 连接 <-> 127.0.0.1:25565（游戏「对局域网开放」的端口）
 *   加入：本机 127.0.0.1:25566 <-> DHT <-> 房主
 * 加入者只要在游戏里「直接连接 127.0.0.1:25566」即可。
 *
 * 不捆绑任何第三方二进制、不经过项目自己的服务器；房间码就是房主的公钥。
 */

const net = require('net');
const logger = require('./logger');

const DEFAULT_GAME_PORT = 25565;
const DEFAULT_LOCAL_PORT = 25566;

let DHTClass = null;
function loadDht() {
  if (!DHTClass) DHTClass = require('hyperdht');
  return DHTClass;
}

const state = {
  mode: '', // 'host' | 'join'
  dht: null,
  hostServer: null,
  joinServer: null,
  roomCode: '',
  address: '',
  targetPort: 0,
  localPort: 0,
  peers: 0,
  error: '',
  startedAt: 0,
};

let emitEvent = () => {};

function setEmitter(fn) {
  emitEvent = typeof fn === 'function' ? fn : () => {};
}

function emit(type, payload) {
  try { emitEvent({ type, payload }); } catch (err) { /* ignore */ }
}

/** 房间码只保留十六进制字符，并允许带空格/短横线方便手抄。 */
function normalizeRoomCode(value) {
  return String(value || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

function isValidRoomCode(value) {
  return normalizeRoomCode(value).length === 64;
}

function snapshot() {
  return {
    ok: !state.error,
    mode: state.mode,
    roomCode: state.roomCode,
    address: state.address,
    targetPort: state.targetPort,
    localPort: state.localPort,
    peers: state.peers,
    startedAt: state.startedAt,
    error: state.error,
    host: state.mode === 'host',
    joined: state.mode === 'join',
  };
}

function attachPeerCounter(conn) {
  state.peers += 1;
  emit('peer', { peers: state.peers });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    state.peers = Math.max(0, state.peers - 1);
    emit('peer', { peers: state.peers });
  };
  conn.on('close', finish);
  conn.on('error', finish);
  return finish;
}

function pipeToLocal(conn, port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.on('error', (err) => {
    state.error = `连接本机游戏端口 ${port} 失败：${err.message}`;
    logger.warn('P2P 转发到本机失败:', err.message);
    conn.destroy();
  });
  conn.on('error', () => socket.destroy());
  conn.pipe(socket).pipe(conn);
  conn.on('close', () => socket.destroy());
  socket.on('close', () => conn.destroy());
}

async function stop() {
  const closeHost = state.hostServer;
  const closeJoin = state.joinServer;
  const dht = state.dht;
  state.hostServer = null;
  state.joinServer = null;
  state.dht = null;
  state.mode = '';
  state.roomCode = '';
  state.address = '';
  state.peers = 0;
  state.targetPort = 0;
  state.localPort = 0;
  state.startedAt = 0;

  if (closeHost) {
    try { await closeHost.close(); } catch (err) { /* ignore */ }
  }
  if (closeJoin) {
    try { await new Promise((resolve) => closeJoin.close(resolve)); } catch (err) { /* ignore */ }
  }
  if (dht) {
    try { await dht.destroy(); } catch (err) { /* ignore */ }
  }
  emit('state', snapshot());
  return { ok: true };
}

/** 房主：创建房间，提供房间码。 */
async function startHost(options = {}) {
  const port = Number(options.port) > 0 ? Number(options.port) : DEFAULT_GAME_PORT;
  await stop();
  state.error = '';
  try {
    const DHT = loadDht();
    const dht = new DHT();
    await dht.ready();
    const server = dht.createServer((conn) => {
      attachPeerCounter(conn);
      logger.info('P2P 有玩家接入，转发到本机端口', port);
      pipeToLocal(conn, port);
    });
    await server.listen();
    state.dht = dht;
    state.hostServer = server;
    state.mode = 'host';
    state.roomCode = server.publicKey.toString('hex');
    state.targetPort = port;
    state.startedAt = Date.now();
    logger.info('P2P 房间已创建，端口', port);
    emit('state', snapshot());
    return { ok: true, roomCode: state.roomCode, port, peers: 0 };
  } catch (err) {
    state.error = err.message;
    await stop();
    state.error = err.message;
    return { ok: false, error: `创建房间失败：${err.message}` };
  }
}

/** 加入者：用房间码连到房主，并在本地开一个端口给游戏连。 */
async function join(options = {}) {
  const roomCode = normalizeRoomCode(options.roomCode);
  if (roomCode.length !== 64) return { ok: false, error: '房间码应为 64 位十六进制字符' };
  const localPort = Number(options.localPort) > 0 ? Number(options.localPort) : DEFAULT_LOCAL_PORT;
  await stop();
  state.error = '';
  try {
    const DHT = loadDht();
    const dht = new DHT();
    await dht.ready();
    const key = Buffer.from(roomCode, 'hex');
    const server = net.createServer((socket) => {
      const conn = dht.connect(key);
      attachPeerCounter(conn);
      conn.on('error', (err) => {
        state.error = `P2P 连接失败：${err.message}`;
        logger.warn('P2P 加入连接失败:', err.message);
        socket.destroy();
      });
      socket.on('error', () => conn.destroy());
      socket.pipe(conn).pipe(socket);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(localPort, '127.0.0.1', resolve);
    });
    state.dht = dht;
    state.joinServer = server;
    state.mode = 'join';
    state.roomCode = roomCode;
    state.localPort = localPort;
    state.address = `127.0.0.1:${localPort}`;
    state.startedAt = Date.now();
    logger.info('P2P 已加入房间，本地端口', localPort);
    emit('state', snapshot());
    return { ok: true, address: state.address, roomCode, peers: 0 };
  } catch (err) {
    state.error = err.message;
    await stop();
    state.error = err.message;
    return { ok: false, error: `加入房间失败：${err.message}` };
  }
}

module.exports = {
  setEmitter,
  snapshot,
  startHost,
  join,
  stop,
  normalizeRoomCode,
  isValidRoomCode,
  DEFAULT_GAME_PORT,
  DEFAULT_LOCAL_PORT,
};