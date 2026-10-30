'use strict';

(function () {
  const { $ } = MP;

  const state = {
    active: false,
    timer: null,
    polling: false,
    last: null,
    cpuHistory: [],
    memHistory: [],
    autoScroll: true,
  };

  function formatUptime(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  }

  function formatTime(timestamp) {
    if (!timestamp) return '—';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function setPill(visible, text) {
    const pill = $('#runtime-monitor-pill');
    if (pill) pill.classList.toggle('hidden', !visible);
    const label = $('#runtime-pill-text');
    if (label && text) label.textContent = text;
    const badge = $('#nav-monitor-badge');
    if (badge) badge.classList.toggle('hidden', !visible);
  }

  function updateStatus(running) {
    const dot = $('#monitor-status-chip .status-dot');
    const text = $('#monitor-status-text');
    if (dot) dot.className = `status-dot${running ? '' : ' off'}`;
    if (text) text.textContent = running ? '运行中' : '未运行';
    const kill = $('#btn-monitor-kill');
    if (kill) kill.disabled = !running;
  }

  function drawChart(canvas, values, color) {
    if (!canvas) return;
    const width = 360;
    const height = 90;
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(128,148,180,.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const y = (height / 4) * i + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    if (!values.length) return;

    const points = values.slice(-48);
    const step = points.length > 1 ? width / (points.length - 1) : width;
    ctx.beginPath();
    points.forEach((value, index) => {
      const x = index * step;
      const y = height - Math.max(0, Math.min(100, Number(value) || 0)) / 100 * (height - 8) - 4;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, color.replace('rgb', 'rgba').replace(')', ',.28)'));
    gradient.addColorStop(1, color.replace('rgb', 'rgba').replace(')', ',0)'));
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    points.forEach((value, index) => {
      const x = index * step;
      const y = height - Math.max(0, Math.min(100, Number(value) || 0)) / 100 * (height - 8) - 4;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function renderLog(text, logPath) {
    const pre = $('#monitor-log');
    if (!pre) return;
    const next = String(text || '启动游戏后，这里会显示最近的日志输出。');
    const nearBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
    if (pre.textContent !== next) {
      pre.textContent = next;
      if (state.autoScroll || nearBottom) pre.scrollTop = pre.scrollHeight;
    }
    const meta = $('#monitor-log-meta');
    if (meta) meta.textContent = logPath ? '显示最近 120 行，完整内容在日志文件' : '等待游戏输出';
    const logState = $('#monitor-log-state');
    if (logState) logState.textContent = logPath ? '已连接' : '等待中';
  }

  function render(result, incremental) {
    state.last = result;
    const running = Boolean(result && result.running);
    updateStatus(running);
    const live = $('#monitor-live');
    const empty = $('#monitor-empty');
    if (live) live.classList.toggle('hidden', !running);
    if (empty) empty.classList.toggle('hidden', running);
    if (!running) {
      setPill(false);
      const title = $('#monitor-empty-title');
      const copy = $('#monitor-empty-text');
      if (result && result.exited) {
        const code = result.exit && result.exit.code != null ? result.exit.code : '-';
        const duration = result.exit && result.exit.duration ? `${Math.max(1, Math.round(result.exit.duration / 1000))} 秒` : '未知';
        if (title) title.textContent = '游戏已退出';
        if (copy) copy.textContent = `进程已结束，退出代码 ${code}，本次运行约 ${duration}。上方的启动日志仍可在日志抽屉中查看。`;
        const text = $('#monitor-log-meta');
        if (text) text.textContent = `游戏已退出 · 代码 ${code}`;
      } else {
        if (title) title.textContent = '游戏还没有启动';
        if (copy) copy.textContent = '从「启动」页进入游戏后，这里会显示实时资源占用与日志。启动器不会额外占用游戏进程资源。';
      }
      return;
    }

    setPill(true, `CPU ${Number(result.cpuPercent || 0).toFixed(0)}% · ${Math.round(result.memoryMb || 0)} MB`);
    if ($('#monitor-version')) $('#monitor-version').textContent = result.versionId || 'Minecraft';
    if ($('#monitor-player')) $('#monitor-player').textContent = `玩家 ${result.player || '—'}`;
    if ($('#monitor-pid-label')) $('#monitor-pid-label').textContent = `PID ${result.pid || '—'}`;
    if ($('#monitor-started')) $('#monitor-started').textContent = `启动于 ${formatTime(result.startedAt)}`;
    if ($('#monitor-uptime')) $('#monitor-uptime').textContent = formatUptime(result.uptimeMs);

    const cpu = Number(result.cpuPercent || 0);
    if ($('#monitor-cpu')) $('#monitor-cpu').textContent = `${cpu.toFixed(1)}%`;
    if ($('#monitor-cpu-total')) $('#monitor-cpu-total').textContent = `累计 ${((result.cpuTotalMs || 0) / 1000).toFixed(0)} 秒`;
    if (!incremental || !state.cpuHistory.length) state.cpuHistory = state.cpuHistory.slice(-47);
    state.cpuHistory.push(cpu);
    if (state.cpuHistory.length > 48) state.cpuHistory.shift();
    drawChart($('#monitor-cpu-chart'), state.cpuHistory, 'rgb(71,215,172)');

    const memory = Number(result.memoryMb || 0);
    const allocated = Number(result.memoryAllocatedMb || 0);
    if ($('#monitor-memory')) $('#monitor-memory').textContent = `${memory.toFixed(0)} MB`;
    if ($('#monitor-memory-fill')) $('#monitor-memory-fill').style.width = `${Math.max(0, Math.min(100, allocated ? (memory / allocated) * 100 : 0))}%`;
    if ($('#monitor-memory-detail')) $('#monitor-memory-detail').textContent = `分配 ${allocated || 0} MB`;
    if ($('#monitor-memory-system')) $('#monitor-memory-system').textContent = `系统 ${result.memorySystemMb || 0} MB`;
    if ($('#monitor-threads')) $('#monitor-threads').textContent = result.threads ? String(result.threads) : '—';
    if ($('#monitor-started')) $('#monitor-started').title = result.logPath || '';
    renderLog(result.logTail, result.logPath);
  }

  async function poll() {
    if (!state.active) return;
    if (state.polling) return;
    state.polling = true;
    try {
      const result = await MP.api.invoke('monitor:state');
      render(result, true);
      if (!result || !result.running) {
        state.timer = setTimeout(poll, 3000);
        if (result && result.exited) state.active = false;
      } else {
        state.timer = setTimeout(poll, 1200);
      }
    } catch (err) {
      const text = $('#monitor-status-text');
      if (text) text.textContent = '状态读取失败';
      state.timer = setTimeout(poll, 3000);
    } finally {
      state.polling = false;
    }
  }

  function stop() {
    state.active = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  function start() {
    if (state.active) return;
    state.active = true;
    if (state.timer) clearTimeout(state.timer);
    poll();
  }

  async function kill() {
    const ok = await MP.confirm({
      title: '结束游戏进程',
      text: '将强制结束当前 Minecraft 及其子进程。未保存的游戏进度可能丢失，确定继续吗？',
      confirmLabel: '结束进程',
      danger: true,
    });
    if (!ok) return;
    const button = $('#btn-monitor-kill');
    if (button) {
      button.disabled = true;
      button.textContent = '正在结束…';
    }
    try {
      const result = await MP.api.invoke('monitor:kill');
      if (!result || result.ok === false) throw new Error((result && result.error) || '结束进程失败');
      MP.toast('已请求结束游戏进程', 'ok');
      setTimeout(() => {
        if (state.active) poll();
      }, 700);
    } catch (err) {
      MP.toast(`结束进程失败：${err.message}`, 'err');
      if (button) button.disabled = false;
    } finally {
      if (button) button.textContent = '结束进程';
    }
  }

  async function copyLog() {
    const text = $('#monitor-log') ? $('#monitor-log').textContent : '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      MP.toast('日志已复制', 'ok');
    } catch (err) {
      MP.toast('复制失败，请手动选择日志内容', 'warn');
    }
  }

  function init() {
    MP.on('#btn-monitor-kill', 'click', kill);
    MP.on('#btn-monitor-refresh', 'click', () => {
      if (!state.active) start();
      else poll();
    });
    MP.on('#btn-monitor-open-log', 'click', () => {
      if (state.last && state.last.logPath) MP.openPath(state.last.logPath, '日志文件');
      else MP.openLogs();
    });
    MP.on('#btn-monitor-log-copy', 'click', copyLog);
    const pre = $('#monitor-log');
    if (pre) {
      pre.addEventListener('scroll', () => {
        state.autoScroll = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
      });
    }
  }

  MP.monitor = {
    onLaunch(result) {
      if (!result || !result.ok) return;
      state.cpuHistory = [];
      state.memHistory = [];
      state.last = {
        running: true,
        versionId: result.versionId || (MP.state.selectedVersion || ''),
        player: MP.accountName ? MP.accountName() : '',
        pid: result.pid,
        startedAt: Date.now(),
        uptimeMs: 0,
        cpuPercent: 0,
        memoryMb: 0,
        memoryAllocatedMb: (MP.state.settings && MP.state.settings.memoryMb) || 0,
        memorySystemMb: 0,
        logPath: result.logPath || '',
      };
      setPill(true, '正在读取运行状态…');
      if (MP.state.view === 'monitor') start();
    },
    onExit() {
      setPill(false);
      updateStatus(false);
      if (state.active) {
        poll();
      }
    },
    refreshPill(result) {
      if (result && result.running) setPill(true, `CPU ${Number(result.cpuPercent || 0).toFixed(0)}% · ${Math.round(result.memoryMb || 0)} MB`);
    },
    start,
    stop,
  };

  MP.views.monitor = {
    init,
    onShow: start,
    onLeave: stop,
  };
})();
