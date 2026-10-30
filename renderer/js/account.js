'use strict';

(function () {
  const { $, esc } = MP;

  let loginSeq = 0;
  let loginPending = false;

  function accountState() {
    return MP.state.account || { mode: 'offline', microsoft: { authenticated: false } };
  }

  function isMicrosoft() {
    const state = accountState();
    return state.mode === 'microsoft' && state.microsoft && state.microsoft.authenticated;
  }

  MP.accountName = function () {
    if (isMicrosoft()) return accountState().microsoft.name;
    return (MP.state.settings && MP.state.settings.offlineName) || 'Steve';
  };

  MP.accountModeText = function () {
    if (isMicrosoft()) {
      return accountState().microsoft.expired ? 'Microsoft 账户 · 令牌待刷新' : 'Microsoft 账户 · 正版';
    }
    return '离线账户 · 仅本地';
  };

  async function refreshAccount() {
    try {
      MP.state.account = await MP.api.invoke('auth:status');
    } catch (err) {
      MP.state.account = { mode: 'offline', microsoft: { authenticated: false } };
    }
    if (MP.views.home) MP.views.home.refresh();
    renderSettingsAccount();
  }

  MP.refreshAccount = refreshAccount;

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      const input = document.createElement('textarea');
      input.value = text;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    } catch (err) {
      /* ignore */
    }
  }

  function fillAccountPanel(panel) {
    if (!panel) return;
    const state = accountState();
    const ms = state.microsoft || { authenticated: false };
    const offlineName = (MP.state.settings && MP.state.settings.offlineName) || 'Steve';

    let msBlock;
    if (ms.authenticated) {
      const expired = ms.expired ? '（登录已过期，启动时会尝试刷新）' : '（已登录）';
      msBlock = `<div class="account-line">
        <div class="avatar" id="mp-ms-avatar"></div>
        <div class="account-line-main">
          <strong>${esc(ms.name || 'Microsoft 账户')}</strong>
          <span class="muted-sm">${expired} · ${esc((ms.uuid || '').slice(0, 8))}…</span>
        </div>
        <button class="btn small ghost" data-account="logout">退出登录</button>
      </div>
      ${state.mode === 'microsoft' ? '' : '<button class="btn small primary" data-account="use-ms" style="margin-top:10px">使用该 Microsoft 账户启动</button>'}`;
    } else {
      msBlock = `<p class="muted-sm">登录 Microsoft 账户后可以加入正版服务器，并显示正版皮肤。</p>
        <button class="btn small primary" data-account="login-ms">登录 Microsoft 账户</button>`;
    }

    panel.innerHTML = `<div class="account-panel-block">
      <div class="account-panel-title">Microsoft</div>
      ${msBlock}
    </div>
    <div class="account-panel-block">
      <div class="account-panel-title">离线账户</div>
      <p class="muted-sm">仅用于本地游戏与离线测试，不能加入正版验证服务器。</p>
      <div class="account-line">
        <input class="input" id="mp-offline-name" maxlength="16" value="${esc(offlineName)}" placeholder="Steve">
        <button class="btn small ghost" data-account="save-offline">保存</button>
        ${state.mode === 'offline' ? '<span class="badge">当前使用</span>' : '<button class="btn small" data-account="use-offline">使用离线账户</button>'}
      </div>
    </div>`;

    const avatar = panel.querySelector('#mp-ms-avatar');
    if (avatar && ms.name) MP.setAvatar(avatar, ms.name);

    panel.querySelectorAll('[data-account]').forEach((button) => {
      button.addEventListener('click', () => handleAction(button.dataset.account, panel));
    });
  }

  async function setAuthMode(mode) {
    const next = await MP.api.invoke('settings:update', { authMode: mode });
    MP.state.settings = next;
    if (MP.state.account) MP.state.account.mode = mode;
    await refreshAccount();
    if (MP.views.settings) MP.views.settings.render();
    if (MP.views.home) MP.views.home.refresh();
  }

  async function handleAction(action, panel) {
    if (action === 'login-ms') {
      await startLogin(panel);
      return;
    }
    if (action === 'logout') {
      const ok = await MP.confirm({
        title: '退出 Microsoft 账户',
        text: '退出后本地保存的登录令牌会被删除，离线账户不受影响。',
        confirmLabel: '退出',
        danger: true,
      });
      if (!ok) return;
      const result = await MP.api.invoke('auth:logout');
      if (!result.ok) {
        MP.toast(result.error || '退出失败', 'err');
        return;
      }
      await refreshAccount();
      fillAccountPanel(panel);
      MP.toast('已退出 Microsoft 账户', 'ok');
      return;
    }
    if (action === 'use-ms') {
      await setAuthMode('microsoft');
      fillAccountPanel(panel);
      MP.toast('已切换为 Microsoft 账户', 'ok');
      return;
    }
    if (action === 'use-offline') {
      await setAuthMode('offline');
      fillAccountPanel(panel);
      MP.toast('已切换为离线账户', 'ok');
      return;
    }
    if (action === 'save-offline') {
      const input = panel.querySelector('#mp-offline-name');
      const value = input ? input.value.trim() : '';
      if (!/^[A-Za-z0-9_]{3,16}$/.test(value)) {
        MP.toast('请输入 3–16 位字母、数字或下划线', 'err');
        return;
      }
      const next = await MP.api.invoke('settings:update', { offlineName: value });
      MP.state.settings = next;
      MP.toast('离线玩家名已保存', 'ok');
      fillAccountPanel(panel);
      if (MP.views.home) MP.views.home.refresh();
      if (MP.views.settings) MP.views.settings.render();
    }
  }

  async function startLogin(panel) {
    const seq = ++loginSeq;
    panel.innerHTML = `<div class="account-panel-block">
      <div class="account-panel-title">Microsoft 登录</div>
      <p class="muted-sm">正在向 Microsoft 申请一次性登录代码…</p>
    </div>`;
    let start;
    try {
      start = await MP.api.invoke('auth:login-start');
    } catch (err) {
      start = { ok: false, error: err.message };
    }
    if (seq !== loginSeq) return;
    if (!start.ok) {
      loginPending = false;
      panel.innerHTML = `<div class="account-panel-block">
        <div class="account-panel-title">Microsoft 登录</div>
        <p class="error-text">${esc(start.error || '无法开始登录')}</p>
        <button class="btn small ghost" data-account="login-ms">重试</button>
      </div>`;
      panel.querySelector('[data-account="login-ms"]').addEventListener('click', () => startLogin(panel));
      return;
    }

    panel.innerHTML = `<div class="account-panel-block">
      <div class="account-panel-title">Microsoft 登录</div>
      <p>请打开下面的链接，并输入一次性代码：</p>
      <div class="device-code" id="mp-device-code">${esc(start.userCode)}</div>
      <a class="device-link" id="mp-device-link" href="${esc(start.verificationUriComplete || start.verificationUri)}" target="_blank" rel="noopener noreferrer">${esc(start.verificationUri)}</a>
      <div class="account-line">
        <button class="btn small primary" data-login="open">打开登录页</button>
        <button class="btn small ghost" data-login="copy">复制代码</button>
        <button class="btn small ghost" data-login="copy-link">复制链接</button>
        <button class="btn small ghost" data-login="cancel">取消</button>
      </div>
      <p class="muted-sm" id="mp-login-status">等待授权…代码约 ${Math.round((start.expiresIn || 900) / 60)} 分钟内有效。</p>
    </div>`;

    loginPending = true;
    let cancelled = false;
    let pollTimer = null;
    const statusNode = panel.querySelector('#mp-login-status');
    const showStatus = (text, isError) => {
      if (!statusNode) return;
      statusNode.textContent = text;
      statusNode.classList.toggle('error-text', Boolean(isError));
    };

    const loginUrl = start.verificationUriComplete || start.verificationUri;
    panel.querySelector('[data-login="open"]').addEventListener('click', async () => {
      try {
        const result = await MP.openExternal(loginUrl);
        if (result && result.ok === false) throw new Error(result.error || '无法打开浏览器');
        showStatus('已尝试打开登录页，请在浏览器中输入代码…', false);
      } catch (err) {
        await copyText(loginUrl);
        showStatus(`无法自动打开浏览器，登录页链接已复制，请手动粘贴到浏览器。${err.message ? `（${err.message}）` : ''}`, true);
        MP.toast('未能自动打开登录页，链接已复制', 'warn', 6000);
      }
    });
    panel.querySelector('[data-login="copy"]').addEventListener('click', async () => {
      await copyText(start.userCode);
      MP.toast('登录代码已复制', 'ok');
    });
    panel.querySelector('[data-login="copy-link"]').addEventListener('click', async () => {
      await copyText(loginUrl);
      MP.toast('登录页链接已复制', 'ok');
    });
    panel.querySelector('[data-login="cancel"]').addEventListener('click', async () => {
      cancelled = true;
      loginPending = false;
      if (pollTimer) clearTimeout(pollTimer);
      await MP.api.invoke('auth:login-cancel');
      if (seq === loginSeq) fillAccountPanel(panel);
    });

    const showLoginError = (result) => {
      const retryable = Boolean(result && result.retryable);
      showStatus(
        `${(result && result.error) || '登录失败'}${retryable ? '。请检查网络后重试。' : '。'}`,
        true,
      );
      const actions = panel.querySelector('.account-line');
      if (!actions) return;
      actions.innerHTML = retryable
        ? '<button class="btn small primary" data-login="check">重试检查</button>'
          + '<button class="btn small ghost" data-login="retry">重新获取代码</button>'
        : '<button class="btn small primary" data-login="retry">重新获取代码</button>';
      const retry = actions.querySelector('[data-login="retry"]');
      if (retry) retry.addEventListener('click', () => startLogin(panel));
      const checkAgain = actions.querySelector('[data-login="check"]');
      if (checkAgain) {
        checkAgain.addEventListener('click', () => {
          loginPending = true;
          showStatus('正在确认登录状态…', false);
          check();
        });
      }
    };

    const check = async () => {
      if (cancelled || seq !== loginSeq) return;
      let result;
      try {
        result = await MP.api.invoke('auth:login-poll');
      } catch (err) {
        result = { ok: false, code: 'NETWORK', error: err.message, retryable: true };
      }
      if (cancelled || seq !== loginSeq) return;

      if (result && result.pending) {
        loginPending = true;
        showStatus(
          '等待授权…请在浏览器中登录，并点击“继续 / 接受”完成授权。完成后启动器会自动识别。',
          false,
        );
        const delay = Math.max(2500, (Number(result.interval) || 5) * 1000);
        pollTimer = setTimeout(check, delay);
        return;
      }

      loginPending = false;
      if (!result || !result.ok) {
        showLoginError(result || {});
        return;
      }

      await refreshAccount();
      fillAccountPanel(panel);
      MP.toast(`已登录：${result.account ? result.account.name : 'Microsoft 账户'}`, 'ok', 5000);
    };

    check();
  }

  function openAccountModal() {
    let panel = null;
    MP.modal({
      title: '账户管理',
      body: '<div id="mp-account-panel"></div>',
      actions: [{ label: '关闭', value: true }],
      onMount: (box) => {
        panel = box.querySelector('#mp-account-panel');
        fillAccountPanel(panel);
      },
      onClose: () => {
        // 关闭账户窗口时结束仍在等待的设备代码轮询，避免后台请求悬挂。
        loginSeq += 1;
        loginPending = false;
        MP.api.invoke('auth:login-cancel').catch(() => {});
      },
    }).then(() => {
      if (panel) panel.innerHTML = '';
    });
  }

  MP.openAccount = openAccountModal;

  function renderSettingsAccount() {
    const state = accountState();
    const ms = state.microsoft || { authenticated: false };
    const status = $('#ms-account-status');
    if (status) {
      status.textContent = ms.authenticated
        ? `${ms.name}${ms.expired ? '（已过期）' : ''}`
        : '未登录';
      status.classList.toggle('error-text', Boolean(ms.expired));
    }
    if ($('#btn-ms-login')) $('#btn-ms-login').classList.toggle('hidden', Boolean(ms.authenticated && !ms.expired));
    if ($('#btn-ms-logout')) $('#btn-ms-logout').classList.toggle('hidden', !ms.authenticated);
    if ($('#set-auth-mode')) $('#set-auth-mode').value = state.mode === 'microsoft' ? 'microsoft' : 'offline';
  }

  MP.renderAccountSettings = renderSettingsAccount;

  function bindAccountSettings() {
    const login = $('#btn-ms-login');
    if (login && !login.dataset.bound) {
      login.dataset.bound = '1';
      login.addEventListener('click', openAccountModal);
    }
    const logout = $('#btn-ms-logout');
    if (logout && !logout.dataset.bound) {
      logout.dataset.bound = '1';
      logout.addEventListener('click', async () => {
        const ok = await MP.confirm({
          title: '退出 Microsoft 账户',
          text: '退出后本地保存的登录令牌会被删除。',
          confirmLabel: '退出',
          danger: true,
        });
        if (!ok) return;
        const result = await MP.api.invoke('auth:logout');
        if (!result.ok) {
          MP.toast(result.error || '退出失败', 'err');
          return;
        }
        await refreshAccount();
        if (MP.views.settings) MP.views.settings.render();
        MP.toast('已退出 Microsoft 账户', 'ok');
      });
    }
    const mode = $('#set-auth-mode');
    if (mode && !mode.dataset.bound) {
      mode.dataset.bound = '1';
      mode.addEventListener('change', async () => {
        const next = mode.value;
        if (next === 'microsoft' && !accountState().microsoft.authenticated) {
          mode.value = 'offline';
          MP.toast('请先登录 Microsoft 账户', 'warn');
          openAccountModal();
          return;
        }
        await setAuthMode(next);
        MP.toast(next === 'microsoft' ? '已切换为 Microsoft 账户' : '已切换为离线账户', 'ok');
      });
    }
  }

  MP.bindAccountSettings = bindAccountSettings;

  MP.openMicrosoftLogin = () => openAccountModal();
})();