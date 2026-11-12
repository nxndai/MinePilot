'use strict';

/**
 * README 目录与锚点一致性检查。
 *
 * 目录条目和章节锚点很容易在改文档时脱节：链接点了没反应，或者新加的章节忘了
 * 放进目录。这里在 CI 里直接拦住这两种情况。
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');

function fail(message) {
  console.error('docs tests failed:', message);
  process.exit(1);
}

const linkIds = [...readme.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map((match) => match[1]);
const anchorIds = new Set([...readme.matchAll(/<a id="([a-z0-9-]+)"><\/a>/g)].map((match) => match[1]));

if (!linkIds.length) fail('README 里没有任何章节链接，目录可能被删掉了');
if (!anchorIds.size) fail('README 里没有任何 <a id> 锚点');

const uniqueLinks = [...new Set(linkIds)];
const missing = uniqueLinks.filter((id) => !anchorIds.has(id));
if (missing.length) fail(`目录里有链接指向不存在的锚点：${missing.join(', ')}`);

// 每个二级章节（目录本身除外）都应该可跳转，避免新增章节漏加锚点。
const lines = readme.split('\n');
const missingAnchors = [];
for (let i = 0; i < lines.length; i += 1) {
  const heading = /^## (.+)$/.exec(lines[i]);
  if (!heading) continue;
  if (heading[1].trim() === '目录') continue;
  let j = i - 1;
  // 跳过空行和 <a name="...">，锚点和标题之间允许夹这些。
  while (j >= 0 && (/^\s*$/.test(lines[j]) || /^<a name="[^"]+"><\/a>$/.test(lines[j].trim()))) j -= 1;
  if (j < 0 || !/^<a id="[a-z0-9-]+"><\/a>$/.test(lines[j].trim())) missingAnchors.push(heading[1].trim());
}
if (missingAnchors.length) fail(`这些章节缺少锚点：${missingAnchors.join(' / ')}`);

// 反方向：锚点建了但目录里没列，容易变成“藏起来的章节”。
const unused = [...anchorIds].filter((id) => !uniqueLinks.includes(id));
if (unused.length) fail(`这些锚点没有出现在目录里：${unused.join(', ')}`);

console.log(`docs tests passed（${uniqueLinks.length} 个目录条目 / ${anchorIds.size} 个锚点）`);