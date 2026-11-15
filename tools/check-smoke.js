'use strict';

/**
 * CI 里校验 Electron 无头启动结果：
 * - smoke.png 是一张有内容的 PNG
 * - smoke.json 里界面已经渲染出来（标题、视图、布局尺寸正常）
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = process.cwd();
const shotPath = path.join(dir, 'smoke.png');
const dumpPath = path.join(dir, 'smoke.json');

assert.ok(fs.existsSync(shotPath), '没有生成 smoke.png');
assert.ok(fs.existsSync(dumpPath), '没有生成 smoke.json');

const png = fs.readFileSync(shotPath);
assert.strictEqual(png.subarray(1, 4).toString('latin1'), 'PNG', 'smoke.png 不是有效 PNG');
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
assert.ok(png.length > 5000, `截图太小（${png.length} 字节），可能没渲染出来`);
assert.ok(width >= 400 && height >= 300, `截图尺寸异常：${width}x${height}`);

const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
assert.strictEqual(dump.title, 'MinePilot', '窗口标题不正确');
assert.ok(dump.view, '没有读到我当前视图');
assert.ok(dump.body && dump.body.clientWidth > 400, `界面宽度异常：${JSON.stringify(dump.body)}`);
assert.ok(Array.isArray(dump.errors) && dump.errors.length === 0, `渲染进程有报错：${JSON.stringify(dump.errors)}`);
assert.ok(dump.text && dump.text.length > 50, '页面没有渲染出内容');

// 中文字形：缺字体时 canvas 上两个不同汉字会渲染成同一个豆腐块。
assert.ok(dump.fonts, 'smoke.json 里没有字体探针结果');
assert.ok(dump.fonts.available, '无法在渲染进程里检测字体');
assert.strictEqual(dump.fonts.cjkRendered, true, `中文字符没有正常渲染（缺中文字体）：${JSON.stringify(dump.fonts)}`);

console.log(`smoke ok: ${dump.view} / ${width}x${height} / screenshot ${png.length} bytes / errors 0`);
console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);