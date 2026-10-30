'use strict';

const fs = require('fs');
const path = require('path');

let dataRoot = null;

function appRoot() {
  return path.resolve(__dirname, '..', '..');
}

function init(root) {
  dataRoot = path.resolve(root);
  for (const dir of ['', 'logs', 'runtime', 'cache']) {
    fs.mkdirSync(path.join(dataRoot, dir), { recursive: true });
  }
}

function root() {
  if (!dataRoot) throw new Error('应用数据目录尚未初始化');
  return dataRoot;
}

module.exports = {
  init,
  root,
  appRoot,
  configFile: () => path.join(root(), 'config.json'),
  cacheDir: () => path.join(root(), 'cache'),
  logsDir: () => path.join(root(), 'logs'),
  runtimeDir: () => path.join(root(), 'runtime'),
  gameDir: (settings) => (settings && settings.gameDir) || path.join(root(), 'Minecraft'),
};