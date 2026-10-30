'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

function timestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function write(level, args) {
  try {
    const line = `[${timestamp()}] [${level}] ${args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ')}\n`;
    fs.appendFileSync(path.join(config.logsDir(), 'minepilot.log'), line, 'utf8');
  } catch (err) {
    /* 日志失败不应影响主流程 */
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

module.exports = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
  logFile: () => path.join(config.logsDir(), 'minepilot.log'),
  timestamp,
};