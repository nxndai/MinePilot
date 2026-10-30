'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const logger = require('./logger');
const auth = require('./auth');
const microsoft = require('./microsoft');

/**
 * 账户持久化。Microsoft 令牌只保存在本地数据目录的 accounts.json 中，
 * 不会发送给渲染进程；界面只能拿到用户名、UUID 和过期状态。
 */

function accountFile() {
  return path.join(config.root(), 'accounts.json');
}

function emptyStore() {
  return { microsoft: null };
}

function load() {
  try {
    const raw = fs.readFileSync(accountFile(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return emptyStore();
    return { microsoft: data.microsoft && data.microsoft.accessToken ? data.microsoft : null };
  } catch (err) {
    return emptyStore();
  }
}

function save(data) {
  const file = accountFile();
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.error('保存账户信息失败:', err.message);
    throw new Error('无法保存账户信息，请检查数据目录权限');
  }
}

function setMicrosoft(account) {
  const data = load();
  data.microsoft = {
    name: account.name,
    uuid: account.uuid,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken || (data.microsoft && data.microsoft.refreshToken) || '',
    expiresAt: account.expiresAt || 0,
    xuid: account.xuid || '',
    skin: account.skin || '',
    capes: Array.isArray(account.capes) ? account.capes : [],
  };
  save(data);
  return summary();
}

function clearMicrosoft() {
  save(emptyStore());
}

function summary() {
  const data = load();
  const account = data.microsoft;
  if (!account) {
    return { authenticated: false, name: '', uuid: '', expiresAt: 0, expired: false };
  }
  return {
    authenticated: true,
    name: account.name,
    uuid: account.uuid,
    expiresAt: account.expiresAt,
    expired: Boolean(account.expiresAt && Date.now() > account.expiresAt - 60 * 1000),
    skin: account.skin || '',
    capes: Array.isArray(account.capes) ? account.capes : [],
  };
}

function profileFromAccount(account) {
  return {
    name: account.name,
    uuid: account.uuid,
    accessToken: account.accessToken,
    userType: 'msa',
    mode: 'microsoft',
    xuid: account.xuid || '',
    expiresAt: account.expiresAt,
  };
}

/**
 * 返回启动游戏使用的账户。Microsoft 模式下会按需刷新令牌；
 * 未登录或刷新失败时抛出明确错误，而不是静默切回离线账户。
 */
async function profileFor(settings) {
  if (!settings || settings.authMode !== 'microsoft') {
    return auth.offlineProfile(settings ? settings.offlineName : 'Steve');
  }
  const data = load();
  const account = data.microsoft;
  if (!account) {
    const error = new Error('尚未登录 Microsoft 账户');
    error.code = 'NO_ACCOUNT';
    throw error;
  }
  if (!account.expiresAt || Date.now() < account.expiresAt - 60 * 1000) {
    return profileFromAccount(account);
  }
  try {
    logger.info('Microsoft 令牌即将过期，正在刷新');
    const refreshed = await microsoft.refresh(account.refreshToken);
    setMicrosoft(refreshed);
    return profileFromAccount(refreshed);
  } catch (err) {
    logger.warn('Microsoft 令牌刷新失败:', err.message);
    const error = new Error('Microsoft 登录已失效，请重新登录');
    error.code = 'AUTH_EXPIRED';
    throw error;
  }
}

function displayName(settings) {
  if (settings && settings.authMode === 'microsoft') {
    const current = summary();
    if (current.authenticated) return current.name;
  }
  return (settings && settings.offlineName) || 'Steve';
}

module.exports = {
  load,
  summary,
  setMicrosoft,
  clearMicrosoft,
  profileFor,
  displayName,
  accountFile,
};