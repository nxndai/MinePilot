'use strict';

(function () {
  const { $, esc } = MP;

  let loginSeq = 0;
  let loginPending = false;
  let expiryNotified = false;

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
    const ms = MP.state.account && MP.state.account.microsoft;
    const expired = ms && Array.isArray(ms.accounts)
      ? ms.accounts.filter((account) => account.type === 'microsoft' && account.expired)
      : [];
    if (expired.length && !expiryNotified) {
      expiryNotified = true;
      MP.toast(`有 ${expired.length} 个 Microsoft 账户登录已过期，启动或切换时会自动刷新；也可以到账户管理手动刷新。`, 'warn', 8000);
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

  function accountTypeLabel(account) {
    return account.type === 'microsoft' ? 'Microsoft' : '离线';
  }

  function expiryText(account) {
    if (account.type !== 'microsoft') return '仅本地';
    if (account.tokenError) return account.tokenError;
    if (!account.expiresAt) return '登录凭据未知';
    if (account.expired) return '登录已过期，启动时会尝试刷新';
    return `登录有效至 ${new Date(account.expiresAt).toLocaleDateString(MP.i18n && MP.i18n.language === 'en-US' ? 'en-US' : 'zh-CN')}`;
  }

  function fillAccountPanel(panel) {
    if (!panel) return;
    const state = accountState();
    const ms = state.microsoft || { authenticated: false };
    const accounts = Array.isArray(ms.accounts) ? ms.accounts : [];
    const offlineName = (MP.state.settings && MP.state.settings.offlineName) || 'Steve';

    const list = accounts.length
      ? accounts.map((account) => `<div class="account-item${account.active ? ' active' : ''}">
          <div class="avatar" data-account-avatar="${esc(account.name)}"></div>
          <div class="account-item-main">
            <div class="account-item-title">
              <strong>${esc(account.name)}</strong>
              <span class="badge">${accountTypeLabel(account)}</span>
              ${account.active ? '<span class="badge success">当前</span>' : ''}
            </div>
            <span class="muted-sm">${esc(expiryText(account))}${account.note ? ` · ${esc(account.note)}` : ''}</span>
          </div>
          <div class="account-item-actions">
            ${account.active ? '' : `<button class="btn tiny" data-account-action="select" data-account-id="${esc(account.id)}">使用</button>`}
            <button class="btn tiny ghost" data-account-action="note" data-account-id="${esc(account.id)}">备注</button>
            <button class="btn tiny ghost danger-text" data-account-action="remove" data-account-id="${esc(account.id)}">移除</button>
          </div>
        </div>`).join('')
      : '<p class="muted-sm">还没有保存的账户。添加离线账户，或登录 Microsoft 账户。</p>';

    const encryption = ms.encryption || {};
    const warning = encryption.warning
      ? `<p class="account-security-warning">${esc(encryption.warning)}</p>`
      : `<p class="muted-sm">令牌由 ${esc(encryption.backend || '系统安全存储')} 加密保存，不会暴露给插件或网页。</p>`;

    panel.innerHTML = `<div class="account-panel-block">
      <div class="account-panel-title-row">
        <div class="account-panel-title">账户</div>
        <span class="muted-sm">${accounts.length} 个</span>
      </div>
      <div class="account-list">${list}</div>
      ${warning}
      ${ms.authenticated && ms.expired ? '<button class="btn small ghost" data-account-action="refresh">刷新 Microsoft 登录</button>' : ''}
    </div>
    <div class="account-panel-block">
      <div class="account-panel-title">添加离线账户</div>
      <div class="account-form">
        <input class="input" id="mp-offline-name" maxlength="16" value="${esc(offlineName)}" placeholder="Steve">
        <input class="input" id="mp-offline-note" maxlength="80" placeholder="备注（可选）">
        <button class="btn small primary" data-account-action="add-offline">添加并使用</button>
      </div>
      <p class="muted-sm">离线账户仅用于本地游戏与离线测试，不能加入正版验证服务器。</p>
    </div>
    <div class="account-panel-block">
      <div class="account-panel-title">Microsoft</div>
      <p class="muted-sm">登录后可以加入正版服务器，并显示正版皮肤。可以保存多个账户并随时切换。</p>
      <button class="btn small primary" data-account-action="login-ms">登录 Microsoft 账户</button>
    </div>`;

    panel.querySelectorAll('[data-account-avatar]').forEach((avatar) => {
      MP.setAvatar(avatar, avatar.dataset.accountAvatar);
    });

    panel.querySelectorAll('[data-account-action]').forEach((button) => {
      button.addEventListener('click', () => handleAccountAction(button.dataset.accountAction, button.dataset.accountId, panel));
    });
  }

  async function handleAccountAction(action, id, panel) {
    if (action === 'login-ms') {
      await startLogin(panel);
      return;
    }
    if (action === 'add-offline') {
      const nameInput = panel.querySelector('#mp-offline-name');
      const noteInput = panel.querySelector('#mp-offline-note');
      const name = nameInput ? nameInput.value.trim() : '';
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
        MP.toast('请输入 3–16 位字母、数字或下划线', 'err');
        return;
      }
      const result = await MP.api.invoke('auth:add-offline', { name, note: noteInput ? noteInput.value.trim() : '' });
      if (!result || !result.ok) {
        MP.toast((result && result.error) || '添加账户失败', 'err');
        return;
      }
      await refreshAccount();
      fillAccountPanel(panel);
      MP.toast(`已切换到 ${name}`, 'ok');
      return;
    }
    if (action === 'select') {
      const result = await MP.api.invoke('auth:select', id);
      if (!result || !result.ok) {
        MP.toast((result && result.error) || '切换账户失败', 'err');
        return;
      }
      await refreshAccount();
      fillAccountPanel(panel);
      MP.toast(`已切换到 ${(result.account && result.account.name) || '账户'}`, 'ok');
      return;
    }
    if (action === 'note') {
      const account = (accountState().microsoft.accounts || []).find((item) => item.id === id);
      const note = await MP.prompt({
        title: '账户备注',
        label: '例如“主号”“小号”“仅用于测试服务器”',
        value: (account && account.note) || '',
        maxlength: 80,
        confirmLabel: '保存备注',
      });
      if (note === null) return;
      const result = await MP.api.invoke('auth:update-account', { id, note });
      if (!result || !result.ok) {
        MP.toast((result && result.error) || '保存备注失败', 'err');
        return;
      }
      await refreshAccount();
      fillAccountPanel(panel);
      return;
    }
    if (action === 'remove') {
      const account = (accountState().microsoft.accounts || []).find((item) => item.id === id);
      const ok = await MP.confirm({
        title: '移除账户',
        text: `确定移除「${(account && account.name) || id}」吗？${account && account.type === 'microsoft' ? '本地保存的登录令牌会被删除。' : '离线账户不会被删除任何游戏数据。'}`,
        confirmLabel: '移除',
        danger: true,
      });
      if (!ok) return;
      const result = await MP.api.invoke('auth:remove-account', id);
      if (!result || !result.ok) {
        MP.toast((result && result.error) || '移除账户失败', 'err');
        return;
      }
      await refreshAccount();
      fillAccountPanel(panel);
      MP.toast('账户已移除', 'ok');
      return;
    }
    if (action === 'refresh') {
      const result = await MP.api.invoke('auth:refresh');
      if (!result || !result.ok) {
        MP.toast((result && result.error) || '刷新登录失败', 'err', 6000);
        return;
      }
      await refreshAccount();
      fillAccountPanel(panel);
      MP.toast('Microsoft 登录已刷新', 'ok');
    }
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

  /** 账户详情：UUID、令牌有效期、皮肤来源，可复制或导出脱敏 JSON。 */
  async function openAccountDetail() {
    let detail;
    try {
      detail = await MP.api.invoke('auth:profile-detail');
    } catch (err) {
      detail = { ok: false, error: err.message };
    }
    if (!detail || !detail.ok) {
      MP.toast(`读取账户详情失败：${(detail && detail.error) || '未知错误'}`, 'err', 6000);
      return;
    }
    const account = detail.account || {};
    const isMs = account.type === 'microsoft';
    const encryption = detail.encryption || {};
    const rows = [
      ['名称', account.name || '—'],
      ['类型', isMs ? 'Microsoft 正版' : '离线账户'],
      ['UUID', account.uuid || '—'],
      ['登录状态', isMs ? (account.expired ? '已过期，启动时会自动刷新' : '有效') : '本地离线，无需登录'],
      ['令牌到期', isMs && account.expiresAt ? new Date(account.expiresAt).toLocaleString() : '—'],
      ['皮肤来源', `${(detail.skin && detail.skin.sourceText) || '默认'}${detail.skin && detail.skin.name ? ` · ${detail.skin.name}` : ''}`],
      ['本地账户数', String(detail.accountCount || 0)],
      ['令牌存储', encryption.available ? `已加密（${encryption.backend || 'safeStorage'}）` : '系统安全存储不可用，退回明文'],
    ];
    const bodyRows = rows.map(([label, value]) => `<div class="account-detail-row"><span class="muted-sm">${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
    await MP.modal({
      title: '账户详情',
      width: 520,
      body: `<div class="account-detail">${bodyRows}</div>
        <p class="muted-sm">UUID 用于识别你在服务器上的身份；令牌本身不会显示在界面上。导出为脱敏 JSON 时也不包含令牌。</p>`,
      actions: [
        { label: '关闭', value: null },
        {
          label: '复制 UUID',
          onClick: async () => {
            if (!account.uuid) {
              MP.toast('当前账户没有 UUID', 'warn');
              return false;
            }
            await copyText(account.uuid);
            MP.toast('UUID 已复制', 'ok');
            return false;
          },
        },
        {
          label: '导出脱敏 JSON',
          kind: 'primary',
          onClick: async () => {
            let result;
            try {
              result = await MP.api.invoke('auth:export-clean');
            } catch (err) {
              result = { ok: false, error: err.message };
            }
            if (result && result.ok) MP.toast(`已导出 ${result.count} 个账户（不含令牌）`, 'ok', 6000);
            else if (result && !result.canceled) MP.toast((result && result.error) || '导出失败', 'err', 6000);
            return false;
          },
        },
      ],
    });
  }

  MP.openAccountDetail = openAccountDetail;

  MP.openMicrosoftLogin = () => openAccountModal();
})();