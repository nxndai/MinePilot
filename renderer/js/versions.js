'use strict';

(function () {
  const { $, esc } = MP;

  const COLORS = {
    vanilla: ['#3b82f6', '#1c3f86'],
    fabric: ['#f0a13a', '#9a5510'],
    forge: ['#8b6cf0', '#4b2ba0'],
    neoforge: ['#3ecf8e', '#10704a'],
    quilt: ['#ef6ba8', '#861c50'],
    optifine: ['#ef6a6a', '#831d1d'],
    liteloader: ['#4bb3d4', '#135a70'],
  };

  const SHORT = {
    vanilla: 'MC',
    fabric: 'FA',
    forge: 'FG',
    neoforge: 'NF',
    quilt: 'QT',
    optifine: 'OF',
    liteloader: 'LL',
  };

  const LOADER_ORDER = ['fabric', 'forge', 'neoforge', 'quilt'];

  const LOADER_LABELS = {
    fabric: 'Fabric',
    forge: 'Forge',
    neoforge: 'NeoForge',
    quilt: 'Quilt',
  };

  const LOADER_HINTS = {
    fabric: '轻量、更新快，适合绝大多数客户端和优化模组。',
    forge: '老牌加载器，模组生态最广；安装器需要可用的 Java。',
    neoforge: 'Forge 的现代分支，适合 1.20.1 及之后的新版本模组。',
    quilt: 'Fabric 的兼容分支，支持 Quilt 专属模组和大部分 Fabric 模组。',
  };

  const LOADER_MANUAL = {
    fabric: 'https://fabricmc.net/use/installer/',
    forge: 'https://files.minecraftforge.net/net/minecraftforge/forge/',
    neoforge: 'https://neoforged.net/',
    quilt: 'https://quiltmc.org/install/',
  };

  function iconInfo(version) {
    const key = version.loaders.length ? version.loaders[0].key : 'vanilla';
    return {
      key,
      label: SHORT[key] || 'MC',
      colors: COLORS[key] || COLORS.vanilla,
    };
  }

  function rowHTML(version) {
    const icon = iconInfo(version);
    const loaderBadges = version.loaders.map((loader) => {
      const cls = {
        fabric: 'orange',
        forge: 'violet',
        neoforge: 'green',
        quilt: 'pink',
        optifine: 'red',
        liteloader: 'cyan',
      }[loader.key] || '';
      return `<span class="badge ${cls}">${esc(loader.name)}${loader.version ? ` ${esc(loader.version)}` : ''}</span>`;
    }).join('');
    const incomplete = version.incomplete ? '<span class="badge orange">文件不完整</span>' : '';
    const isolation = version.isolation ? '<span class="badge green">版本隔离</span>' : '';
    const lastPlayed = version.lastPlayed ? `上次游玩 ${MP.fmtRelative(version.lastPlayed)}` : '从未启动';

    return `<div class="card version-row" data-id="${esc(version.id)}">
      <div class="v-icon" style="--c1:${icon.colors[0]};--c2:${icon.colors[1]}" title="${esc(icon.key)}">${icon.label}</div>
      <div class="v-main">
        <div class="v-title">${esc(version.id)}${loaderBadges}${incomplete}${isolation}</div>
        <div class="v-meta">
          <span>Minecraft ${esc(version.mcVersion)}</span><span class="sep"></span>
          <span>${version.isolation ? '版本隔离' : '全局'} ${version.mods ? version.mods.count : 0} 个 Mod</span><span class="sep"></span>
          <span>需要 Java ${version.requiredJava}</span><span class="sep"></span>
          <span>${lastPlayed}</span>
        </div>
      </div>
      <div class="v-actions">
        <button class="btn tiny ghost" data-act="loader" title="一键安装 Fabric / Forge / NeoForge / Quilt">加载器</button>
        <button class="btn tiny ghost" data-act="open">打开目录</button>
        <button class="btn tiny ghost" data-act="mods">Mods</button>
        <button class="btn tiny ghost" data-act="select">选择</button>
        <button class="btn tiny danger" data-act="delete">删除</button>
      </div>
    </div>`;
  }

  function render() {
    const list = $('#version-list');
    const empty = $('#versions-empty');
    if (!list) return;

    const versions = MP.state.versions;
    if ($('#versions-count')) $('#versions-count').textContent = String(versions.length);

    if (!versions.length) {
      list.innerHTML = '';
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    list.innerHTML = versions.map(rowHTML).join('');
  }

  async function fetchLoaderVersions(type, mcVersion) {
    const result = await MP.api.invoke('loader:versions', { type, mcVersion });
    if (!result.ok) throw new Error(result.error || '无法获取加载器版本');
    return result.versions || [];
  }

  function loaderLabel(type) {
    return LOADER_LABELS[type] || type;
  }

  function installedLoader(version, type) {
    return (version.loaders || []).find((item) => item.key === type) || null;
  }

  async function installLoader(version) {
    if (MP.state.installing) {
      MP.toast('已有安装任务正在进行', 'warn');
      return;
    }

    const installed = {};
    for (const type of LOADER_ORDER) {
      const hit = installedLoader(version, type);
      if (hit) installed[type] = hit.version || '已安装';
    }
    let selectedType = LOADER_ORDER.find((type) => installed[type]) || 'fabric';
    let cache = {};
    let currentList = [];
    let loading = false;

    const tabsHTML = LOADER_ORDER.map((type) => {
      const active = type === selectedType;
      const mark = installed[type] ? `<em>已装 ${esc(installed[type])}</em>` : '';
      return `<button class="btn small ${active ? 'primary' : 'ghost'} loader-tab" data-loader="${type}">
        <span>${loaderLabel(type)}</span>${mark}
      </button>`;
    }).join('');

    const choice = await MP.modal({
      title: `为 Minecraft ${version.mcVersion} 安装模组加载器`,
      width: 520,
      body: `<p class="muted-sm">自动识别该 Minecraft 版本可用的加载器版本，选好后一键下载安装，不需要手动下载或放置文件。</p>
        <div class="loader-tabs" id="mp-loader-tabs">${tabsHTML}</div>
        <div class="loader-panel">
          <div class="loader-status-line">
            <span class="badge" id="mp-loader-state">正在检测…</span>
            <span class="muted-sm" id="mp-loader-current"></span>
          </div>
          <label class="muted-sm" for="mp-loader-version">加载器版本</label>
          <select class="input select" id="mp-loader-version" style="width:100%;margin-top:6px" disabled>
            <option>正在获取版本…</option>
          </select>
          <p class="muted-sm" id="mp-loader-hint" style="margin-top:9px">正在自动匹配版本…</p>
          <p class="muted-sm">自动下载失败时，可以 <button type="button" class="mod-inline-link" id="mp-loader-manual">打开官方下载页</button>，手动运行安装器；装好后回到本页刷新版本列表。</p>
        </div>`,
      actions: [
        { label: '取消', value: null },
        {
          label: '一键安装',
          kind: 'primary',
          onClick: (box) => {
            if (loading) {
              MP.toast('正在获取加载器版本，请稍候', 'warn');
              return false;
            }
            const select = box.querySelector('#mp-loader-version');
            const loaderVersion = select ? select.value : '';
            if (!loaderVersion) {
              MP.toast('没有可安装的版本，请切换加载器或稍后重试', 'warn');
              return false;
            }
            return { type: selectedType, version: loaderVersion };
          },
        },
      ],
      onMount: (box) => {
        const tabs = box.querySelector('#mp-loader-tabs');
        const select = box.querySelector('#mp-loader-version');
        const hint = box.querySelector('#mp-loader-hint');
        const state = box.querySelector('#mp-loader-state');
        const current = box.querySelector('#mp-loader-current');
        const manual = box.querySelector('#mp-loader-manual');
        const installButton = box.querySelector('.modal-actions .btn.primary');

        const setState = (text, kind) => {
          if (!state) return;
          state.textContent = text;
          state.className = `badge ${kind || ''}`.trim();
        };
        const setCurrent = (text) => {
          if (current) current.textContent = text || '';
        };
        const setTabs = () => {
          tabs.querySelectorAll('[data-loader]').forEach((button) => {
            const active = button.dataset.loader === selectedType;
            button.classList.toggle('primary', active);
            button.classList.toggle('ghost', !active);
          });
        };
        const selectedItem = () => currentList.find((item) => item.version === select.value) || null;

        const updateSelection = () => {
          if (!select.value) return;
          const item = selectedItem();
          const label = loaderLabel(selectedType);
          const already = installed[selectedType];
          if (already) {
            setCurrent(`当前已安装 ${label} ${already}`);
          } else {
            setCurrent('当前版本尚未安装该加载器');
          }
          if (item && item.recommended) setState(`推荐 ${item.version}`, 'green');
          else if (item && item.latest) setState(`最新 ${item.version}`, 'orange');
          else setState(`可安装 ${select.value}`, '');
          if (installButton) {
            installButton.textContent = already && item && item.version !== already
              ? '一键更新'
              : (already ? '一键重装' : '一键安装');
          }
          if (hint) {
            const suffix = already && item && item.version !== already
              ? `当前已安装 ${already}，可以在这里更新到 ${item.version}。`
              : LOADER_HINTS[selectedType];
            hint.textContent = `将自动下载并安装 ${label} ${select.value}；${suffix}`;
          }
        };

        const load = async (type) => {
          selectedType = type;
          loading = true;
          currentList = [];
          setTabs();
          setState(`正在识别 ${loaderLabel(type)}…`, '');
          setCurrent(installed[type] ? `当前已安装 ${installed[type]}` : '');
          if (installButton) installButton.disabled = true;
          if (select) {
            select.disabled = true;
            select.innerHTML = '<option>正在获取版本…</option>';
          }
          if (hint) hint.textContent = '正在自动匹配该 Minecraft 版本的加载器版本…';

          try {
            if (!cache[type]) cache[type] = await fetchLoaderVersions(type, version.mcVersion);
            if (!box.isConnected) return;
            currentList = cache[type];
            const list = currentList;
            if (!list.length) throw new Error(`没有找到 ${loaderLabel(type)} 版本`);

            const preferred = list.find((item) => item.recommended) || list.find((item) => item.latest) || list[0];
            const visible = list.slice(0, 100);
            if (preferred && !visible.includes(preferred)) visible.unshift(preferred);
            select.innerHTML = visible.map((item) => {
              const marks = [item.recommended ? '推荐' : '', item.latest ? '最新' : ''].filter(Boolean).join(' · ');
              return `<option value="${esc(item.version)}">${esc(item.version)}${marks ? `（${marks}）` : ''}</option>`;
            }).join('');
            select.value = preferred.version;
            select.disabled = false;
            if (installButton) installButton.disabled = false;
            updateSelection();
          } catch (err) {
            if (!box.isConnected) return;
            currentList = [];
            select.innerHTML = '<option value="">获取失败</option>';
            select.disabled = true;
            if (installButton) installButton.disabled = true;
            setState('获取失败', 'red');
            setCurrent(installed[type] ? `当前已安装 ${installed[type]}` : '');
            if (hint) hint.textContent = `${err.message || '获取版本失败'}。可以重新点击 ${loaderLabel(type)} 标签重试。`;
          } finally {
            loading = false;
            setTabs();
          }
        };

        tabs.querySelectorAll('[data-loader]').forEach((button) => {
          button.addEventListener('click', () => {
            if (loading) return;
            load(button.dataset.loader);
          });
        });
        if (select) select.addEventListener('change', updateSelection);
        if (manual) {
          manual.addEventListener('click', () => {
            const url = LOADER_MANUAL[selectedType];
            if (url) MP.openExternal(url);
          });
        }
        load(selectedType);
      },
    });

    if (!choice) return;
    const request = {
      versionId: version.mcVersion,
      loader: choice.type,
      loaderVersion: choice.version,
    };

    try {
      const result = await MP.installWithProgress(request, `正在安装 ${loaderLabel(choice.type)} ${choice.version}`);
      const finalId = (result && result.versionId) || version.mcVersion;
      MP.selectVersion(finalId);
      await MP.refreshVersions();
      MP.toast(`${loaderLabel(choice.type)} 安装完成：${finalId}`, 'ok', 5000);
    } catch (err) {
      MP.toast(`安装失败：${err.message}`, 'err', 7000);
      if (err.code === 'NO_JAVA' && MP.go) {
        setTimeout(() => MP.go('settings'), 600);
      }
    }
  }

  async function onClick(event) {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const row = button.closest('.version-row');
    if (!row) return;
    const id = row.dataset.id;
    const action = button.dataset.act;

    if (action === 'loader') {
      const version = MP.state.versions.find((item) => item.id === id);
      if (version) await installLoader(version);
      return;
    }
    if (action === 'open') {
      const result = await MP.api.invoke('versions:open-folder', id);
      if (!result.ok) MP.toast(`无法打开目录：${result.error}`, 'err');
      return;
    }
    if (action === 'mods') {
      const result = await MP.api.invoke('versions:open-mods', id);
      if (!result.ok) MP.toast(`无法打开 Mods 目录：${result.error}`, 'err');
      return;
    }
    if (action === 'select') {
      MP.selectVersion(id);
      MP.go('home');
      MP.toast(`已选择 ${id}`, 'ok');
      return;
    }
    if (action === 'delete') {
      const version = MP.state.versions.find((item) => item.id === id);
      const extra = version && version.isolation ? '该版本隔离的存档、模组与配置也会一起删除。' : '';
      const ok = await MP.confirm({
        title: '删除版本',
        text: `确定要删除“${id}”吗？该版本文件夹会被永久删除，且无法恢复。${extra}`,
        confirmLabel: '删除',
        danger: true,
      });
      if (!ok) return;
      button.disabled = true;
      const result = await MP.api.invoke('versions:delete', id);
      if (!result.ok) {
        button.disabled = false;
        MP.toast(`删除失败：${result.error}`, 'err');
        return;
      }
      MP.toast(`已删除 ${id}`, 'ok');
      await MP.refreshVersions();
    }
  }

  let bound = false;

  function init() {
    if (bound) return;
    bound = true;
    MP.on('#version-list', 'click', onClick);
  }

  MP.views.versions = {
    init,
    render,
    openLoader: installLoader,
    onShow: async () => {
      await MP.refreshVersions();
    },
  };
})();