'use strict';

(function () {
  const { $, esc } = MP;

  const state = {
    library: null,
    loading: false,
    preferredModel: 'classic',
    busy: false,
  };

  function activeSkin() {
    const lib = state.library;
    return lib ? (lib.skins || []).find((item) => item.id === lib.activeSkin) || null : null;
  }

  function activeCape() {
    const lib = state.library;
    return lib ? (lib.capes || []).find((item) => item.id === lib.activeCape) || null : null;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('图片解码失败'));
      image.src = url;
    });
  }

  function setupCanvas(canvas, width, height) {
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.imageSmoothingEnabled = false;
    return ctx;
  }

  function drawPart(ctx, image, sx, sy, sw, sh, dx, dy, dw, dh, factor) {
    if (sx + sw > image.naturalWidth || sy + sh > image.naturalHeight) return;
    ctx.drawImage(image, sx * factor, sy * factor, sw * factor, sh * factor, dx, dy, dw, dh);
  }

  function drawSkin(ctx, image, model, width, height) {
    const factor = Math.max(1, image.naturalWidth / 64);
    const unit = Math.min(width / 30, height / 38);
    const center = width / 2;
    const top = Math.max(20, (height - unit * 34) / 2);
    const headX = center - unit * 4;
    const bodyX = center - unit * 4;
    const bodyY = top + unit * 8;
    const armY = bodyY;
    const legY = bodyY + unit * 12;
    const armWidth = model === 'slim' ? 3 : 4;

    ctx.save();
    // 地面阴影
    const shadow = ctx.createRadialGradient(center, legY + unit * 13.5, 2, center, legY + unit * 13.5, unit * 11);
    shadow.addColorStop(0, 'rgba(0,0,0,.38)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(center, legY + unit * 13.3, unit * 10, unit * 2.2, 0, 0, Math.PI * 2);
    ctx.fill();

    // 头
    drawPart(ctx, image, 8, 8, 8, 8, headX, top, unit * 8, unit * 8, factor);
    if (image.naturalHeight >= 64) drawPart(ctx, image, 40, 8, 8, 8, headX, top, unit * 8, unit * 8, factor);

    // 身体
    drawPart(ctx, image, 20, 20, 8, 12, bodyX, bodyY, unit * 8, unit * 12, factor);
    if (image.naturalHeight >= 64) drawPart(ctx, image, 20, 36, 8, 12, bodyX, bodyY, unit * 8, unit * 12, factor);

    // 手臂
    const leftArmX = center - unit * (4 + armWidth);
    const rightArmX = center + unit * 4;
    drawPart(ctx, image, 44, 20, armWidth, 12, leftArmX, armY, unit * armWidth, unit * 12, factor);
    drawPart(ctx, image, 36, 52, armWidth, 12, rightArmX, armY, unit * armWidth, unit * 12, factor);
    if (image.naturalHeight >= 64) {
      drawPart(ctx, image, 44, 36, armWidth, 12, leftArmX, armY, unit * armWidth, unit * 12, factor);
      drawPart(ctx, image, 52, 52, armWidth, 12, rightArmX, armY, unit * armWidth, unit * 12, factor);
    }

    // 腿
    drawPart(ctx, image, 4, 20, 4, 12, center - unit * 4, legY, unit * 4, unit * 12, factor);
    drawPart(ctx, image, 20, 52, 4, 12, center, legY, unit * 4, unit * 12, factor);
    if (image.naturalHeight >= 64) {
      drawPart(ctx, image, 0, 36, 4, 12, center - unit * 4, legY, unit * 4, unit * 12, factor);
      drawPart(ctx, image, 4, 52, 4, 12, center, legY, unit * 4, unit * 12, factor);
    }

    // 极淡的轮廓，增加层次但保留像素感
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.lineWidth = 0.7;
    ctx.strokeRect(headX + 0.5, top + 0.5, unit * 8 - 1, unit * 8 - 1);
    ctx.restore();
  }

  function drawCapeBehind(ctx, image, width, height) {
    const factor = Math.max(1, image.naturalWidth / 64);
    const unit = Math.min(width / 30, height / 38);
    const center = width / 2;
    const top = Math.max(20, (height - unit * 34) / 2);
    const capeW = unit * 10;
    const capeH = unit * 16;
    const x = center - capeW / 2;
    const y = top + unit * 10;
    ctx.save();
    ctx.globalAlpha = 0.95;
    if (image.naturalWidth >= 10 * factor && image.naturalHeight >= 16 * factor) {
      ctx.drawImage(image, 0, 0, 10 * factor, 16 * factor, x, y, capeW, capeH);
    }
    ctx.restore();
  }

  function clearCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  async function renderPreview() {
    const canvas = $('#skin-preview');
    if (!canvas) return;
    clearCanvas(canvas);
    const skin = activeSkin();
    const cape = activeCape();
    const empty = $('#skin-empty');
    if (!skin) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    canvas.width = 320;
    canvas.height = 390;
    const ctx = setupCanvas(canvas, 320, 390);
    try {
      if (cape && cape.dataUrl) {
        const capeImage = await loadImage(cape.dataUrl);
        drawCapeBehind(ctx, capeImage, 320, 390);
      }
      const image = await loadImage(skin.dataUrl);
      drawSkin(ctx, image, skin.model === 'slim' ? 'slim' : 'classic', 320, 390);
    } catch (err) {
      MP.toast(`皮肤预览失败：${err.message}`, 'err');
    }
  }

  async function renderCapePreview() {
    const canvas = $('#cape-preview');
    if (!canvas) return;
    clearCanvas(canvas);
    const cape = activeCape();
    const empty = $('#cape-empty');
    if (!cape) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    canvas.width = 240;
    canvas.height = 142;
    const ctx = setupCanvas(canvas, 240, 142);
    try {
      const image = await loadImage(cape.dataUrl);
      const factor = Math.max(1, image.naturalWidth / 64);
      const sourceW = 10 * factor;
      const sourceH = 16 * factor;
      const scale = Math.min(112 / sourceW, 112 / sourceH);
      const w = sourceW * scale;
      const h = sourceH * scale;
      const x = (240 - w) / 2;
      const y = (142 - h) / 2;
      ctx.shadowColor = 'rgba(0,0,0,.35)';
      ctx.shadowBlur = 12;
      ctx.drawImage(image, 0, 0, sourceW, sourceH, x, y, w, h);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,.18)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    } catch (err) {
      MP.toast(`披风预览失败：${err.message}`, 'err');
    }
  }

  function headDataUrl(image) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      const factor = Math.max(1, image.naturalWidth / 64);
      ctx.drawImage(image, 8 * factor, 8 * factor, 8 * factor, 8 * factor, 0, 0, 64, 64);
      if (image.naturalHeight >= 64) {
        ctx.drawImage(image, 40 * factor, 8 * factor, 8 * factor, 8 * factor, 0, 0, 64, 64);
      }
      return canvas.toDataURL('image/png');
    } catch (err) {
      return '';
    }
  }

  function updateLocalHead(skin) {
    if (!skin || !skin.dataUrl) {
      MP.state.localSkinHead = '';
      const name = MP.accountName ? MP.accountName() : 'Steve';
      for (const id of ['#side-avatar', '#home-avatar', '#skin-account-avatar']) {
        if (MP.setAvatar) MP.setAvatar($(id), name);
      }
      return;
    }
    const skinId = skin.id;
    loadImage(skin.dataUrl).then((image) => {
      const current = activeSkin();
      if (!current || current.id !== skinId) return;
      MP.state.localSkinHead = headDataUrl(image);
      const name = MP.accountName ? MP.accountName() : 'Steve';
      if (MP.setAvatar) {
        MP.setAvatar($('#skin-account-avatar'), name);
        MP.setAvatar($('#side-avatar'), name);
      }
    }).catch(() => { MP.state.localSkinHead = ''; });
  }

  async function drawHeadThumb(canvas, item) {
    if (!canvas || !item || !item.dataUrl) return;
    canvas.width = 38;
    canvas.height = 38;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 38, 38);
    try {
      const image = await loadImage(item.dataUrl);
      const factor = Math.max(1, image.naturalWidth / 64);
      ctx.drawImage(image, 8 * factor, 8 * factor, 8 * factor, 8 * factor, 0, 0, 38, 38);
      if (image.naturalHeight >= 64) {
        ctx.drawImage(image, 40 * factor, 8 * factor, 8 * factor, 8 * factor, 0, 0, 38, 38);
      }
    } catch (err) { /* ignore thumb */ }
  }

  async function drawCapeThumb(canvas, item) {
    if (!canvas || !item || !item.dataUrl) return;
    canvas.width = 38;
    canvas.height = 30;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 38, 30);
    try {
      const image = await loadImage(item.dataUrl);
      const factor = Math.max(1, image.naturalWidth / 64);
      ctx.drawImage(image, 0, 0, 10 * factor, 16 * factor, 5, 1, 28, 28);
    } catch (err) { /* ignore thumb */ }
  }

  function itemRow(item, kind) {
    const row = document.createElement('div');
    row.className = `skin-card${(state.library && ((kind === 'skin' ? state.library.activeSkin : state.library.activeCape) === item.id)) ? ' active' : ''}`;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.title = `${item.name} · ${item.width}×${item.height}`;
    row.innerHTML = `<canvas class="skin-thumb" width="38" height="${kind === 'cape' ? 30 : 38}"></canvas>
      <div class="skin-card-main"><strong>${esc(item.name)}</strong><span>${item.width}×${item.height}${kind === 'skin' ? ` · ${item.model === 'slim' ? '纤细' : '经典'}` : ''}</span></div>
      <button class="skin-card-remove" type="button" title="删除">×</button>`;
    row.addEventListener('click', () => selectItem(kind, item));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectItem(kind, item);
      }
    });
    row.querySelector('.skin-card-remove').addEventListener('click', async (event) => {
      event.stopPropagation();
      await removeItem(kind, item);
    });
    const canvas = row.querySelector('canvas');
    if (kind === 'cape') drawCapeThumb(canvas, item);
    else drawHeadThumb(canvas, item);
    return row;
  }

  function renderLibrary() {
    const lib = state.library;
    const skins = lib ? lib.skins || [] : [];
    const capes = lib ? lib.capes || [] : [];
    const skin = activeSkin();
    const cape = activeCape();
    const model = skin ? skin.model : state.preferredModel;

    if ($('#skin-active-name')) $('#skin-active-name').textContent = skin ? skin.name : '还没有本地皮肤';
    if ($('#skin-active-file')) $('#skin-active-file').textContent = skin ? skin.file : '未选择皮肤';
    if ($('#skin-active-detail')) {
      $('#skin-active-detail').textContent = skin
        ? `${skin.width}×${skin.height} · ${skin.model === 'slim' ? '纤细模型' : '经典模型'}`
        : '导入后会在启动器内即时预览';
    }
    if ($('#skin-model-text')) $('#skin-model-text').textContent = model === 'slim' ? '纤细' : '经典';
    document.querySelectorAll('[data-skin-model]').forEach((button) => {
      button.classList.toggle('active', button.dataset.skinModel === model);
    });

    const list = $('#skin-list');
    if (list) {
      list.innerHTML = '';
      for (const item of skins) list.appendChild(itemRow(item, 'skin'));
    }
    if ($('#skin-count')) $('#skin-count').textContent = `${skins.length} 个`;
    if ($('#skin-list-empty')) $('#skin-list-empty').classList.toggle('hidden', skins.length > 0);

    const capeList = $('#cape-list');
    if (capeList) {
      capeList.innerHTML = '';
      for (const item of capes) capeList.appendChild(itemRow(item, 'cape'));
    }
    if ($('#cape-count')) $('#cape-count').textContent = `${capes.length} 个`;
    if ($('#cape-list-empty')) $('#cape-list-empty').classList.toggle('hidden', capes.length > 0);

    if ($('#cape-active-name')) $('#cape-active-name').textContent = cape ? cape.name : '未选择披风';
    if ($('#btn-cape-clear')) $('#btn-cape-clear').classList.toggle('hidden', !cape);
    if ($('#btn-skin-clear')) $('#btn-skin-clear').classList.toggle('hidden', !skin);

    const account = lib && lib.account;
    const name = MP.accountName ? MP.accountName() : 'Steve';
    if ($('#skin-account-name')) $('#skin-account-name').textContent = name;
    if ($('#skin-account-sub')) $('#skin-account-sub').textContent = MP.accountModeText ? MP.accountModeText() : '离线账户 · 仅本地';
    if ($('#skin-account-text')) {
      $('#skin-account-text').textContent = account && account.skin ? 'Microsoft 账户 · 正版皮肤可用' : '离线账户 · 本地形象';
    }
    if ($('#skin-account-dot')) $('#skin-account-dot').className = `status-dot${account && account.skin ? '' : ' warn'}`;
    updateLocalHead(skin);
    if ($('#skin-account-avatar') && MP.setAvatar) MP.setAvatar($('#skin-account-avatar'), name);

    renderPreview();
    renderCapePreview();
  }

  async function load(silent) {
    if (state.loading) return;
    state.loading = true;
    try {
      const result = await MP.api.invoke('skin:list');
      if (!result || result.ok === false) throw new Error((result && result.error) || '读取皮肤库失败');
      state.library = result;
      if (result.activeSkinModel) state.preferredModel = result.activeSkinModel;
      renderLibrary();
    } catch (err) {
      if (!silent) MP.toast(`读取皮肤库失败：${err.message}`, 'err', 6000);
    } finally {
      state.loading = false;
    }
  }

  async function selectItem(kind, item) {
    if (state.busy) return;
    state.busy = true;
    try {
      const result = await MP.api.invoke('skin:set-active', { kind, id: item.id, model: item.model });
      if (!result || result.ok === false) throw new Error((result && result.error) || '切换失败');
      state.library = result;
      renderLibrary();
      MP.toast(kind === 'skin' ? `已使用皮肤「${item.name}」` : `已使用披风「${item.name}」`, 'ok');
    } catch (err) {
      MP.toast(`切换失败：${err.message}`, 'err');
    } finally {
      state.busy = false;
    }
  }

  async function removeItem(kind, item) {
    if (state.busy) return;
    const ok = await MP.confirm({
      title: kind === 'skin' ? '删除皮肤' : '删除披风',
      text: `确定从本地图库删除「${item.name}」吗？这个操作不会影响游戏文件。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    state.busy = true;
    try {
      const result = await MP.api.invoke('skin:remove', { kind, id: item.id });
      if (!result || result.ok === false) throw new Error((result && result.error) || '删除失败');
      state.library = result;
      renderLibrary();
      MP.toast('已从本地图库删除', 'ok');
    } catch (err) {
      MP.toast(`删除失败：${err.message}`, 'err');
    } finally {
      state.busy = false;
    }
  }

  async function clearActive(kind) {
    state.busy = true;
    try {
      const result = await MP.api.invoke('skin:clear-active', { kind });
      if (!result || result.ok === false) throw new Error((result && result.error) || '操作失败');
      state.library = result;
      renderLibrary();
      MP.toast(kind === 'skin' ? '已停用本地皮肤' : '已移除当前披风', 'ok');
    } catch (err) {
      MP.toast(`操作失败：${err.message}`, 'err');
    } finally {
      state.busy = false;
    }
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        resolve('');
        return;
      }
      if (file.type && file.type !== 'image/png') {
        reject(new Error('请选择 PNG 格式的图片'));
        return;
      }
      if (file.size > 6 * 1024 * 1024) {
        reject(new Error('图片不能超过 6 MB'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }

  async function importFile(file, kind) {
    if (!file || state.busy) return;
    state.busy = true;
    try {
      const dataUrl = await readFile(file);
      const result = await MP.api.invoke('skin:import', {
        kind,
        name: file.name,
        dataUrl,
        model: state.preferredModel,
      });
      if (!result || result.ok === false) throw new Error((result && result.error) || '导入失败');
      state.library = result;
      renderLibrary();
      MP.toast(kind === 'skin' ? '皮肤已导入并设为当前形象' : '披风已导入并设为当前披风', 'ok');
    } catch (err) {
      MP.toast(`导入失败：${err.message}`, 'err', 6000);
    } finally {
      state.busy = false;
      const input = kind === 'skin' ? $('#skin-file-input') : $('#cape-file-input');
      if (input) input.value = '';
    }
  }

  async function setModel(model) {
    const skin = activeSkin();
    state.preferredModel = model;
    if (!skin) {
      renderLibrary();
      return;
    }
    try {
      const result = await MP.api.invoke('skin:set-active', { kind: 'skin', id: skin.id, model });
      if (!result || result.ok === false) throw new Error((result && result.error) || '切换模型失败');
      state.library = result;
      renderLibrary();
      MP.toast(`已切换为${model === 'slim' ? '纤细' : '经典'}模型`, 'ok');
    } catch (err) {
      MP.toast(`切换模型失败：${err.message}`, 'err');
    }
  }

  function bindDropZone(selector, kind) {
    const zone = $(selector);
    if (!zone || zone.dataset.dropBound) return;
    zone.dataset.dropBound = '1';
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('drag-over');
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) importFile(file, kind);
    });
  }

  function bindFileInput(id, kind) {
    const input = $(id);
    if (!input || input.dataset.bound) return;
    input.dataset.bound = '1';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (file) importFile(file, kind);
    });
  }

  function init() {
    for (const id of ['#btn-skin-import', '#btn-skin-import-2', '#btn-skin-empty-import']) {
      MP.on(id, 'click', () => $('#skin-file-input').click());
    }
    MP.on('#btn-cape-import', 'click', () => $('#cape-file-input').click());
    MP.on('#btn-skin-clear', 'click', () => clearActive('skin'));
    MP.on('#btn-cape-clear', 'click', () => clearActive('cape'));
    document.querySelectorAll('[data-skin-model]').forEach((button) => {
      button.addEventListener('click', () => setModel(button.dataset.skinModel));
    });
    bindFileInput('#skin-file-input', 'skin');
    bindFileInput('#cape-file-input', 'cape');
    bindDropZone('#skin-stage', 'skin');
    bindDropZone('#cape-stage', 'cape');
    load(true);
  }

  MP.views.skin = {
    init,
    onShow: () => load(),
  };
})();


