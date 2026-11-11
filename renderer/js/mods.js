'use strict';

(function () {
  const { $, esc } = MP;

  const LOADER_LABELS = {
    fabric: 'Fabric',
    forge: 'Forge',
    neoforge: 'NeoForge',
    quilt: 'Quilt',
  };

  const SOURCE_LABELS = {
    modrinth: 'Modrinth',
    curseforge: 'CurseForge',
  };

  const MODRINTH_CATEGORIES = [
    { id: 'utility', label: '功能' },
    { id: 'optimization', label: '优化' },
    { id: 'technology', label: '科技' },
    { id: 'magic', label: '魔法' },
    { id: 'adventure', label: '冒险' },
    { id: 'decoration', label: '装饰' },
    { id: 'worldgen', label: '世界生成' },
    { id: 'library', label: '库/API' },
    { id: 'storage', label: '存储' },
    { id: 'equipment', label: '装备' },
    { id: 'mobs', label: '生物' },
    { id: 'transportation', label: '运输' },
    { id: 'food', label: '食物' },
    { id: 'game-mechanics', label: '游戏机制' },
    { id: 'management', label: '管理' },
    { id: 'minigame', label: '小游戏' },
    { id: 'social', label: '社交' },
  ];

  let bound = false;
  let hits = [];
  let totalHits = 0;
  let loading = false;
  let installing = false;
  let currentTitle = '';
  let searchSeq = 0;
  let lastTargetId = '';
  let source = 'modrinth';
  let projectType = 'mod';
  let category = '';
  let categories = {
    modrinth: MODRINTH_CATEGORIES,
    curseforge: [],
  };
  let cfCategoriesLoading = false;
  let lastCfKey = '';
  let lastOnline = false;
  let lastSearchError = '';
  const installedKeys = new Set();
  let installedMods = [];
  let installedSeq = 0;
  let installedHealth = null;
  let installedDirs = [];
  let installedUpdates = [];
  let updateBusy = false;
  let batchBusy = false;
  let packBusy = false;
  let packMode = '';

  function onlineDownloadsEnabled() {
    return Boolean(MP.state.settings && MP.state.settings.onlineDownloads);
  }

  function isModpack() {
    return projectType === 'modpack';
  }

  function projectTypeLabel() {
    return isModpack() ? '整合包' : '模组';
  }

  function targetVersion() {
    const select = $('#mod-target');
    const id = select ? select.value : MP.state.selectedVersion;
    return (MP.state.versions || []).find((version) => version.id === id) || null;
  }

  function loaderKey(version) {
    const loaders = version && Array.isArray(version.loaders) ? version.loaders : [];
    const hit = loaders.find((item) => item && LOADER_LABELS[item.key]);
    return hit ? hit.key : '';
  }

  function loaderText(version) {
    const key = loaderKey(version);
    return key ? LOADER_LABELS[key] : '原版';
  }

  // 同一个 Minecraft 版本可能已经装过 Forge/Fabric 实例，只是当前选中的
  // 是原版。优先让用户切过去，而不是再下载一个加载器。
  function loaderAlternatives(target) {
    if (!target) return [];
    return (MP.state.versions || []).filter((version) => (
      version.id !== target.id
      && String(version.mcVersion || '') === String(target.mcVersion || '')
      && loaderKey(version)
    )).sort((a, b) => {
      // 优先展示干净、模组少的实例，避免一上来就把几百个模组的整合包
      // 当成推荐目标；再按最近启动时间排序。
      const ac = Number(a.mods && a.mods.count) || 0;
      const bc = Number(b.mods && b.mods.count) || 0;
      if (ac !== bc) return ac - bc;
      return (Number(b.lastPlayed) || 0) - (Number(a.lastPlayed) || 0);
    });
  }

  function currentQuery() {
    const input = $('#mod-search');
    return input ? input.value.trim() : '';
  }

  function currentCategoryLabel() {
    if (!category) return '全部';
    const item = activeCategories().find((entry) => String(entry.id) === String(category));
    return item ? item.label : category;
  }

  function diagnosticText() {
    const target = targetVersion();
    return [
      'MinePilot 模组搜索诊断',
      `数据源: ${SOURCE_LABELS[source]}`,
      `目标版本: ${target ? target.id : '未选择'}`,
      `Minecraft: ${target ? (target.mcVersion || '未知') : '未知'}`,
      `加载器: ${target ? loaderText(target) : '未知'}`,
      `关键词: ${currentQuery() || '（空）'}`,
      `分类: ${currentCategoryLabel()}`,
      `在线下载: ${onlineDownloadsEnabled() ? '开启' : '关闭'}`,
      `已加载结果: ${hits.length}/${totalHits}`,
      `最近错误: ${lastSearchError || '无'}`,
    ].join('\n');
  }

  async function copyDiagnostic() {
    const ok = await MP.copyText(diagnosticText());
    MP.toast(ok ? '搜索信息已复制，可以直接粘贴发送' : '复制失败，请截图本页', ok ? 'ok' : 'warn', 5000);
  }

  function cfKey() {
    return String((MP.state.settings && MP.state.settings.curseforgeApiKey) || '').trim();
  }

  function activeCategories() {
    return categories[source] || [];
  }

  function categoryLabel() {
    if (!category) return '';
    const item = activeCategories().find((entry) => String(entry.id) === String(category));
    return item ? item.label : '';
  }

  function updateSourceUI() {
    MP.$$('#mod-source-tabs button').forEach((button) => {
      button.classList.toggle('active', button.dataset.modSource === source);
    });
    MP.$$('#mod-type-tabs button').forEach((button) => {
      button.classList.toggle('active', button.dataset.modType === projectType);
    });
    if ($('#mod-source-chip')) {
      $('#mod-source-chip').textContent = source === 'curseforge' && !cfKey()
        ? 'CurseForge 未配置 Key'
        : `数据源 ${SOURCE_LABELS[source]}`;
    }
    const missingKey = source === 'curseforge' && !cfKey();
    const offline = !onlineDownloadsEnabled();
    if ($('#mod-search')) {
      $('#mod-search').disabled = missingKey || offline;
      $('#mod-search').placeholder = offline
        ? '在线下载已关闭，请先在设置中开启'
        : isModpack()
          ? '搜索 Modrinth 整合包，例如 Fabulously Optimized'
          : source === 'curseforge'
            ? '搜索 CurseForge 模组，例如 JEI、Create'
            : '搜索 Modrinth 模组，例如 Sodium、JEI、Create';
    }
    if ($('#btn-mod-search')) $('#btn-mod-search').disabled = missingKey || offline;
    if ($('#mod-source-chip') && offline) $('#mod-source-chip').textContent = '在线下载已关闭';
  }

  function renderCategories() {
    const wrap = $('#mod-cats');
    if (!wrap) return;
    if (isModpack()) {
      wrap.innerHTML = '<span class="mod-key-note">整合包会创建独立实例，下载后再选择启动</span>';
      return;
    }
    if (source === 'curseforge' && !cfKey()) {
      wrap.innerHTML = '<span class="mod-key-note">填写 CurseForge API Key 后可按分类筛选</span>';
      return;
    }
    const list = activeCategories();
    if (source === 'curseforge' && cfCategoriesLoading && !list.length) {
      wrap.innerHTML = '<span class="mod-key-note">正在读取 CurseForge 分类…</span>';
      return;
    }
    const all = `<button class="mod-cat${category ? '' : ' active'}" data-mod-category="">全部</button>`;
    wrap.innerHTML = all + list.map((item) => (
      `<button class="mod-cat${String(item.id) === String(category) ? ' active' : ''}" data-mod-category="${esc(item.id)}">${esc(item.label)}</button>`
    )).join('');
  }

  async function ensureCategories() {
    if (!onlineDownloadsEnabled() || source !== 'curseforge' || !cfKey()) {
      renderCategories();
      return;
    }
    if (categories.curseforge.length || cfCategoriesLoading) {
      renderCategories();
      return;
    }
    cfCategoriesLoading = true;
    renderCategories();
    try {
      const result = await MP.api.invoke('mods:categories', { source: 'curseforge' });
      if (result.ok && Array.isArray(result.categories)) {
        categories.curseforge = result.categories;
      } else if (!result.ok) {
        MP.toast(`读取 CurseForge 分类失败：${result.error}`, 'warn', 6000);
      }
    } catch (err) {
      MP.toast(`读取 CurseForge 分类失败：${err.message}`, 'warn', 6000);
    } finally {
      cfCategoriesLoading = false;
      renderCategories();
    }
  }

  function fmtCount(value) {
    const count = Number(value) || 0;
    if (count >= 100000000) return `${(count / 100000000).toFixed(1)} 亿`;
    if (count >= 10000) return `${(count / 10000).toFixed(1)} 万`;
    return count.toLocaleString('zh-CN');
  }

  function iconHTML(hit) {
    const url = String(hit.iconUrl || '');
    if (/^https:\/\/(cdn\.modrinth\.com|media\.forgecdn\.net|edge\.forgecdn\.net)\//i.test(url)) {
      return `<div class="mod-icon"><img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>`;
    }
    const letter = String(hit.title || hit.slug || 'M').trim().slice(0, 1).toUpperCase() || 'M';
    return `<div class="mod-icon">${esc(letter)}</div>`;
  }

  function updateHint() {
    const hint = $('#mod-hint');
    if (!hint) return;
    const target = targetVersion();
    hint.classList.remove('warn', 'actionable');
    if (!target) {
      hint.textContent = '还没有已安装的版本，请先去「下载」安装一个游戏版本。';
      return;
    }
    if (source === 'curseforge' && !cfKey()) {
      hint.classList.add('warn');
      hint.textContent = 'CurseForge 需要 API Key：请到「设置 → 模组来源」填写；Modrinth 不需要配置，可直接使用。';
      return;
    }
    if (isModpack()) {
      if (source !== 'modrinth') {
        hint.classList.add('warn');
        hint.textContent = '在线整合包目前只支持 Modrinth；CurseForge 整合包请用下方「导入整合包」选择本地 .zip 清单。';
        return;
      }
      hint.textContent = `搜索 Modrinth 整合包 · 下载 .mrpack 后会创建独立实例，不会修改当前 ${target.id}`;
      return;
    }
    const loader = loaderKey(target);
    // Modrinth 的 1.20 版本筛选基本为空，绝大多数项目只标记 1.20.1。
    // 原版 1.20 还需要先安装加载器；这里直接给出可执行的下一步，避免误判为网络问题。
    if (source === 'modrinth' && String(target.mcVersion || '') === '1.20') {
      hint.classList.add('warn');
      hint.textContent = loader
        ? `${target.id} 使用 Minecraft 1.20。Modrinth 上几乎没有只标记 1.20 的模组，绝大多数模组使用 1.20.1；请安装 1.20.1 + ${LOADER_LABELS[loader]} 的实例。`
        : `${target.id} 是原版 Minecraft 1.20，没有模组加载器；而且 Modrinth 上几乎没有 1.20 模组。请安装 1.20.1，并为它安装 Forge、Fabric 或 NeoForge。`;
      return;
    }
    if (!loader) {
      hint.classList.add('warn', 'actionable');
      const alternatives = loaderAlternatives(target).slice(0, 2);
      const switches = alternatives.map((version) => (
        `<button type="button" class="mod-inline-link" data-mod-use-target="${esc(version.id)}">${esc(version.id)}（${esc(loaderText(version))}）</button>`
      )).join('、');
      hint.innerHTML = alternatives.length
        ? `${esc(target.id)} 是原版，不能加载模组。你已安装 ${switches}，切换过去即可安装。也可以 <button type="button" class="mod-inline-link" data-mod-install-loader="${esc(target.id)}">为 ${esc(target.id)} 安装加载器</button>。`
        : `${esc(target.id)} 没有安装模组加载器。可以先把模组下载到 mods 目录，但游戏不会加载；建议先 <button type="button" class="mod-inline-link" data-mod-install-loader="${esc(target.id)}">安装 Fabric / Forge / NeoForge</button>。`;
      return;
    }
    const cat = categoryLabel();
    hint.textContent = `将安装到 ${target.id} 的 mods 目录 · Minecraft ${target.mcVersion || '未知'} · ${LOADER_LABELS[loader]} · 来源 ${SOURCE_LABELS[source]}${cat ? ` · 分类 ${cat}` : ''}`;
  }

  function setEmpty(title, text) {
    const empty = $('#mod-empty');
    if (!empty) return;
    empty.classList.remove('hidden');
    if ($('#mod-empty-title')) $('#mod-empty-title').textContent = title;
    if ($('#mod-empty-text')) $('#mod-empty-text').textContent = text;
  }

  function hideEmpty() {
    if ($('#mod-empty')) $('#mod-empty').classList.add('hidden');
  }

  function populateTargets() {
    const select = $('#mod-target');
    if (!select) return;
    const versions = MP.state.versions || [];
    const previous = select.value;
    const ids = new Set(versions.map((version) => version.id));

    if (!versions.length) {
      select.innerHTML = '<option value="">没有已安装版本</option>';
      select.disabled = true;
      lastTargetId = '';
      updateHint();
      return;
    }

    select.innerHTML = versions.map((version) => {
      const label = `${version.id} · ${version.mcVersion || '未知版本'} · ${loaderText(version)}`;
      return `<option value="${esc(version.id)}">${esc(label)}</option>`;
    }).join('');
    select.disabled = false;

    let desired = previous && ids.has(previous) ? previous : '';
    if (!desired && MP.state.selectedVersion && ids.has(MP.state.selectedVersion)) {
      desired = MP.state.selectedVersion;
    }
    if (!desired) desired = versions[0].id;
    select.value = desired;
    lastTargetId = desired;
    updateHint();
  }

  function projectUrl(hit) {
    if (hit && hit.externalUrl) return String(hit.externalUrl);
    if (!hit) return '';
    const slug = encodeURIComponent(String(hit.slug || hit.projectId || ''));
    if (!slug) return '';
    if (hit.source === 'CurseForge') return `https://www.curseforge.com/minecraft/mc-mods/${slug}`;
    return `https://modrinth.com/${encodeURIComponent(String(hit.projectType || 'mod'))}/${slug}`;
  }

  function sideBadge(hit) {
    if (!hit || !hit.clientSide || hit.clientSide === 'unknown') return '';
    if (hit.clientSide === 'unsupported') return '<span class="badge orange">仅服务端</span>';
    if (hit.clientSide === 'required') return '<span class="badge green">客户端</span>';
    if (hit.clientSide === 'optional' && hit.serverSide === 'required') {
      return '<span class="badge gray">客户端可选 · 服务端必需</span>';
    }
    return '<span class="badge gray">双端</span>';
  }

  function rowHTML(hit) {
    const target = targetVersion();
    const pack = isModpack();
    const key = target && !pack ? `${source}|${target.id}|${hit.projectId}` : '';
    const installed = key && installedKeys.has(key);
    const loaderNames = new Set(['fabric', 'forge', 'neoforge', 'quilt', 'Fabric', 'Forge', 'NeoForge', 'Quilt']);
    const categories = (hit.categories || []).filter((item) => !loaderNames.has(item));
    const shownCategories = categories.slice(0, 3);
    const tags = shownCategories.map((item) => `<span class="badge gray">${esc(item)}</span>`).join('');
    const loaderBadge = !pack && target && loaderKey(target)
      ? `<span class="badge">${esc(LOADER_LABELS[loaderKey(target)])}</span>`
      : '';
    const installedBadge = installed ? '<span class="badge green">已安装</span>' : '';
    const url = projectUrl(hit);
    const serverOnly = !pack && hit.clientSide === 'unsupported';
    const noLoader = !pack && Boolean(target && !loaderKey(target));
    const blocked = hit.installable === false;
    const action = blocked
      ? '<button class="btn small" disabled title="作者关闭了第三方下载">禁止下载</button>'
      : pack
        ? `<button class="btn small primary" data-modpack-install="${esc(hit.projectId)}" data-modpack-title="${esc(hit.title)}">下载整合包</button>`
        : serverOnly
          ? '<button class="btn small" disabled title="这是仅服务端/插件版本，客户端无法加载">仅服务端</button>'
          : `<button class="btn small ${installed ? 'ghost' : 'primary'}" data-mod-install="${esc(hit.projectId)}" data-mod-title="${esc(hit.title)}"${noLoader ? ' title="当前实例没有加载器，下载后暂时不会生效"' : ''}>${noLoader ? '下载' : (installed ? '重新安装' : '安装')}</button>`;

    return `<div class="card mod-row">
      ${iconHTML(hit)}
      <div class="mod-main">
        <div class="mod-title">
          <button type="button" class="mod-title-link" data-mod-open="${esc(url)}" title="打开项目介绍页">${esc(hit.title)}</button>
          <span class="mod-author">by ${esc(hit.author || '未知作者')}</span>
          ${installedBadge}
        </div>
        <div class="mod-desc">${esc(hit.description || '没有简介')}</div>
        <div class="mod-tags">
          <span class="badge gray">${esc(SOURCE_LABELS[hit.source] || SOURCE_LABELS[source])}</span>
          ${loaderBadge}
          ${pack ? '<span class="badge violet">整合包</span>' : sideBadge(hit)}
          ${tags}
          <span class="mod-stat">下载 ${fmtCount(hit.downloads)}</span>
          <span class="mod-stat">更新于 ${MP.fmtDate(hit.dateModified)}</span>
          ${blocked ? '<span class="mod-stat" style="color:#e8bf76">作者禁止第三方下载</span>' : ''}
        </div>
      </div>
      <div class="mod-actions">
        ${url ? `<button class="btn small ghost" data-mod-open="${esc(url)}">介绍</button>` : ''}
        ${action}
      </div>
    </div>`;
  }

  function render() {
    const target = targetVersion();
    const list = $('#mod-list');
    const more = $('#mod-more-wrap');
    if (!list) return;

    updateHint();
    if (more) more.classList.toggle('hidden', loading || hits.length >= totalHits || !hits.length);

    if (!target) {
      list.innerHTML = '';
      setEmpty('还没有安装版本', '请先在「下载」页安装一个游戏版本，再回来安装模组。');
      return;
    }
    if (!onlineDownloadsEnabled()) {
      list.innerHTML = '';
      setEmpty('在线下载已关闭', '请先在「设置 → 下载」勾选“在线下载”；开启后回到本页会自动重新搜索。');
      return;
    }
    if (source === 'curseforge' && !cfKey()) {
      list.innerHTML = '';
      setEmpty('CurseForge 需要 API Key', '请到「设置 → 模组来源」填写 CurseForge API Key；Modrinth 开箱即可使用。');
      return;
    }
    if (!hits.length) {
      list.innerHTML = '';
      if (!loading) {
        const targetInfo = `目标：${target.id} · Minecraft ${target.mcVersion || '未知'} · ${loaderText(target)} · 数据源 ${SOURCE_LABELS[source]}`;
        const filterInfo = `搜索：${currentQuery() || '（空）'} · 分类：${currentCategoryLabel()}`;
        if (source === 'modrinth' && String(target.mcVersion || '') === '1.20') {
          const loader = loaderKey(target);
          setEmpty(
            'Minecraft 1.20 的模组很少',
            `${targetInfo}\n${filterInfo}。\nModrinth 上几乎没有只标记 1.20 的模组，绝大多数模组使用 1.20.1。`
              + (loader
                ? `请安装 1.20.1 + ${LOADER_LABELS[loader]} 的实例后再搜索。`
                : '当前实例还是原版，没有加载器；请安装 1.20.1，并为它安装 Forge、Fabric 或 NeoForge。')
          );
        } else {
          setEmpty(currentQuery() ? `没有找到${projectTypeLabel()}` : `这个筛选下暂时没有${projectTypeLabel()}`, `${targetInfo}\n${filterInfo}。换一个英文关键词，或切换分类/数据源后重试。`);
        }
      }
      return;
    }

    hideEmpty();
    list.innerHTML = hits.map(rowHTML).join('');
  }

  async function doSearch(reset) {
    if (!onlineDownloadsEnabled()) {
      MP.toast('在线下载已关闭。请先在「设置 → 下载」中勾选“在线下载”。', 'warn', 5500);
      render();
      return;
    }
    const target = targetVersion();
    if (!target) {
      render();
      return;
    }
    if (source === 'curseforge' && !cfKey()) {
      render();
      return;
    }
    if (isModpack() && source !== 'modrinth') {
      hits = [];
      totalHits = 0;
      render();
      setEmpty('在线整合包目前只支持 Modrinth', 'CurseForge 整合包请使用下方「导入整合包」选择本地 .zip 清单。');
      return;
    }
    const queryInput = $('#mod-search');
    const query = queryInput ? queryInput.value.trim() : '';
    const offset = reset ? 0 : hits.length;
    const seq = ++searchSeq;
    lastSearchError = '';
    loading = true;
    if (reset) {
      hits = [];
      totalHits = 0;
      if ($('#mod-more-wrap')) $('#mod-more-wrap').classList.add('hidden');
      if ($('#mod-list')) {
        $('#mod-list').innerHTML = `<div class="card" style="padding:24px;text-align:center;color:var(--muted)">正在从 ${SOURCE_LABELS[source]} 搜索…</div>`;
      }
      hideEmpty();
    }
    if ($('#btn-mod-search')) $('#btn-mod-search').disabled = true;
    if ($('#btn-mod-more')) $('#btn-mod-more').disabled = true;

    let result;
    try {
      result = await MP.api.invoke('mods:search', {
        source,
        projectType,
        category,
        query,
        gameVersion: target.mcVersion,
        loader: loaderKey(target),
        limit: 20,
        offset,
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (seq !== searchSeq) return;
    loading = false;
    const missingKey = source === 'curseforge' && !cfKey();
    if ($('#btn-mod-search')) $('#btn-mod-search').disabled = missingKey;
    if ($('#mod-search')) $('#mod-search').disabled = missingKey;
    if ($('#btn-mod-more')) $('#btn-mod-more').disabled = false;

    if (!result.ok) {
      lastSearchError = result.error || `无法连接 ${SOURCE_LABELS[source]}`;
      hits = [];
      totalHits = 0;
      render();
      setEmpty('搜索失败', result.error || `无法连接 ${SOURCE_LABELS[source]}，请检查网络后重试。`);
      return;
    }

    const next = Array.isArray(result.hits) ? result.hits : [];
    hits = reset ? next : hits.concat(next);
    totalHits = Number(result.totalHits) || hits.length;
    render();
  }

  async function chooseVersion(projectId, title) {
    const target = targetVersion();
    if (!target) {
      MP.toast('请先选择目标版本', 'warn');
      return;
    }
    let result;
    try {
      result = await MP.api.invoke('mods:versions', {
        source,
        projectId,
        gameVersion: target.mcVersion,
        loader: loaderKey(target),
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result.ok) {
      MP.toast(`读取${SOURCE_LABELS[source]}模组版本失败：${result.error}`, 'err', 6000);
      return;
    }

    const versions = (Array.isArray(result.versions) ? result.versions : []).filter((version) => version.file && version.file.url);
    if (!versions.length) {
      MP.toast('这个模组没有适用于当前版本/加载器的可下载文件', 'warn', 5500);
      return;
    }

    const options = versions.slice(0, 20).map((version) => {
      const fileSize = version.file && version.file.size ? ` · ${MP.fmtBytes(version.file.size)}` : '';
      const deps = version.dependencies.filter((dep) => dep.dependencyType === 'required').length;
      const depText = deps ? ` · ${deps} 个前置` : '';
      return `<option value="${esc(version.id)}">${esc(`${version.versionNumber || version.name} · ${MP.fmtDate(version.datePublished)}${fileSize}${depText}`)}</option>`;
    }).join('');

    const latest = versions[0];
    const loaderLabel = loaderKey(target) ? LOADER_LABELS[loaderKey(target)] : '未安装加载器';
    const picked = await MP.modal({
      title: `安装 ${title}`,
      width: 540,
      body: `<p>目标版本：<strong>${esc(target.id)}</strong> · Minecraft ${esc(target.mcVersion || '未知')} · ${esc(loaderLabel)} · 来源 ${esc(SOURCE_LABELS[source])}</p>
        <p class="muted-sm">选择要安装的文件；默认最新版本。下一步会检查并展示必需前置。</p>
        <select id="mod-version-pick" class="input mod-version-select">${options}</select>
        <p class="muted-sm">最新文件：${esc(latest.file.filename || '')}</p>`,
      actions: [
        { label: '取消', kind: 'ghost', value: null },
        {
          label: '安装',
          kind: 'primary',
          onClick: (box) => {
            const select = box.querySelector('#mod-version-pick');
            return select ? select.value : null;
          },
        },
      ],
    });
    if (!picked) return;
    const preview = await showDependencyPreview(title, projectId, picked, source);
    if (!preview.confirmed) return;
    await installMod(projectId, title, picked, source, preview);
  }

  async function chooseModpack(projectId, title) {
    if (source !== 'modrinth') {
      MP.toast('在线整合包目前只支持 Modrinth', 'warn', 5000);
      return;
    }
    const target = targetVersion();
    let result;
    try {
      result = await MP.api.invoke('mods:versions', {
        source: 'modrinth',
        projectId,
        gameVersion: target ? target.mcVersion : '',
        loader: target ? loaderKey(target) : '',
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result.ok) {
      MP.toast(`读取整合包版本失败：${result.error}`, 'err', 6000);
      return;
    }
    const versions = (Array.isArray(result.versions) ? result.versions : [])
      .filter((version) => version.file && version.file.url && /\.(mrpack|zip)$/i.test(version.file.filename || ''));
    if (!versions.length) {
      MP.toast('这个整合包没有适用于当前版本的可下载文件', 'warn', 5500);
      return;
    }
    const options = versions.slice(0, 20).map((version) => {
      const size = version.file && version.file.size ? ` · ${MP.fmtBytes(version.file.size)}` : '';
      return `<option value="${esc(version.id)}">${esc(`${version.versionNumber || version.name} · ${MP.fmtDate(version.datePublished)}${size}`)}</option>`;
    }).join('');
    const picked = await MP.modal({
      title: `下载整合包 · ${title}`,
      width: 540,
      body: `<p class="muted-sm">选择要下载的 .mrpack 文件；下载完成后会创建一个独立实例，不会修改当前 ${esc(target ? target.id : '实例')}。</p>
        <select id="modpack-version-pick" class="input mod-version-select">${options}</select>
        <p class="muted-sm">最新文件：${esc(versions[0].file.filename || '')}</p>`,
      actions: [
        { label: '取消', kind: 'ghost', value: null },
        {
          label: '下一步',
          kind: 'primary',
          onClick: (box) => {
            const select = box.querySelector('#modpack-version-pick');
            return select ? select.value : null;
          },
        },
      ],
    });
    if (!picked) return;
    const version = versions.find((item) => item.id === picked);
    if (!version) return;
    const confirmed = await MP.confirm({
      title: '创建独立实例',
      text: `将下载 ${version.file.filename || '整合包'}，并自动安装它需要的 Minecraft / 加载器。整个过程不会修改当前实例，完成后可以在版本列表里启动。`,
      confirmLabel: '下载并导入',
    });
    if (!confirmed) return;
    if (packBusy) {
      MP.toast('已有整合包任务正在进行', 'warn');
      return;
    }

    setPackBusy(true, 'download');
    showPackBar(`正在下载 ${title}`);
    try {
      result = await MP.api.invoke('modpack:download', {
        url: version.file.url,
        sha1: version.file.sha1 || '',
        filename: version.file.filename || `${title}.mrpack`,
        size: version.file.size || 0,
        title,
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    setPackBusy(false, '');
    if (!result || !result.ok) {
      hidePackBar();
      if (result && result.code === 'CANCELED') MP.toast('已取消下载', 'warn');
      else MP.toast(`下载整合包失败：${(result && result.error) || '未知错误'}`, 'err', 7000);
      return;
    }
    if ($('#pack-pb-title')) $('#pack-pb-title').textContent = `已导入 ${result.name || title}`;
    if ($('#pack-pb-phase')) $('#pack-pb-phase').textContent = '已创建独立实例，可以启动游戏了';
    if ($('#pack-pb-fill')) $('#pack-pb-fill').style.width = '100%';
    if ($('#pack-pb-percent')) $('#pack-pb-percent').textContent = '100%';
    await MP.refreshVersions();
    if (result.versionId) {
      MP.selectVersion(result.versionId);
      const select = $('#mod-target');
      if (select) select.value = result.versionId;
      populateTargets();
      lastTargetId = result.versionId;
    }
    await loadInstalled();
    if (Array.isArray(result.warnings) && result.warnings.length) {
      MP.toast(result.warnings[0], 'warn', 8000);
    } else {
      MP.toast(`已下载并导入 ${result.name || title}`, 'ok', 6000);
    }
  }

  function dependencyRow(node) {
    const depth = Math.max(0, Math.min(6, Number(node.depth) || 0));
    const role = depth === 0
      ? '<span class="badge cyan">主模组</span>'
      : node.optional
        ? '<span class="badge violet">推荐前置</span>'
        : '<span class="badge orange">必需前置</span>';
    const installed = node.installed ? '<span class="badge green">已存在</span>' : '<span class="badge gray">待安装</span>';
    const meta = [node.versionNumber, node.filename].filter(Boolean).join(' · ');
    const via = depth > 0 && node.parentName ? ` title="由 ${esc(node.parentName)} 依赖"` : '';
    const parent = depth > 0 && node.parentName ? ` · 由 ${esc(node.parentName)} 依赖` : '';
    return `<div class="dep-row" style="margin-left:${depth * 16}px"${via}>
      <span class="dep-arrow">${depth === 0 ? '●' : '↳'}</span>
      <div class="dep-main">
        <div class="dep-name">${esc(node.name || node.projectId || '未知模组')}</div>
        <div class="dep-meta">${esc(meta)}${parent}</div>
      </div>
      <div class="dep-badges">${role}${installed}</div>
    </div>`;
  }

  async function showDependencyPreview(title, projectId, versionId, sourceId) {
    const target = targetVersion();
    if (!target) return false;
    let result;
    try {
      result = await MP.api.invoke('mods:dependencies', {
        source: sourceId,
        projectId,
        versionId,
        targetVersionId: target.id,
        gameVersion: target.mcVersion,
        loader: loaderKey(target),
        title,
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }

    if (!result.ok) {
      const proceed = await MP.confirm({
        title: '依赖检查失败',
        text: `无法读取依赖关系：${result.error || '网络或来源接口异常'}。在缺少前置的情况下启动游戏可能崩溃，仍然要安装吗？`,
        confirmLabel: '仍然安装',
      });
      return { confirmed: Boolean(proceed), includeOptional: false };
    }

    const nodes = Array.isArray(result.nodes) ? result.nodes : [];
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const missing = nodes.filter((node) => !node.installed).length;
    const required = Number.isFinite(Number(result.requiredCount))
      ? Number(result.requiredCount)
      : nodes.filter((node) => node.required).length;
    const optional = Number.isFinite(Number(result.optionalCount))
      ? Number(result.optionalCount)
      : nodes.filter((node) => node.optional).length;
    const warningHtml = warnings.length
      ? `<div class="dep-warnings"><strong>依赖提示</strong><ul>${warnings.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>`
      : '';
    const optionalText = optional
      ? `<label class="dep-optional-toggle"><input type="checkbox" id="dep-include-optional" checked> 同时下载 ${optional} 个推荐前置（不会跳过必需前置）</label>`
      : '';
    const body = `<p>目标版本：<strong>${esc(target.id)}</strong> · Minecraft ${esc(target.mcVersion || '未知')} · ${esc(LOADER_LABELS[loaderKey(target)] || '未安装加载器')}</p>
      <p class="muted-sm">已检查 ${nodes.length} 个文件，其中 ${required} 个必需前置、${optional} 个推荐前置；${missing ? `有 ${missing} 个尚未安装` : '当前文件都已存在'}。确认后会按顺序自动补齐。</p>
      <div class="dep-tree">${nodes.map(dependencyRow).join('') || '<p class="muted-sm">没有解析到可下载的依赖文件。</p>'}</div>
      ${warningHtml}
      ${optionalText}
      <p class="muted-sm">推荐前置来自模组作者标注的 optional 依赖，默认一起安装，可在上方取消；必需前置不会被跳过。</p>`;

    const choice = await MP.modal({
      title: `依赖检查 · ${title}`,
      width: 560,
      body,
      actions: [
        { label: '取消', kind: 'ghost', value: null },
        {
          label: nodes.length > 1 ? '安装所选文件' : '开始安装',
          kind: 'primary',
          onClick: (box) => {
            const toggle = box.querySelector('#dep-include-optional');
            return { includeOptional: toggle ? toggle.checked : false };
          },
        },
      ],
    });
    if (!choice) return { confirmed: false, includeOptional: false };
    return { confirmed: true, includeOptional: Boolean(choice.includeOptional) };
  }

  function showInstallBar(title) {
    if ($('#mod-install-bar')) $('#mod-install-bar').classList.remove('hidden');
    if ($('#mod-ib-title')) $('#mod-ib-title').textContent = `正在安装 ${title}`;
    if ($('#mod-ib-phase')) $('#mod-ib-phase').textContent = '准备中…';
    if ($('#mod-ib-fill')) $('#mod-ib-fill').style.width = '0%';
    if ($('#mod-ib-percent')) $('#mod-ib-percent').textContent = '0%';
    if ($('#mod-ib-files')) $('#mod-ib-files').textContent = '';
    const cancel = $('#btn-cancel-mod');
    if (cancel) {
      cancel.disabled = false;
      cancel.textContent = '取消安装';
    }
  }

  function emitPluginDownload(name, payload) {
    if (MP.plugins && typeof MP.plugins.broadcast === 'function') MP.plugins.broadcast(name, payload);
  }

  function updateInstallProgress(progress) {
    if (!progress) return;
    emitPluginDownload('download:progress', {
      kind: 'mod',
      percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
      phase: progress.message || '',
    });
    if ($('#mod-install-bar')) $('#mod-install-bar').classList.remove('hidden');
    if (progress.message && $('#mod-ib-phase')) $('#mod-ib-phase').textContent = progress.message;
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    if ($('#mod-ib-fill')) $('#mod-ib-fill').style.width = `${percent}%`;
    if ($('#mod-ib-percent')) $('#mod-ib-percent').textContent = `${Math.round(percent)}%`;
    if ($('#mod-ib-files')) {
      if (progress.phase === 'download' && progress.index) {
        const size = progress.bytes ? ` · ${MP.fmtBytes(progress.bytes)}` : '';
        $('#mod-ib-files').textContent = `文件 ${progress.index}/${progress.total}${size}`;
      } else {
        $('#mod-ib-files').textContent = '';
      }
    }
  }

  async function installMod(projectId, title, versionId, sourceId, options = {}) {
    if (!onlineDownloadsEnabled()) {
      MP.toast('在线下载已关闭。请先在「设置 → 下载」中勾选“在线下载”。', 'warn', 5500);
      return;
    }
    if (installing) {
      MP.toast('已有模组正在安装', 'warn');
      return;
    }
    const installSource = SOURCE_LABELS[sourceId] ? sourceId : source;
    if (installSource === 'curseforge' && !cfKey()) {
      MP.toast('请先在「设置 → 模组来源」填写 CurseForge API Key', 'warn', 5000);
      return;
    }
    const target = targetVersion();
    if (!target) {
      MP.toast('请先选择目标版本', 'warn');
      return;
    }
    if (!loaderKey(target)) {
      const alt = loaderAlternatives(target)[0];
      const suggestion = alt
        ? `你已经安装了 ${alt.id}（${loaderText(alt)}），建议取消后切换到它再安装。`
        : '建议先为这个实例安装 Fabric、Forge 或 NeoForge。';
      const go = await MP.confirm({
        title: '目标版本没有模组加载器',
        text: `${target.id} 目前是原版版本，文件可以下载，但游戏不会加载。${suggestion}仍然要下载到它的 mods 目录吗？`,
        confirmLabel: '仍然下载',
      });
      if (!go) return;
    }

    installing = true;
    currentTitle = title;
    showInstallBar(title);
    emitPluginDownload('download:started', { kind: 'mod', projectId });
    let result;
    try {
      result = await MP.api.invoke('mods:install', {
        source: installSource,
        projectId,
        versionId,
        targetVersionId: target.id,
        gameVersion: target.mcVersion,
        loader: loaderKey(target),
        includeOptional: Boolean(options.includeOptional),
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    installing = false;
    emitPluginDownload('download:completed', {
      kind: 'mod',
      projectId,
      ok: Boolean(result && result.ok),
      error: (result && result.error) || '',
    });

    if (!result.ok) {
      if ($('#mod-install-bar')) $('#mod-install-bar').classList.add('hidden');
      if (result.code === 'CANCELED' || result.error === '已取消') {
        MP.toast('已取消安装', 'warn');
      } else {
        MP.toast(`安装失败：${result.error}`, 'err', 7000);
      }
      return;
    }

    installedKeys.add(`${installSource}|${target.id}|${projectId}`);
    if ($('#mod-ib-title')) $('#mod-ib-title').textContent = `已安装 ${title}`;
    if ($('#mod-ib-phase')) $('#mod-ib-phase').textContent = '安装完成，可以启动游戏了';
    if ($('#mod-ib-fill')) $('#mod-ib-fill').style.width = '100%';
    if ($('#mod-ib-percent')) $('#mod-ib-percent').textContent = '100%';

    if (result.portable) {
      MP.toast(`已改用便携 mods 目录：${result.modsDir}`, 'warn', 8000);
    }
    if (Array.isArray(result.warnings) && result.warnings.length) {
      MP.toast(result.warnings[0], 'warn', 7000);
    }
    MP.toast(`已从 ${SOURCE_LABELS[installSource]} 安装 ${result.count || 0} 个模组文件`, 'ok', 4500);

    await MP.refreshVersions();
    render();
    loadInstalled();
    setTimeout(() => {
      if (!installing && $('#mod-install-bar')) $('#mod-install-bar').classList.add('hidden');
    }, 2400);
  }

  async function cancelInstall() {
    const button = $('#btn-cancel-mod');
    if (button) {
      button.disabled = true;
      button.textContent = '正在取消…';
    }
    await MP.api.invoke('mods:cancel');
    setTimeout(() => {
      if (button && document.body.contains(button)) {
        button.disabled = false;
        button.textContent = '取消安装';
      }
    }, 1600);
  }

  async function openModsFolder() {
    const target = targetVersion();
    if (!target) {
      MP.toast('请先选择目标版本', 'warn');
      return;
    }
    const result = await MP.api.invoke('versions:open-mods', target.id);
    if (!result.ok) MP.toast(result.error || '无法打开 mods 目录', 'err', 5000);
  }

  function issueFiles() {
    const files = new Set();
    for (const issue of (installedHealth && installedHealth.issues) || []) {
      for (const file of issue.files || []) files.add(String(file).toLowerCase());
    }
    return files;
  }

  function visibleMods() {
    const query = String(($('#installed-filter') && $('#installed-filter').value) || '').trim().toLowerCase();
    const loader = String(($('#installed-loader-filter') && $('#installed-loader-filter').value) || '').toLowerCase();
    const side = String(($('#installed-side-filter') && $('#installed-side-filter').value) || '').toLowerCase();
    const status = String(($('#installed-status-filter') && $('#installed-status-filter').value) || '').toLowerCase();
    const bad = issueFiles();
    return installedMods.filter((mod) => {
      if (loader && String(mod.loader || '').toLowerCase() !== loader) return false;
      if (side && String(mod.side || 'both').toLowerCase() !== side) return false;
      if (status === 'enabled' && !mod.enabled) return false;
      if (status === 'disabled' && mod.enabled) return false;
      if (status === 'issues' && !bad.has(String(mod.filename || '').toLowerCase())) return false;
      if (!query) return true;
      return [mod.name, mod.filename, mod.modId, mod.version].some((value) => String(value || '').toLowerCase().includes(query));
    });
  }

  function renderHealth() {
    const root = $('#installed-health');
    if (!root) return;
    const issues = (installedHealth && installedHealth.issues) || [];
    const hasUpdates = installedUpdates.length > 0;
    if (!issues.length && !hasUpdates && !updateBusy) {
      root.classList.add('hidden');
      root.innerHTML = '';
      return;
    }
    root.classList.remove('hidden');
    const issueHTML = issues.length
      ? `<div class="installed-health-head"><strong>发现 ${issues.length} 个问题</strong><span>${installedHealth.errorCount || 0} 个错误 · ${installedHealth.warningCount || 0} 个提示</span></div>
        <div class="installed-issues">${issues.map((issue) => `
          <div class="installed-issue ${esc(issue.severity || 'warning')}">
            <span class="installed-issue-dot"></span>
            <div class="installed-issue-main">
              <strong>${esc(issue.title || '模组问题')}</strong>
              <p>${esc(issue.detail || '')}</p>
              ${Array.isArray(issue.files) && issue.files.length ? `<small>${esc(issue.files.slice(0, 5).join(' · '))}${issue.files.length > 5 ? ' …' : ''}</small>` : ''}
            </div>
          </div>
        `).join('')}</div>`
      : '<div class="installed-health-head ok"><strong>依赖检查通过</strong><span>没有发现缺失前置或重复 modid</span></div>';
    const updateHTML = updateBusy
      ? '<div class="installed-update-loading">正在通过 Modrinth 检查已启用模组的更新…</div>'
      : hasUpdates
        ? `<div class="installed-health-head"><strong>${installedUpdates.length} 个模组有更新</strong><span>按当前游戏版本与加载器匹配</span></div>
          <div class="installed-updates">${installedUpdates.map((item) => `
            <div class="installed-update-row">
              <div><strong>${esc(item.name)}</strong><span>${esc(item.currentVersion || '未知版本')} → ${esc(item.latestVersion || '新版本')}</span></div>
              <button class="btn small ghost" data-installed-update-url="${esc(item.pageUrl || '')}">查看</button>
            </div>
          `).join('')}</div>`
        : '';
    root.innerHTML = issueHTML + updateHTML;
  }

  function renderInstalled(result) {
    const list = $('#installed-list');
    const empty = $('#installed-empty');
    const count = $('#installed-count');
    const sub = $('#installed-sub');
    if (!list || !empty) return;

    const mods = result && result.ok && Array.isArray(result.mods) ? result.mods : [];
    installedMods = mods;
    installedHealth = result && result.ok && result.health ? result.health : null;
    installedDirs = result && Array.isArray(result.dirs) ? result.dirs : [];
    if (!result || !result.ok) {
      installedHealth = null;
      installedUpdates = [];
    }
    const enabled = mods.filter((mod) => mod.enabled).length;
    const disabled = mods.length - enabled;
    if (count) count.textContent = `${mods.length} 个`;
    if (sub) {
      if (!result || !result.ok) {
        sub.textContent = (result && result.error) || '无法读取模组列表';
      } else if (!mods.length) {
        sub.textContent = '勾选复选框启用或禁用，不会移动 .jar 文件';
      } else {
        const dirs = installedDirs.map((item) => item.label).filter(Boolean);
        const errors = installedHealth ? installedHealth.errorCount : 0;
        sub.textContent = `${enabled} 已启用 · ${disabled} 已禁用${errors ? ` · ${errors} 个依赖问题` : ''}${dirs.length ? ` · ${Array.from(new Set(dirs)).join(' / ')}` : ''}`;
      }
    }

    const visible = visibleMods();
    const filterCount = $('#installed-filter-count');
    if (filterCount) filterCount.textContent = mods.length ? `${visible.length}/${mods.length}` : '';

    if (!mods.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      const title = empty.querySelector('strong');
      const text = empty.querySelector('span');
      if (title) title.textContent = result && result.ok ? '还没有安装模组' : '无法读取模组列表';
      if (text) text.textContent = result && result.ok
        ? '在下方搜索并安装，或把整合包拖到下面的导入区。'
        : ((result && result.error) || '请刷新后重试。');
      renderHealth();
      return;
    }
    if (!visible.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      const title = empty.querySelector('strong');
      const text = empty.querySelector('span');
      if (title) title.textContent = '没有符合筛选的模组';
      if (text) text.textContent = '清空筛选条件，或换一个加载器/状态试试。';
      renderHealth();
      return;
    }
    empty.classList.add('hidden');
    list.innerHTML = visible.map((mod) => {
      const meta = [mod.version ? `v${mod.version}` : '', mod.modId].filter(Boolean);
      const location = mod.portable ? '便携目录' : '游戏目录';
      const side = mod.side === 'client' ? '仅客户端' : mod.side === 'server' ? '仅服务端' : '';
      const loader = mod.loader ? String(mod.loader).toUpperCase() : '';
      const fileLine = `${mod.filename} · ${MP.fmtBytes(mod.size || 0)} · ${location}${loader ? ` · ${loader}` : ''}${side ? ` · ${side}` : ''}`;
      const fileIssues = (installedHealth && installedHealth.issues ? installedHealth.issues : [])
        .filter((issue) => (issue.files || []).some((file) => String(file).toLowerCase() === String(mod.filename).toLowerCase()));
      return `<label class="installed-row ${mod.enabled ? '' : 'disabled'}">
        <input type="checkbox" data-mod-filename="${esc(mod.filename)}" ${mod.enabled ? 'checked' : ''} aria-label="${esc(mod.name)} 启用状态">
        <div class="installed-main">
          <div class="installed-name">
            <span>${esc(mod.name || mod.filename)}</span>
            ${mod.version ? `<span class="badge gray">v${esc(mod.version)}</span>` : ''}
            ${mod.modId && mod.modId !== mod.name ? `<span class="badge gray">${esc(mod.modId)}</span>` : ''}
            ${fileIssues.length ? `<span class="save-badge warn">${fileIssues.length} 个问题</span>` : ''}
          </div>
          <div class="installed-file" title="${esc(fileLine)}">${esc(fileLine)}</div>
        </div>
        <div class="installed-meta">
          <span class="installed-badge ${mod.enabled ? '' : 'off'}">${mod.enabled ? '已启用' : '已禁用'}</span>
        </div>
      </label>`;
    }).join('');
    renderHealth();
  }

  async function loadInstalled() {
    const target = targetVersion();
    const seq = ++installedSeq;
    if (!target) {
      renderInstalled({ ok: true, mods: [], count: 0, enabledCount: 0, disabledCount: 0, dirs: [] });
      return;
    }
    const sub = $('#installed-sub');
    if (sub) sub.textContent = '正在读取模组列表…';
    let result;
    try {
      result = await MP.api.invoke('mods:installed', { targetVersionId: target.id });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (seq !== installedSeq) return;
    renderInstalled(result || { ok: false, error: '读取失败' });
  }

  function rerenderInstalled() {
    renderInstalled({
      ok: true,
      mods: installedMods,
      health: installedHealth,
      dirs: installedDirs,
      count: installedMods.length,
    });
  }

  async function checkInstalledUpdates() {
    const target = targetVersion();
    if (!target) {
      MP.toast('请先选择目标版本', 'warn');
      return;
    }
    if (!onlineDownloadsEnabled()) {
      MP.toast('检查更新需要联网，请先在「设置 → 下载」开启在线下载', 'warn', 5500);
      return;
    }
    if (updateBusy) return;
    updateBusy = true;
    installedUpdates = [];
    renderHealth();
    const button = $('#btn-installed-updates');
    if (button) {
      button.disabled = true;
      button.textContent = '检查中…';
    }
    try {
      const result = await MP.api.invoke('mods:updates', { targetVersionId: target.id });
      if (!result || !result.ok) {
        MP.toast(`检查更新失败：${(result && result.error) || '未知错误'}`, 'err', 6000);
        return;
      }
      installedUpdates = Array.isArray(result.updates) ? result.updates : [];
      if (result.errors && result.errors.length) {
        MP.toast(`有 ${result.errors.length} 个模组检查失败，其余结果已显示`, 'warn', 5500);
      } else if (!installedUpdates.length) {
        MP.toast(`已检查 ${result.checked || 0} 个模组，没有发现可用更新`, 'ok', 4000);
      } else {
        MP.toast(`发现 ${installedUpdates.length} 个模组有更新`, 'ok', 4000);
      }
    } catch (err) {
      MP.toast(`检查更新失败：${err.message}`, 'err', 6000);
    } finally {
      updateBusy = false;
      if (button) {
        button.disabled = false;
        button.textContent = '检查更新';
      }
      renderHealth();
    }
  }

  async function batchSetEnabled(enabled) {
    const target = targetVersion();
    if (!target) {
      MP.toast('请先选择目标版本', 'warn');
      return;
    }
    if (batchBusy) return;
    const visible = visibleMods().filter((mod) => mod.enabled !== enabled);
    if (!visible.length) {
      MP.toast(`当前筛选结果中没有需要${enabled ? '启用' : '禁用'}的模组`, 'info', 3500);
      return;
    }
    const ok = await MP.confirm({
      title: enabled ? '批量启用模组' : '批量禁用模组',
      text: `将对当前筛选结果中的 ${visible.length} 个模组执行${enabled ? '启用' : '禁用'}。禁用只是把文件重命名为 .jar.disabled，不会删除文件。`,
      confirmLabel: enabled ? '全部启用' : '全部禁用',
      danger: !enabled,
    });
    if (!ok) return;
    batchBusy = true;
    const buttons = [$('#btn-installed-enable-all'), $('#btn-installed-disable-all')].filter(Boolean);
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const result = await MP.api.invoke('mods:set-enabled-many', {
        targetVersionId: target.id,
        filenames: visible.map((mod) => mod.filename),
        enabled,
      });
      if (!result || (!result.ok && !result.list)) {
        MP.toast(`批量操作失败：${(result && result.error) || '未知错误'}`, 'err', 6000);
        return;
      }
      if (result.failed && result.failed.length) {
        MP.toast(`已处理 ${result.changed.length} 个，${result.failed.length} 个失败`, 'warn', 5500);
      } else {
        MP.toast(`已${enabled ? '启用' : '禁用'} ${result.changed.length} 个模组`, 'ok', 3500);
      }
      if (result.list) renderInstalled(result.list);
      else loadInstalled();
    } catch (err) {
      MP.toast(`批量操作失败：${err.message}`, 'err', 6000);
    } finally {
      batchBusy = false;
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async function onInstalledChange(event) {
    const checkbox = event.target.closest('input[data-mod-filename]');
    if (!checkbox) return;
    const target = targetVersion();
    if (!target) {
      checkbox.checked = !checkbox.checked;
      MP.toast('请先选择目标版本', 'warn');
      return;
    }
    const filename = checkbox.dataset.modFilename || '';
    const next = Boolean(checkbox.checked);
    const row = checkbox.closest('.installed-row');
    checkbox.disabled = true;
    let result;
    try {
      result = await MP.api.invoke('mods:set-enabled', {
        targetVersionId: target.id,
        filename,
        enabled: next,
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result || !result.ok) {
      checkbox.disabled = false;
      checkbox.checked = !next;
      if (row) row.classList.toggle('disabled', next);
      MP.toast(`切换失败：${(result && result.error) || '未知错误'}`, 'err', 5500);
      return;
    }
    const current = targetVersion();
    if (!current || current.id !== target.id || !result.list || result.list.targetVersionId !== target.id) {
      MP.toast(`已${next ? '启用' : '禁用'} ${filename.replace(/\.jar(?:\.disabled)?$/i, '')}`, 'ok', 2200);
      loadInstalled();
      return;
    }
    renderInstalled(result.list);
    MP.toast(`已${next ? '启用' : '禁用'} ${filename.replace(/\.jar(?:\.disabled)?$/i, '')}`, 'ok', 2200);
  }

  function setPackBusy(value, mode) {
    packBusy = Boolean(value);
    packMode = value ? String(mode || '') : '';
    ['#btn-pack-import', '#btn-pack-export', '#btn-installed-refresh'].forEach((selector) => {
      const button = $(selector);
      if (button) button.disabled = packBusy;
    });
    const cancel = $('#btn-cancel-pack');
    if (cancel) cancel.disabled = packBusy && !['import', 'download'].includes(packMode);
  }

  function showPackBar(title) {
    const bar = $('#pack-progress-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    if ($('#pack-pb-title')) $('#pack-pb-title').textContent = title || '正在处理整合包';
    if ($('#pack-pb-phase')) $('#pack-pb-phase').textContent = '准备中…';
    if ($('#pack-pb-fill')) $('#pack-pb-fill').style.width = '0%';
    if ($('#pack-pb-percent')) $('#pack-pb-percent').textContent = '0%';
    if ($('#pack-pb-files')) $('#pack-pb-files').textContent = '';
  }

  function updatePackProgress(progress) {
    if (!progress || !packBusy) return;
    const bar = $('#pack-progress-bar');
    if (bar) bar.classList.remove('hidden');
    if (progress.message && $('#pack-pb-phase')) $('#pack-pb-phase').textContent = progress.message;
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    if ($('#pack-pb-fill')) $('#pack-pb-fill').style.width = `${percent}%`;
    if ($('#pack-pb-percent')) $('#pack-pb-percent').textContent = `${Math.round(percent)}%`;
    if ($('#pack-pb-files')) {
      const bits = [];
      if (progress.index && progress.total) bits.push(`文件 ${progress.index}/${progress.total}`);
      if (progress.bytes) bits.push(MP.fmtBytes(progress.bytes));
      $('#pack-pb-files').textContent = bits.join(' · ');
    }
  }

  function hidePackBar(delay) {
    const hide = () => {
      const bar = $('#pack-progress-bar');
      if (bar && !packBusy) bar.classList.add('hidden');
    };
    if (delay) setTimeout(hide, delay);
    else hide();
  }

  function packInfoBody(info) {
    const loader = info.loader
      ? `${info.loader.name || info.loader.key} ${info.loader.version || ''}`.trim()
      : '无 / 原版';
    const target = targetVersion();
    const action = !info.supported
      ? '当前版本不会写入任何文件，请换用 .mrpack 或包含 mods 的离线 ZIP。'
      : info.action === 'new'
        ? `将新建独立实例，并自动安装 Minecraft ${esc(info.minecraft || '未知')} · ${esc(loader)}。`
        : `将合并到当前实例 ${esc(target ? target.id : '（未选择）')}，不会删除现有 mods。`;
    const warnings = Array.isArray(info.warnings) ? info.warnings : [];
    const modePicker = info.action === 'new'
      ? `<div class="pack-mode">
          <label><input type="radio" name="pack-import-mode" value="new" checked> 新建独立实例（推荐）</label>
          <label><input type="radio" name="pack-import-mode" value="current"> 合并到当前实例</label>
        </div>`
      : '';
    return `<p class="muted-sm">${esc(info.name || '整合包')} · ${esc(info.fileName || '')}</p>
      <div class="pack-facts">
        <div><span>类型</span><strong>${esc(info.kind === 'mrpack' ? 'Modrinth .mrpack' : info.kind === 'minepilot' ? 'MinePilot ZIP' : info.kind === 'curseforge' ? 'CurseForge 清单' : 'ZIP 整合包')}</strong></div>
        <div><span>Minecraft</span><strong>${esc(info.minecraft || '未声明')}</strong></div>
        <div><span>加载器</span><strong>${esc(loader)}</strong></div>
        <div><span>内容</span><strong>${Number(info.files) || 0} 个清单文件 · ${Number(info.overrides) || 0} 个覆盖文件</strong></div>
      </div>
      <p>${action}</p>
      ${modePicker}
      ${warnings.length ? `<div class="pack-warnings">${warnings.map((warning) => `<p>${esc(warning)}</p>`).join('')}</div>` : ''}`;
  }

  async function inspectPack(filePath) {
    if (packBusy) {
      MP.toast('已有整合包任务正在进行', 'warn');
      return;
    }
    let path = filePath;
    if (!path) {
      let picked;
      try {
        picked = typeof MP.api.pickPack === 'function'
          ? await MP.api.pickPack()
          : await MP.api.invoke('modpack:pick');
      } catch (err) {
        picked = { ok: false, error: err.message };
      }
      if (!picked || picked.canceled) return;
      if (!picked.ok) {
        MP.toast(picked.error || '无法选择整合包', 'err', 5000);
        return;
      }
      path = picked.path;
    }
    let info;
    try {
      info = await MP.api.invoke('modpack:inspect', { path });
    } catch (err) {
      MP.toast(`读取整合包失败：${err.message}`, 'err', 6000);
      return;
    }
    if (!info || !info.ok) {
      MP.toast(`读取整合包失败：${(info && info.error) || '未知错误'}`, 'err', 6000);
      return;
    }
    if (!info.supported) {
      await MP.modal({
        title: '暂不支持这个整合包',
        body: packInfoBody(info),
        actions: [{ label: '知道了', kind: 'primary', value: true }],
      });
      return;
    }
    if (info.action !== 'new' && !targetVersion()) {
      MP.toast('请先选择一个要导入的实例', 'warn', 5000);
      return;
    }
    const confirmed = await MP.modal({
      title: '导入整合包',
      width: 540,
      body: packInfoBody(info),
      actions: [
        { label: '取消', value: false },
        {
          label: '开始导入',
          kind: 'primary',
          onClick: (box) => {
            const checked = box.querySelector('input[name="pack-import-mode"]:checked');
            if (checked) return checked.value;
            return info.action === 'new' ? 'new' : 'current';
          },
        },
      ],
    });
    if (!confirmed) return;
    await startImport(path, confirmed);
  }

  async function startImport(path, mode) {
    if (!onlineDownloadsEnabled()) {
      MP.toast('在线下载已关闭。请先在「设置 → 下载」中勾选“在线下载”。', 'warn', 5500);
      return;
    }
    const target = targetVersion();
    setPackBusy(true, 'import');
    showPackBar('正在导入整合包');
    let result;
    try {
      result = await MP.api.invoke('modpack:import', {
        path,
        targetVersionId: target ? target.id : '',
        mode: mode === 'new' ? 'new' : 'current',
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    setPackBusy(false, '');
    if (!result || !result.ok) {
      hidePackBar();
      if (result && result.code === 'CANCELED') MP.toast('已取消导入', 'warn');
      else MP.toast(`导入失败：${(result && result.error) || '未知错误'}`, 'err', 7000);
      return;
    }
    if ($('#pack-pb-title')) $('#pack-pb-title').textContent = `已导入 ${result.name || '整合包'}`;
    if ($('#pack-pb-phase')) $('#pack-pb-phase').textContent = result.mode === 'new' ? '已创建独立实例，可以启动游戏了' : '已合并到当前实例';
    if ($('#pack-pb-fill')) $('#pack-pb-fill').style.width = '100%';
    if ($('#pack-pb-percent')) $('#pack-pb-percent').textContent = '100%';

    await MP.refreshVersions();
    if (result.versionId) {
      MP.selectVersion(result.versionId);
      const select = $('#mod-target');
      if (select) select.value = result.versionId;
      populateTargets();
      lastTargetId = result.versionId;
    }
    await loadInstalled();
    if (Array.isArray(result.warnings) && result.warnings.length) {
      MP.toast(result.warnings[0], 'warn', 8000);
    }
    MP.toast(`已导入 ${result.downloaded || 0} 个下载文件 + ${result.overrides || 0} 个覆盖文件`, 'ok', 5000);
    setTimeout(() => hidePackBar(), 2800);
  }

  async function cancelPack() {
    const button = $('#btn-cancel-pack');
    if (button) {
      button.disabled = true;
      button.textContent = '正在取消…';
    }
    await MP.api.invoke('modpack:cancel');
    setTimeout(() => {
      if (button && document.body.contains(button)) {
        button.disabled = false;
        button.textContent = '取消';
      }
    }, 1600);
  }

  async function exportFlow() {
    if (packBusy) return;
    const target = targetVersion();
    if (!target) {
      MP.toast('请先选择要导出的实例', 'warn');
      return;
    }
    const format = await MP.modal({
      title: '导出当前实例',
      width: 520,
      body: `<p class="muted-sm">将 ${esc(target.id)} 的模组与配置打包。导出不会包含存档、日志、账户或启动器设置。</p>
        <div class="pack-format-options">
          <label><input type="radio" name="pack-format" value="mrpack" checked><span><strong>.mrpack</strong><small>推荐，可被 Modrinth 及其他启动器识别</small></span></label>
          <label><input type="radio" name="pack-format" value="zip"><span><strong>.zip</strong><small>普通压缩包，保留 mods/config 目录结构</small></span></label>
        </div>`,
      actions: [
        { label: '取消', value: null },
        {
          label: '选择保存位置',
          kind: 'primary',
          onClick: (box) => {
            const checked = box.querySelector('input[name="pack-format"]:checked');
            return checked ? checked.value : 'mrpack';
          },
        },
      ],
    });
    if (!format) return;
    setPackBusy(true, 'export');
    showPackBar('正在导出整合包');
    if ($('#btn-cancel-pack')) $('#btn-cancel-pack').disabled = true;
    let result;
    try {
      result = await MP.api.invoke('modpack:export', {
        targetVersionId: target.id,
        format,
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    setPackBusy(false, '');
    if (!result || !result.ok) {
      hidePackBar();
      if (result && result.canceled) return;
      MP.toast(`导出失败：${(result && result.error) || '未知错误'}`, 'err', 7000);
      return;
    }
    if ($('#pack-pb-title')) $('#pack-pb-title').textContent = '整合包已导出';
    if ($('#pack-pb-phase')) $('#pack-pb-phase').textContent = result.path;
    if ($('#pack-pb-fill')) $('#pack-pb-fill').style.width = '100%';
    if ($('#pack-pb-percent')) $('#pack-pb-percent').textContent = '100%';
    MP.toast(`已导出 ${result.files || 0} 个文件：${result.path}`, 'ok', 7000);
    if (typeof MP.api.downloadFile === 'function') {
      try { MP.api.downloadFile(result.path); } catch (err) { /* 浏览器下载失败时仍保留服务端文件 */ }
    }
    setTimeout(() => hidePackBar(), 3200);
  }

  function bindPackDrop() {
    const zone = $('#modpack-drop');
    if (!zone) return;
    zone.addEventListener('dragover', (event) => {
      if (packBusy) return;
      event.preventDefault();
      event.stopPropagation();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', (event) => {
      if (!zone.contains(event.relatedTarget)) zone.classList.remove('dragover');
    });
    zone.addEventListener('drop', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.remove('dragover');
      if (packBusy) return;
      const file = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
      if (!file) return;
      let path = '';
      try {
        path = MP.api.pathForFile ? MP.api.pathForFile(file) : '';
      } catch (err) {
        path = '';
      }
      if (!path) path = file.path || '';
      if (!path && typeof MP.api.uploadPack === 'function') {
        MP.toast('正在上传整合包到本地服务…', 'info', 2200);
        try {
          const uploaded = await MP.api.uploadPack(file);
          if (!uploaded || !uploaded.ok) throw new Error((uploaded && uploaded.error) || '上传失败');
          path = uploaded.path;
        } catch (err) {
          MP.toast(`读取拖入文件失败：${err.message}`, 'err', 6000);
          return;
        }
      }
      if (!path) {
        MP.toast('无法读取拖入文件的路径，请点击“导入整合包”选择文件', 'warn', 6000);
        return;
      }
      await inspectPack(path);
    });
  }

  function onHintClick(event) {
    const useTarget = event.target.closest('[data-mod-use-target]');
    if (useTarget) {
      const select = $('#mod-target');
      if (select && useTarget.dataset.modUseTarget) {
        select.value = useTarget.dataset.modUseTarget;
        onTargetChanged();
      }
      return;
    }
    const install = event.target.closest('[data-mod-install-loader]');
    if (install) {
      const version = (MP.state.versions || []).find((item) => item.id === install.dataset.modInstallLoader);
      if (version && MP.views.versions && typeof MP.views.versions.openLoader === 'function') {
        MP.views.versions.openLoader(version);
      } else {
        MP.toast('请到「版本」页选择该实例并安装加载器', 'warn', 5000);
      }
    }
  }

  function onListClick(event) {
    const open = event.target.closest('[data-mod-open]');
    if (open) {
      const url = open.dataset.modOpen;
      if (url) MP.openExternal(url);
      return;
    }
    const packButton = event.target.closest('button[data-modpack-install]');
    if (packButton) {
      chooseModpack(packButton.dataset.modpackInstall, packButton.dataset.modpackTitle || '整合包');
      return;
    }
    const button = event.target.closest('button[data-mod-install]');
    if (!button) return;
    chooseVersion(button.dataset.modInstall, button.dataset.modTitle || '模组');
  }

  async function setProjectType(next) {
    const type = next === 'modpack' ? 'modpack' : 'mod';
    if (type === projectType) return;
    projectType = type;
    category = '';
    hits = [];
    totalHits = 0;
    searchSeq += 1;
    loading = false;
    updateSourceUI();
    renderCategories();
    render();
    if (MP.state.view === 'mods' && targetVersion() && onlineDownloadsEnabled()) {
      await doSearch(true);
    }
  }

  async function setSource(next) {
    if (!SOURCE_LABELS[next] || source === next) return;
    source = next;
    category = '';
    hits = [];
    totalHits = 0;
    searchSeq += 1;
    loading = false;
    updateSourceUI();
    if ($('#btn-mod-more')) $('#btn-mod-more').disabled = false;
    renderCategories();
    render();
    if (source === 'curseforge' && !cfKey()) return;
    await ensureCategories();
    if (targetVersion()) await doSearch(true);
  }

  function onCategoryClick(event) {
    const button = event.target.closest('[data-mod-category]');
    if (!button) return;
    const next = String(button.dataset.modCategory || '');
    if (next === category) return;
    category = next;
    renderCategories();
    doSearch(true);
  }

  function onSettingsChanged() {
    const key = cfKey();
    const online = onlineDownloadsEnabled();
    const onlineChanged = online !== lastOnline;
    lastOnline = online;
    updateSourceUI();
    const resumeSearch = onlineChanged && online && targetVersion() && MP.state.view === 'mods';
    if (source !== 'curseforge') {
      lastCfKey = key;
      if (resumeSearch) doSearch(true);
      else render();
      return;
    }
    if (key === lastCfKey) {
      if (resumeSearch) doSearch(true);
      else render();
      return;
    }
    lastCfKey = key;
    categories.curseforge = [];
    hits = [];
    totalHits = 0;
    searchSeq += 1;
    loading = false;
    renderCategories();
    if (!key) {
      render();
      return;
    }
    ensureCategories().then(() => {
      if (source === 'curseforge' && MP.state.view === 'mods') doSearch(true);
    });
  }

  function onTargetChanged() {
    const target = targetVersion();
    const nextId = target ? target.id : '';
    if (nextId !== lastTargetId) {
      lastTargetId = nextId;
      hits = [];
      totalHits = 0;
      installedUpdates = [];
    }
    updateHint();
    loadInstalled();
    if (target) doSearch(true);
    else render();
  }

  function onVersionsChanged() {
    const before = targetVersion() ? targetVersion().id : '';
    populateTargets();
    const after = targetVersion() ? targetVersion().id : '';
    if (before !== after) {
      hits = [];
      totalHits = 0;
      installedUpdates = [];
      if (MP.state.view === 'mods' && after) doSearch(true);
    } else {
      render();
    }
    loadInstalled();
  }

  function init() {
    if (bound) return;
    bound = true;

    MP.on('#mod-target', 'change', onTargetChanged);
    MP.on('#mod-source-tabs', 'click', (event) => {
      const button = event.target.closest('[data-mod-source]');
      if (button) setSource(button.dataset.modSource);
    });
    MP.on('#mod-type-tabs', 'click', (event) => {
      const button = event.target.closest('[data-mod-type]');
      if (button) setProjectType(button.dataset.modType);
    });
    MP.on('#mod-cats', 'click', onCategoryClick);
    MP.on('#btn-mod-search', 'click', () => doSearch(true));
    MP.on('#mod-search', 'input', MP.debounce(() => doSearch(true), 500));
    MP.on('#mod-search', 'keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        doSearch(true);
      }
    });
    MP.on('#btn-mod-more', 'click', () => doSearch(false));
    MP.on('#mod-list', 'click', onListClick);
    MP.on('#mod-hint', 'click', onHintClick);
    MP.on('#btn-mod-copy-diag', 'click', copyDiagnostic);
    MP.on('#btn-mod-view-log', 'click', () => MP.showLogs());
    MP.on('#btn-cancel-mod', 'click', cancelInstall);
    MP.on('#btn-mod-open-mods', 'click', openModsFolder);
    MP.on('#btn-installed-open', 'click', openModsFolder);
    MP.on('#btn-installed-refresh', 'click', () => loadInstalled());
    MP.on('#btn-installed-check', 'click', () => loadInstalled());
    MP.on('#btn-installed-updates', 'click', checkInstalledUpdates);
    MP.on('#btn-installed-enable-all', 'click', () => batchSetEnabled(true));
    MP.on('#btn-installed-disable-all', 'click', () => batchSetEnabled(false));
    MP.on('#installed-list', 'change', onInstalledChange);
    ['#installed-filter', '#installed-loader-filter', '#installed-side-filter', '#installed-status-filter'].forEach((selector) => {
      MP.on(selector, 'input', rerenderInstalled);
      MP.on(selector, 'change', rerenderInstalled);
    });
    MP.on('#installed-health', 'click', (event) => {
      const button = event.target.closest('[data-installed-update-url]');
      if (!button) return;
      const url = button.dataset.installedUpdateUrl;
      if (url) MP.openExternal(url);
    });
    MP.on('#btn-pack-import', 'click', () => inspectPack(''));
    MP.on('#btn-pack-export', 'click', exportFlow);
    MP.on('#btn-cancel-pack', 'click', cancelPack);
    MP.api.on('mod:progress', updateInstallProgress);
    MP.api.on('modpack:progress', updatePackProgress);
    bindPackDrop();

    lastCfKey = cfKey();
    lastOnline = onlineDownloadsEnabled();
    updateSourceUI();
    renderCategories();
  }

  MP.views.mods = {
    init,
    async onShow() {
      updateSourceUI();
      renderCategories();
      if (source === 'curseforge' && cfKey() && !categories.curseforge.length) {
        await ensureCategories();
      }
      const before = lastTargetId;
      populateTargets();
      if (lastTargetId !== before) {
        hits = [];
        totalHits = 0;
      }
      const target = targetVersion();
      if (target && !hits.length) doSearch(true);
      else render();
      loadInstalled();
    },
    onVersionsChanged,
    onSettingsChanged,
    refreshInstalled: (result) => {
      if (result) renderInstalled(result);
      else loadInstalled();
    },
  };
})();