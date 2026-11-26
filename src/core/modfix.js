'use strict';

/**
 * 模组冲突自动修复。
 *
 * 用户装一个模组（比如旅行背包）之后经常会碰到：
 *   - 需要的前置没装 / 装了但被禁用；
 *   - 同一个 modid 有多个文件（新旧版本并存），游戏只加载其中一个；
 *   - 前置版本不匹配。
 *
 * 这里把"能安全自动处理"的部分做掉：禁用重复 modid 的旧文件、启用被禁用的前置、
 * 从 Modrinth 补装缺失的必需前置。版本不匹配这类需要人工判断的情况只报告，不擅自替换。
 */

const logger = require('./logger');
const modmanager = require('./modmanager');
const mods = require('./mods');

function versionScore(value) {
  const parts = String(value || '').split(/[.\-+_]/).slice(0, 4);
  return parts.map((part) => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function compareModVersion(a, b) {
  const left = versionScore(a.version);
  const right = versionScore(b.version);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l !== r) return r - l; // 版本高的排前面
  }
  // 版本相同：优先保留已启用的、文件名更新的
  if (Boolean(a.enabled) !== Boolean(b.enabled)) return a.enabled ? -1 : 1;
  return String(b.filename || '').localeCompare(String(a.filename || ''));
}

/**
 * 纯函数：根据健康检查结果算出要做的动作。
 * 便于单元测试，也方便 UI 预览"会修什么"。
 */
function planFixes(list, health) {
  const modsList = Array.isArray(list) ? list : [];
  const report = health || modmanager.healthFromList(modsList);
  const disables = [];
  const enables = [];
  const installs = [];
  const notes = [];
  const seenDisable = new Set();
  const seenEnable = new Set();
  const seenInstall = new Set();

  // 1) 重复 modid：保留版本最高的，其余禁用
  for (const dup of report.duplicateIds || []) {
    const id = String(dup.id || '').toLowerCase();
    const group = modsList.filter((mod) => String(mod.modId || '').toLowerCase() === id);
    if (group.length < 2) continue;
    const sorted = group.slice().sort(compareModVersion);
    const keep = sorted[0];
    for (const other of sorted.slice(1)) {
      if (!other.enabled) continue;
      if (seenDisable.has(other.filename)) continue;
      seenDisable.add(other.filename);
      disables.push({
        filename: other.filename,
        reason: `重复 modid ${dup.id}，保留 ${keep.filename}`,
      });
    }
  }

  // 2) 前置被禁用：启用它
  for (const item of report.missing || []) {
    if (!item.disabled) continue;
    const id = String(item.id || '').toLowerCase();
    const candidates = modsList.filter((mod) => String(mod.modId || '').toLowerCase() === id
      || (mod.provides || []).some((provided) => String(provided || '').toLowerCase() === id));
    for (const candidate of candidates) {
      if (candidate.enabled) continue;
      if (seenEnable.has(candidate.filename)) continue;
      seenEnable.add(candidate.filename);
      enables.push({
        filename: candidate.filename,
        reason: `${item.requiredBy || '某个模组'} 需要 ${item.id}`,
      });
    }
  }

  // 3) 前置缺失：需要从 Modrinth 补装
  for (const item of report.missing || []) {
    if (item.disabled) continue;
    if (seenInstall.has(item.id)) continue;
    seenInstall.add(item.id);
    installs.push({ id: item.id, range: item.range || '', requiredBy: item.requiredBy || '' });
  }

  // 4) 需要人工判断的，明确告知不自动处理
  for (const issue of report.issues || []) {
    if (issue.type === 'dependency-version') {
      notes.push(`${issue.title}：需要手动选择兼容版本，未自动替换。`);
    }
    if (issue.type === 'conflict') {
      notes.push(`${issue.title}：两个模组互斥，请手动选择要保留的一个。`);
    }
  }

  return { disables, enables, installs, notes };
}

/** 在 Modrinth 上按 modid 找项目：只接受 slug 完全匹配的结果，避免装错。 */
async function findProjectByModId(modId, target) {
  const id = String(modId || '').trim();
  if (!id) return null;
  const loader = (target && Array.isArray(target.loaders) && target.loaders[0] && target.loaders[0].key) || '';
  const result = await mods.search({
    query: id,
    projectType: 'mod',
    gameVersion: (target && target.mcVersion) || '',
    loader,
    limit: 10,
  });
  const hits = Array.isArray(result.hits) ? result.hits : [];
  const exact = hits.find((hit) => String(hit.slug || '').toLowerCase() === id.toLowerCase());
  return exact || null;
}

/**
 * 执行修复：禁用重复、启用前置、补装缺失前置，最后重新检查。
 */
async function autoFix(target, options = {}) {
  if (!target || !target.id || !target.gameDir) {
    return { ok: false, error: '没有找到要修复的实例' };
  }
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const beforeResult = modmanager.list(target);
  const beforeList = Array.isArray(beforeResult.mods) ? beforeResult.mods : [];
  const before = beforeResult.health || modmanager.healthFromList(beforeList);
  const plan = planFixes(beforeList, before);
  const actions = [];
  const failed = [];

  for (const item of plan.disables) {
    try {
      modmanager.setEnabled(target, item.filename, false);
      actions.push({ type: 'disable', filename: item.filename, detail: item.reason });
    } catch (err) {
      failed.push({ type: 'disable', filename: item.filename, error: err.message });
    }
  }
  for (const item of plan.enables) {
    try {
      modmanager.setEnabled(target, item.filename, true);
      actions.push({ type: 'enable', filename: item.filename, detail: item.reason });
    } catch (err) {
      failed.push({ type: 'enable', filename: item.filename, error: err.message });
    }
  }
  for (const item of plan.installs) {
    try {
      if (onProgress) onProgress({ phase: `补装前置 ${item.id}`, percent: 10 });
      const project = await findProjectByModId(item.id, target);
      if (!project) {
        failed.push({ type: 'install', modId: item.id, error: '在 Modrinth 上没找到同名项目，需要手动安装' });
        continue;
      }
      await mods.install({
        target,
        projectId: project.projectId,
        gameVersion: target.mcVersion,
        onProgress,
      });
      actions.push({ type: 'install', modId: item.id, project: project.title, detail: `为 ${item.requiredBy || '实例'} 补装 ${item.title || item.id}` });
    } catch (err) {
      failed.push({ type: 'install', modId: item.id, error: err.message });
    }
  }

  const afterResult = modmanager.list(target);
  const afterList = Array.isArray(afterResult.mods) ? afterResult.mods : [];
  const after = afterResult.health || modmanager.healthFromList(afterList);
  logger.info('模组自动修复完成:', actions.length, '个动作，剩余问题:', after.errorCount);
  return {
    ok: true,
    actions,
    failed,
    notes: plan.notes,
    before: { errors: before.errorCount, warnings: before.warningCount, issues: before.issues.length },
    after: { errors: after.errorCount, warnings: after.warningCount, issues: after.issues.length },
    remaining: after.issues,
  };
}

module.exports = { autoFix, planFixes, findProjectByModId, compareModVersion };