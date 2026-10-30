'use strict';

(function () {
  const { $ } = MP;

  const state = {
    record: null,
    history: [],
    loading: false,
    seenKey: 'minepilot.diagnostics.seen',
  };

  function esc(value) {
    return MP.esc ? MP.esc(String(value == null ? '' : value)) : String(value == null ? '' : value);
  }

  function formatDate(timestamp) {
    if (!timestamp) return '—';
    try {
      return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
    } catch (err) {
      return '—';
    }
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (total < 60) return `${total} 秒`;
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes < 60) return `${minutes} 分 ${seconds} 秒`;
    return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  }

  function severityLabel(severity) {
    if (severity === 'critical') return '严重';
    if (severity === 'warning') return '需要留意';
    if (severity === 'error') return '需要处理';
    return '信息';
  }

  function confidenceLabel(confidence) {
    if (confidence === 'high') return '可能性高';
    if (confidence === 'medium') return '可能';
    return '参考';
  }

  function setBadge(visible) {
    const badge = $('#nav-diagnostics-badge');
    if (badge) badge.classList.toggle('hidden', !visible);
  }

  function setStatus(hasRecord) {
    const dot = $('#diag-status-chip .status-dot');
    const text = $('#diag-status-text');
    if (dot) dot.className = `status-dot${hasRecord ? '' : ' off'}`;
    if (text) text.textContent = hasRecord ? '已记录最近一次异常' : '还没有诊断记录';
    const exportButton = $('#btn-diag-export');
    if (exportButton) exportButton.disabled = !hasRecord;
  }

  function renderCauses(record) {
    const root = $('#diag-causes');
    if (!root) return;
    const causes = Array.isArray(record.causes) ? record.causes : [];
    if (!causes.length) {
      root.innerHTML = '<p class="diag-history-empty">这次没有匹配到明确原因，日志摘要和系统信息仍会写入报告。</p>';
      return;
    }
    root.innerHTML = causes.map((cause, index) => `
      <div class="diag-cause">
        <span class="diag-cause-index">${String(index + 1).padStart(2, '0')}</span>
        <div>
          <h4>${esc(cause.title)}<span class="diag-confidence">${esc(confidenceLabel(cause.confidence))}</span></h4>
          <p>${esc(cause.detail)}</p>
          ${cause.evidence ? `<pre class="diag-evidence">${esc(cause.evidence)}</pre>` : ''}
        </div>
      </div>
    `).join('');
  }

  function renderSuggestions(record) {
    const root = $('#diag-suggestions');
    if (!root) return;
    const list = Array.isArray(record.suggestions) ? record.suggestions : [];
    root.innerHTML = list.length
      ? list.map((item) => `<li>${esc(item)}</li>`).join('')
      : '<li class="diag-history-empty">可以先导出报告，再把报告和最近安装的模组一起发给熟悉 Minecraft 的朋友。</li>';
  }

  function renderHistory() {
    const root = $('#diag-history');
    if (!root) return;
    if (!state.history.length) {
      root.innerHTML = '<p class="diag-history-empty">还没有历史记录。</p>';
      return;
    }
    root.innerHTML = state.history.map((item) => `
      <button class="diag-history-row" data-diag-id="${esc(item.id)}">
        <span>
          <span class="diag-history-title">${esc(item.title || '游戏异常退出')}</span>
          <span class="diag-history-meta">${esc(formatDate(item.createdAt))} · ${esc(item.versionId || '未知版本')}</span>
        </span>
        <span class="diag-history-code">${item.code == null ? '—' : esc(item.code)}</span>
      </button>
    `).join('');
  }

  function render(record) {
    state.record = record || null;
    const hasRecord = Boolean(record);
    setStatus(hasRecord);
    const empty = $('#diag-empty');
    const content = $('#diag-content');
    if (empty) empty.classList.toggle('hidden', hasRecord);
    if (content) content.classList.toggle('hidden', !hasRecord);
    renderHistory();
    if (!record) {
      setBadge(false);
      return;
    }

    const severity = $('#diag-severity');
    if (severity) {
      severity.textContent = severityLabel(record.severity);
      severity.className = `diag-severity ${record.severity || ''}`.trim();
    }
    const time = $('#diag-time');
    if (time) time.textContent = formatDate(record.createdAt);
    const title = $('#diag-title');
    if (title) title.textContent = record.title || '游戏异常退出';
    const summary = $('#diag-summary');
    if (summary) summary.textContent = record.summary || '—';

    const exit = record.exit || {};
    const code = $('#diag-exit-code');
    if (code) code.textContent = exit.code == null ? '—' : String(exit.code);
    const signal = $('#diag-exit-signal');
    if (signal) signal.textContent = exit.signal || '无';
    const duration = $('#diag-duration');
    if (duration) duration.textContent = formatDuration(exit.duration);
    const version = $('#diag-version');
    if (version) version.textContent = record.versionId || '未知';

    renderCauses(record);
    renderSuggestions(record);

    const log = $('#diag-log');
    if (log) {
      const text = String(record.logExcerpt || record.logTail || '').trim();
      log.textContent = text ? text.split(/\r?\n/).slice(-90).join('\n') : '没有可用的日志内容。';
    }
    const system = $('#diag-system');
    if (system) {
      try {
        system.textContent = JSON.stringify(record.system || {}, null, 2);
      } catch (err) {
        system.textContent = '系统信息读取失败。';
      }
    }

    const seen = localStorage.getItem(state.seenKey);
    if (record.crashed && seen !== record.id) setBadge(true);
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    try {
      const result = await MP.api.invoke('diagnostics:latest');
      if (!result || !result.ok) {
        MP.toast(`读取诊断记录失败：${(result && result.error) || '未知错误'}`, 'err', 5000);
        return;
      }
      state.history = Array.isArray(result.history) ? result.history : [];
      render(result.record);
    } catch (err) {
      MP.toast(`读取诊断记录失败：${err.message}`, 'err', 5000);
    } finally {
      state.loading = false;
    }
  }

  async function select(id) {
    if (!id || (state.record && state.record.id === id)) return;
    try {
      const result = await MP.api.invoke('diagnostics:get', id);
      if (!result || !result.ok || !result.record) {
        MP.toast('这条诊断记录已经不存在', 'err');
        await load();
        return;
      }
      render(result.record);
    } catch (err) {
      MP.toast(`读取诊断记录失败：${err.message}`, 'err');
    }
  }

  async function exportReport() {
    if (!state.record) return;
    const buttons = [$('#btn-diag-export'), $('#btn-diag-export-main')].filter(Boolean);
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const result = await MP.api.invoke('diagnostics:export', state.record.id);
      if (!result || !result.ok) {
        if (result && result.canceled) return;
        throw new Error((result && result.error) || '导出失败');
      }
      if (result.downloadBase64) {
        const bytes = Uint8Array.from(atob(result.downloadBase64), (char) => char.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = result.fileName || 'MinePilot-Diagnostic.zip';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        MP.toast('诊断报告已开始下载', 'ok');
      } else if (result.path) {
        MP.toast(`诊断报告已保存：${result.fileName || result.path}`, 'ok', 6500);
        MP.openPath(result.path.replace(/[\\/][^\\/]+$/, ''), '下载目录');
      }
    } catch (err) {
      MP.toast(`导出诊断报告失败：${err.message}`, 'err', 6000);
    } finally {
      buttons.forEach((button) => { button.disabled = !state.record; });
    }
  }

  async function copySummary() {
    if (!state.record) return;
    const record = state.record;
    const lines = [
      `MinePilot 崩溃诊断：${record.title || '游戏异常退出'}`,
      record.summary || '',
      `退出代码：${record.exit && record.exit.code != null ? record.exit.code : '未知'}`,
      `版本：${record.versionId || '未知'}`,
      '',
      '可能原因：',
      ...(record.causes || []).map((cause, index) => `${index + 1}. ${cause.title}：${cause.detail}`),
      '',
      '建议：',
      ...(record.suggestions || []).map((item) => `- ${item}`),
    ];
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      MP.toast('诊断结论已复制', 'ok');
    } catch (err) {
      MP.toast('当前环境不允许写入剪贴板，请从诊断页手动选择文字。', 'err', 5000);
    }
  }

  function openLogFolder() {
    const record = state.record;
    if (!record) return;
    const file = (record.files && (record.files.launchLog || (record.files.logs && record.files.logs[0]))) || '';
    if (file) {
      MP.openPath(file.replace(/[\\/][^\\/]+$/, ''), '日志目录');
      return;
    }
    if (record.gameDir) MP.openPath(record.gameDir, '游戏目录');
  }

  function onCrash(record) {
    if (!record) return;
    state.record = record;
    if (Array.isArray(state.history)) {
      const summary = {
        id: record.id,
        createdAt: record.createdAt,
        title: record.title,
        severity: record.severity,
        versionId: record.versionId,
        code: record.exit ? record.exit.code : null,
        subject: record.summary,
      };
      state.history = [summary].concat(state.history.filter((item) => item.id !== record.id)).slice(0, 12);
    }
    render(record);
    setBadge(true);
    MP.modal({
      title: '游戏崩溃了，先看看原因',
      width: 520,
      body: `
        <p class="diag-modal-title">${esc(record.title || '游戏异常退出')}</p>
        <p class="muted-sm">${esc(record.summary || '启动器已经收集日志并完成初步分析。')}</p>
        <p class="muted-sm">${esc(record.suggestions && record.suggestions[0] || '可以打开诊断页查看完整原因，或直接导出报告。')}</p>
      `,
      actions: [
        { label: '稍后处理', value: false },
        {
          label: '查看诊断',
          kind: 'primary',
          onClick: () => {
            MP.go('diagnostics');
            return null;
          },
        },
      ],
    });
  }

  function markSeen() {
    if (state.record && state.record.id) {
      localStorage.setItem(state.seenKey, state.record.id);
    }
    setBadge(false);
  }

  function init() {
    MP.on('#btn-diag-export', 'click', exportReport);
    MP.on('#btn-diag-export-main', 'click', exportReport);
    MP.on('#btn-diag-copy', 'click', copySummary);
    MP.on('#btn-diag-open-log', 'click', openLogFolder);
    MP.on('#btn-diag-open-folder', 'click', async () => {
      const result = await MP.api.invoke('diagnostics:open-folder');
      if (result && result.ok === false) MP.toast(result.error || '无法打开诊断目录', 'err');
    });
    MP.on('#diag-history', 'click', (event) => {
      const row = event.target.closest('[data-diag-id]');
      if (row) select(row.dataset.diagId);
    });
    MP.api.on('crash:detected', (record) => onCrash(record));
  }

  MP.views.diagnostics = {
    init,
    onShow: async () => {
      await load();
      markSeen();
    },
  };
  MP.diagnostics = { onCrash, load, exportReport };
})();