'use strict';

/**
 * 将 dist/MinePilotWeb 打包成 Edge 备用版自解压安装程序。
 *
 * 安装包只包含程序文件，不包含 data、edge-profile、日志和任何账户信息。
 * 与独立应用安装包共用同一个 C# 安装器；区别只是载荷来自 Edge 版目录。
 */

const path = require('path');
const fs = require('fs');
const { buildSfx } = require('./sfx-builder');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '');

try {
  buildSfx({
    appDir: path.join(root, 'dist', 'MinePilotWeb'),
    outFile: path.join(root, 'dist', 'installer', `MinePilot_Edge_Setup_${version}.exe`),
    version,
    label: 'edge',
  });
} catch (err) {
  console.error('');
  console.error('打包 Edge 安装程序失败：' + err.message);
  process.exit(1);
}