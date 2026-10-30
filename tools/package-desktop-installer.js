'use strict';

const path = require('path');
const { buildSfx } = require('./sfx-builder');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(require('fs').readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '');

try {
  buildSfx({
    appDir: path.join(root, 'dist', 'MinePilot'),
    outFile: path.join(root, 'dist', 'installer', `MinePilot_Setup_${version}.exe`),
    version,
    label: 'desktop',
  });
} catch (err) {
  console.error('');
  console.error('打包安装程序失败：' + err.message);
  process.exit(1);
}