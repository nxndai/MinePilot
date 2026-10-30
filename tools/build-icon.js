'use strict';

/**
 * 生成 MinePilot 的应用图标：深色圆角底板 + 等距草方块 + 蓝色启动面。
 *
 * 这是一张独立绘制的矢量式图标，不使用 PCL 的任何素材。
 * 输出：
 *   assets/icon.png        1024x1024 主图标（Electron 窗口 / 商店展示）
 *   assets/MinePilot.ico   16~256 多尺寸 Windows 图标
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const python = process.env.MINEPILOT_PYTHON || 'python';
const script = path.join(__dirname, 'make-icon.py');
const result = spawnSync(python, [script], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);