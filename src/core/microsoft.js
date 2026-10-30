'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const logger = require('./logger');

/**
 * Microsoft / Xbox Live / Minecraft Services 登录。
 *
 * 使用 OAuth 2.0 设备代码流，不依赖本地回调端口：
 *   1. 申请 device_code，让用户在浏览器输入代码；
 *   2. 轮询 token，拿到 Microsoft OAuth token；
 *   3. 依次换取 Xbox Live token、XSTS token、Minecraft access token；
 *   4. 读取 Minecraft 档案（正版用户名 / UUID）。
 *
 * 默认客户端 ID 是 Minecraft 启动器的公开客户端；如果微软调整策略，
 * 可以通过 MINEPILOT_MS_CLIENT_ID 环境变量换成自己注册的 Azure 应用。
 */

const CLIENT_ID = process.env.MINEPILOT_MS_CLIENT_ID || 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';
const SCOPE = 'XboxLive.signin XboxLive.offline_access';
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const DEVICE_CODE_URL = `${AUTHORITY}/devicecode`;
const TOKEN_URL = `${AUTHORITY}/token`;

const XBOX_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError() {
  const error = new Error('已取消登录');
  error.code = 'CANCELLED';
  return error;
}

async function request(url, options = {}) {
  const { method = 'GET', headers = {}, body = null, timeout = 20000, signal = null } = options;
  const timeoutSignal = AbortSignal.timeout(timeout);
  const combined = signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeoutSignal])
    : (signal || timeoutSignal);
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: combined });
  } catch (err) {
    if (signal && signal.aborted) throw abortError();
    const error = new Error(`网络请求失败：${err.message}`);
    error.code = 'NETWORK';
    throw error;
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    data = null;
  }
  return { response, data, text };
}

function oauthError(data, fallback) {
  const code = (data && (data.error || data.error_codes)) || 'OAUTH_ERROR';
  const description = (data && (data.error_description || data.error)) || fallback || 'Microsoft 登录失败';
  const error = new Error(String(description).split('\n')[0]);
  error.code = code;
  error.oauth = data;
  return error;
}

async function startDeviceCode() {
  const body = new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE });
  const { response, data } = await request(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeout: 20000,
  });
  if (!response.ok || !data || !data.device_code) {
    if (data && data.error === 'invalid_client') {
      const error = new Error('Microsoft 登录客户端不可用，请设置 MINEPILOT_MS_CLIENT_ID 后重试');
      error.code = 'INVALID_CLIENT';
      throw error;
    }
    throw oauthError(data, `获取登录代码失败（HTTP ${response.status}）`);
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri || 'https://www.microsoft.com/link',
    verificationUriComplete: data.verification_uri_complete || '',
    expiresIn: Number(data.expires_in) || 900,
    interval: Math.max(2, Number(data.interval) || 5),
    message: data.message || '',
  };
}

/**
 * 只向 Microsoft 查询一次设备代码状态。
 * 启动器改为短轮询，避免浏览器或本地服务长时间挂着一个请求导致
 * 用户明明已经完成授权、界面却一直停在“等待登录”。
 */
async function pollDeviceCodeOnce(deviceCode, options = {}) {
  const { signal = null } = options;
  if (signal && signal.aborted) throw abortError();

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: CLIENT_ID,
    device_code: deviceCode,
  });
  const { response, data } = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeout: 20000,
    signal,
  });

  if (response.ok && data && data.access_token) return { status: 'ok', oauth: data };

  const code = data && data.error;
  if (code === 'authorization_pending') return { status: 'pending' };
  if (code === 'slow_down') return { status: 'slow_down' };
  if (code === 'expired_token') {
    const error = new Error('登录代码已过期，请重新获取');
    error.code = 'EXPIRED';
    throw error;
  }
  if (code === 'authorization_declined' || code === 'access_denied') {
    const error = new Error('已取消 Microsoft 授权');
    error.code = 'DENIED';
    throw error;
  }
  throw oauthError(data, 'Microsoft 登录失败');
}

/**
 * 轮询设备代码，直到用户完成授权或代码过期。
 * 返回 Microsoft OAuth token 响应。
 */
async function pollDeviceCode(deviceCode, options = {}) {
  const { signal = null, interval = 5, expiresIn = 900, onWait = null } = options;
  const deadline = Date.now() + expiresIn * 1000;
  let waitSeconds = Math.max(2, interval);
  let first = true;

  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw abortError();
    if (!first) await sleep(waitSeconds * 1000);
    first = false;
    if (signal && signal.aborted) throw abortError();

    const result = await pollDeviceCodeOnce(deviceCode, { signal });
    if (result.status === 'ok') return result.oauth;
    if (result.status === 'slow_down') waitSeconds += 5;
    if (onWait) onWait({ state: 'pending' });
  }

  const error = new Error('登录代码已过期，请重新获取');
  error.code = 'EXPIRED';
  throw error;
}

async function authenticateXbox(msAccessToken) {
  const { response, data } = await request(XBOX_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-xbl-contract-version': '1',
    },
    body: JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${msAccessToken}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }),
    timeout: 25000,
  });
  if (!response.ok || !data || !data.Token) {
    const error = new Error(`Xbox Live 登录失败（HTTP ${response.status}）`);
    error.code = 'XBOX_AUTH';
    throw error;
  }
  const claims = data.DisplayClaims && data.DisplayClaims.xui && data.DisplayClaims.xui[0];
  return { token: data.Token, userHash: claims ? claims.uhs : '' };
}

function xstsError(data) {
  const code = data && data.XErr;
  const map = {
    2148916233: '该 Microsoft 账户还没有 Xbox 账户，请先在 Xbox 官网创建档案',
    2148916235: '该账户所在地区不支持 Xbox Live',
    2148916236: '需要先在 Xbox 页面完成成人验证',
    2148916237: '需要先在 Xbox 页面完成成人验证',
    2148916238: '儿童账户需要由家庭组中的成人先完成授权',
    2148916227: '该 Xbox 账户已被封禁',
  };
  const error = new Error(map[code] || `Xbox 授权失败${code ? `（XErr ${code}）` : ''}`);
  error.code = code ? `XSTS_${code}` : 'XSTS';
  error.xerr = code;
  return error;
}

async function authorizeXsts(xboxToken) {
  const { response, data } = await request(XSTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-xbl-contract-version': '1',
    },
    body: JSON.stringify({
      Properties: {
        SandboxId: 'RETAIL',
        UserTokens: [xboxToken],
      },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    }),
    timeout: 25000,
  });
  if (!response.ok || !data || !data.Token) {
    if (data && data.XErr) throw xstsError(data);
    const error = new Error(`Xbox 安全令牌获取失败（HTTP ${response.status}）`);
    error.code = 'XSTS';
    throw error;
  }
  const claims = data.DisplayClaims && data.DisplayClaims.xui && data.DisplayClaims.xui[0];
  return { token: data.Token, userHash: claims ? claims.uhs : '' };
}

async function loginMinecraft(userHash, xstsToken) {
  const { response, data } = await request(MC_LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${userHash};${xstsToken}` }),
    timeout: 25000,
  });
  if (!response.ok || !data || !data.access_token) {
    const error = new Error(`Minecraft 登录失败（HTTP ${response.status}）`);
    error.code = 'MC_LOGIN';
    throw error;
  }
  return data;
}

async function fetchMinecraftProfile(accessToken) {
  const { response, data } = await request(MC_PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 20000,
  });
  if (response.status === 404) {
    const error = new Error('该 Microsoft 账户没有购买 Minecraft Java 版');
    error.code = 'NOT_OWNED';
    throw error;
  }
  if (!response.ok || !data || !data.id) {
    const error = new Error(`读取 Minecraft 档案失败（HTTP ${response.status}）`);
    error.code = 'PROFILE';
    throw error;
  }
  return data;
}

async function completeLogin(oauth) {
  const xbox = await authenticateXbox(oauth.access_token);
  const xsts = await authorizeXsts(xbox.token);
  const minecraft = await loginMinecraft(xsts.userHash || xbox.userHash, xsts.token);
  const profile = await fetchMinecraftProfile(minecraft.access_token);
  return {
    name: profile.name,
    uuid: profile.id,
    accessToken: minecraft.access_token,
    refreshToken: oauth.refresh_token || '',
    expiresAt: Date.now() + (Number(minecraft.expires_in) || 86400) * 1000,
    xuid: xsts.userHash || xbox.userHash || '',
    skin: profile.skins && profile.skins[0] ? profile.skins[0].url : '',
    capes: Array.isArray(profile.capes) ? profile.capes : [],
  };
}

async function loginWithDeviceCode(options = {}) {
  const start = await startDeviceCode();
  if (options.onCode) await options.onCode(start);
  const oauth = await pollDeviceCode(start.deviceCode, {
    signal: options.signal,
    interval: start.interval,
    expiresIn: start.expiresIn,
    onWait: options.onWait,
  });
  return completeLogin(oauth);
}

async function refresh(refreshToken) {
  if (!refreshToken) {
    const error = new Error('登录已过期，请重新登录');
    error.code = 'AUTH_EXPIRED';
    throw error;
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    scope: SCOPE,
  });
  const { response, data } = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeout: 25000,
  });
  if (!response.ok || !data || !data.access_token) {
    const error = new Error('Microsoft 登录已失效，请重新登录');
    error.code = 'AUTH_EXPIRED';
    error.oauth = data;
    throw error;
  }
  const account = await completeLogin(Object.assign({}, data, {
    refresh_token: data.refresh_token || refreshToken,
  }));
  return account;
}

module.exports = {
  CLIENT_ID,
  startDeviceCode,
  pollDeviceCode,
  pollDeviceCodeOnce,
  loginWithDeviceCode,
  refresh,
  completeLogin,
};