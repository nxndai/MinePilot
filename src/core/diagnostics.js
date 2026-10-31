'use strict';

/**
 * 崩溃诊断与诊断报告。
 *
 * 这里不尝试“猜出唯一原因”，而是把退出代码、启动日志、Minecraft 日志和
 * crash-reports 放在一起，给出按置信度排序的可能原因与可执行建议。
 * 导出报告时会隐藏访问令牌、会话令牌等敏感信息。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const settings = require('./settings');
const logger = require('./logger');
const platform = require('./platform');
const { createZip } = require('./zip');

const MAX_READ = 2 * 1024 * 1024;
const MAX_EXPORT_FILE = 5 * 1024 * 1024;
const MAX_HISTORY = 12;

function ensureDir() {
  const root = path.join(config.root(), 'diagnostics');
  fs.mkdirSync(path.join(root, 'records'), { recursive: true });
  return root;
}

function redact(text) {
  return String(text || '')
    .replace(/(--accessToken\s+)(\S+)/gi, '$1<已隐藏>')
    .replace(/(--accessToken=)(\S+)/gi, '$1<已隐藏>')
    .replace(/(--clientId\s+)(\S+)/gi, '$1<已隐藏>')
    .replace(/(--clientId=)(\S+)/gi, '$1<已隐藏>')
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1<已隐藏>')
    .replace(/("(?:accessToken|refreshToken|clientSecret)"\s*:\s*")[^"]+(")/gi, '$1<已隐藏>$2')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<令牌已隐藏>');
}

function safeRead(file, maxBytes = MAX_READ) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return '';
    const size = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    fs.closeSync(fd);
    const text = buffer.toString('utf8');
    return stat.size > size ? `…（文件较大，仅保留最后 ${Math.round(size / 1024)} KB）\n${text}` : text;
  } catch (err) {
    return '';
  }
}

function listFiles(dir, pattern = null) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && (!pattern || pattern.test(entry.name)))
      .map((entry) => path.join(dir, entry.name));
  } catch (err) {
    return [];
  }
}

function newestFiles(files, after = 0, limit = 3) {
  return files
    .map((file) => {
      try { return { file, stat: fs.statSync(file) }; } catch (err) { return null; }
    })
    .filter((item) => item && item.stat.mtimeMs >= after)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, limit)
    .map((item) => item.file);
}

function crashReportFiles(gameDir, startedAt) {
  const reports = listFiles(path.join(gameDir, 'crash-reports'), /\.(txt|log)$/i);
  const hserr = listFiles(gameDir, /^hs_err_pid\d+\.log$/i);
  return newestFiles(reports.concat(hserr), Math.max(0, startedAt - 15000), 4);
}

function gameLogFiles(gameDir) {
  const logs = [
    path.join(gameDir, 'logs', 'latest.log'),
    path.join(gameDir, 'logs', 'debug.log'),
  ];
  return logs.filter((file) => {
    try { return fs.statSync(file).isFile(); } catch (err) { return false; }
  });
}

function lineEvidence(text, regex) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (regex.test(line)) return line.trim().slice(0, 320);
  }
  return '';
}

function normalizePatterns() {
  return [
    {
      id: 'out-of-memory',
      severity: 'critical',
      title: '内存不足',
      confidence: 'high',
      test: /OutOfMemoryError|GC overhead limit exceeded|Java heap space|insufficient memory/i,
      detail: 'Java 已经用完了分配给游戏的堆内存，常见于模组较多、整合包较大或内存设置过低。',
      suggestions: [
        '在「设置」里把内存调到 4096–8192 MB，不要超过电脑可用内存的 70%。',
        '关闭占用内存较高的其他程序，或减少同时安装的大型模组。',
        '如果仍然崩溃，请导出诊断报告并查看是否同时存在模组冲突。',
      ],
    },
    {
      id: 'java-version',
      severity: 'error',
      title: 'Java 版本不匹配',
      confidence: 'high',
      test: /UnsupportedClassVersionError|Unsupported class file major version|requires Java (?:8|11|17|21)|class file version \d+/i,
      detail: '游戏或模组是用更高版本的 Java 编译的，当前启动器选中的 Java 太旧，无法加载这些 class 文件。',
      suggestions: [
        '在「设置 → Java 运行环境」中换成与游戏版本匹配的 Java（1.17+ 通常需要 Java 17 或 21）。',
        '点击「自动安装 Java」安装对应版本，然后重新启动游戏。',
      ],
    },
    {
      id: 'mixin-conflict',
      severity: 'error',
      title: '模组注入冲突',
      confidence: 'high',
      test: /Mixin apply failed|MixinTransformerError|MixinException|Critical injection failure|mixin.*failed/i,
      detail: '两个或更多模组修改了同一个游戏类，注入顺序或版本不兼容，导致游戏在启动阶段崩溃。',
      suggestions: [
        '暂时移除最近添加的模组，或一次只启用一个可疑模组来定位冲突。',
        '检查模组是否支持当前的 Minecraft 和加载器版本，并补齐作者要求的前置。',
        '在模组列表里禁用冲突模组后重试；诊断报告会记录已安装模组文件名。',
      ],
    },
    {
      id: 'mod-dependency',
      severity: 'error',
      title: '模组依赖不完整',
      confidence: 'high',
      test: /ModResolutionException|Incompatible mod set|Missing or unsupported mandatory dependencies|requires .* which is missing|depends on .* not installed/i,
      detail: '某个模组缺少必需的前置模组，或前置版本与它不匹配。',
      suggestions: [
        '回到「模组」页重新检查依赖树，安装缺失的必需前置。',
        '确认所有模组都对应同一个 Minecraft 版本和加载器（Fabric / Forge / NeoForge / Quilt）。',
      ],
    },
    {
      id: 'mod-class-error',
      severity: 'error',
      title: '模组与游戏版本不兼容',
      confidence: 'medium',
      test: /NoSuchMethodError|NoClassDefFoundError|ClassNotFoundException|VerifyError|IncompatibleClassChangeError/i,
      detail: '模组调用了当前游戏或另一个模组中不存在的方法/类，通常是模组版本与游戏版本不匹配。',
      suggestions: [
        '确认模组文件支持当前的 Minecraft 版本和加载器版本。',
        '删除重复安装的同一个模组，或回退到作者推荐的稳定版本。',
        '如果最近更新过游戏，请同步更新所有模组和加载器。',
      ],
    },
    {
      id: 'graphics',
      severity: 'error',
      title: '图形驱动或 OpenGL 初始化失败',
      confidence: 'high',
      test: /GLFW error|Failed to create window|Pixel format not accelerated|OpenGL.*(?:error|failed)|WGL.*failed|Could not initialize GLFW|No OpenGL context/i,
      detail: '游戏无法创建图形窗口或初始化 OpenGL，通常是显卡驱动过旧、远程桌面/虚拟机限制，或图形加速被禁用。',
      suggestions: [
        '更新显卡驱动，并确认没有在远程桌面或没有 3D 加速的虚拟机里启动。',
        '关闭游戏的全屏模式，降低分辨率后再试。',
        '如果使用笔记本双显卡，尝试在显卡控制面板中让 Java 使用独立显卡。',
      ],
    },
    {
      id: 'missing-files',
      severity: 'error',
      title: '游戏文件缺失或损坏',
      confidence: 'high',
      test: /FileNotFoundException|Could not find or load main class|Invalid or corrupt jarfile|zip END header not found|Missing required asset|Failed to download/i,
      detail: '启动所需的客户端、运行库或资源文件不完整，游戏无法继续加载。',
      suggestions: [
        '在「版本」页对该版本执行重新安装或完整性修复。',
        '检查磁盘空间和安全软件是否拦截了文件写入。',
        '如果是整合包，请重新导入并确认下载没有被中断。',
      ],
    },
    {
      id: 'natives',
      severity: 'error',
      title: '本机运行库加载失败',
      confidence: 'high',
      test: /Failed to locate library|UnsatisfiedLinkError|java\.lang\.UnsatisfiedLinkError|GLFW.*natives|LWJGL.*(?:failed|error)/i,
      detail: 'LWJGL/GLFW 的本机库没有正确解压或与当前操作系统架构不匹配。',
      suggestions: [
        '重新安装该版本，让启动器重新校验并下载对应平台的本机库。',
        '确认没有把 Windows 版本的游戏文件复制到 macOS 或 Linux 上使用。',
        '如果使用 ARM 设备，请确认模组和 Java 都支持 ARM64。',
      ],
    },
    {
      id: 'port',
      severity: 'warning',
      title: '端口被占用',
      confidence: 'medium',
      test: /Address already in use|BindException|Cannot assign requested address/i,
      detail: '游戏或某个模组要使用的网络端口已经被其他程序占用。',
      suggestions: [
        '关闭上一次没有完全退出的 Minecraft 进程，或重启电脑后再试。',
        '检查是否有其他程序占用了同一个端口。',
      ],
    },
    {
      id: 'native-crash',
      severity: 'critical',
      title: 'Java 虚拟机发生本机崩溃',
      confidence: 'high',
      test: /A fatal error has been detected by the Java Runtime Environment|EXCEPTION_ACCESS_VIOLATION|EXCEPTION_STACK_OVERFLOW|SIGSEGV|hs_err_pid/i,
      detail: '问题发生在 Java 虚拟机或显卡驱动这一层，普通日志里通常看不到完整的 Java 异常。',
      suggestions: [
        '更新显卡驱动和 Java，并暂时移除带有本机库的模组（如光影、优化模组）。',
        '查看游戏目录里的 hs_err_pid*.log，诊断报告也会一并收集。',
        '如果只在特定版本出现，尝试换一个 Java 小版本或加载器版本。',
      ],
    },
    {
      id: 'killed',
      severity: 'warning',
      title: '进程被系统强制结束',
      confidence: 'medium',
      test: /killed|out of memory.*process|signal 9|SIGKILL/i,
      detail: '游戏进程被操作系统或安全软件强制结束，常见原因是系统内存不足、被杀毒软件拦截，或用户手动结束。',
      suggestions: [
        '检查系统剩余内存和页面文件，关闭占用内存过高的程序。',
        '把启动器、Java 和游戏目录加入安全软件信任列表。',
      ],
    },
  ];
}

const PATTERNS = normalizePatterns();

function collectDiagnosticFiles(info) {
  const gameDir = String(info.gameDir || settings.get().gameDir || '');
  const startedAt = Number(info.startedAt) || (Date.now() - (Number(info.duration) || 0));
  const crashReports = crashReportFiles(gameDir, startedAt);
  const gameLogs = gameLogFiles(gameDir);
  const launchLog = info.logPath && fs.existsSync(info.logPath) ? info.logPath : '';
  const launcherLog = path.join(config.logsDir(), 'minepilot.log');
  const logs = [launchLog, ...gameLogs, launcherLog].filter((file, index, list) => file && list.indexOf(file) === index);
  return { gameDir, startedAt, crashReports, gameLogs, logs, launchLog };
}

function analyze(info = {}) {
  const s = settings.get();
  const files = collectDiagnosticFiles(info);
  const logTail = String(info.logTail || '');
  const pieces = [];
  if (logTail) pieces.push(logTail);
  // 只把本次启动相关的日志送进关键词匹配，避免上次崩溃污染这次结论。
  const analysisFiles = [files.launchLog, ...files.gameLogs, ...files.crashReports].filter(Boolean);
  for (const file of analysisFiles) {
    const text = safeRead(file);
    if (text) pieces.push(`\n--- ${path.basename(file)} ---\n${text}`);
  }
  const text = pieces.join('\n');
  const code = info.code;
  const signal = info.signal || '';
  const killed = Boolean(info.killRequested);
  const codeNumber = code == null ? null : Number(code);
  const unsignedCode = codeNumber == null ? null : (codeNumber >>> 0);
  const abnormalCode = codeNumber != null && codeNumber !== 0;
  const crashText = files.crashReports.map((file) => safeRead(file, 512 * 1024)).join('\n');
  const fatalText = text + '\n' + crashText;

  const causes = [];
  for (const pattern of PATTERNS) {
    if (pattern.test.test(fatalText)) {
      causes.push({
        id: pattern.id,
        title: pattern.title,
        severity: pattern.severity,
        confidence: pattern.confidence,
        detail: pattern.detail,
        evidence: redact(lineEvidence(fatalText, pattern.test)),
        suggestions: pattern.suggestions.slice(),
      });
    }
  }

  // 退出代码本身也是证据。Windows 的访问冲突代码可能以有符号/无符号两种形式出现。
  const nativeExit = unsignedCode === 3221225477 || unsignedCode === 3221225725 || codeNumber === -1073741819 || codeNumber === -1073740791;
  if (nativeExit && !causes.some((cause) => cause.id === 'native-crash')) {
    causes.push({
      id: 'native-exit',
      title: '游戏在本机代码层崩溃',
      severity: 'critical',
      confidence: 'high',
      detail: `游戏进程以本机异常代码 ${code} 退出，通常是显卡驱动、Java 本机库或模组注入导致的。`,
      evidence: `退出代码：${code}`,
      suggestions: [
        '更新显卡驱动和 Java，暂时禁用光影/优化类模组。',
        '查看游戏目录下的 hs_err_pid*.log，并导出诊断报告。',
      ],
    });
  }
  if ((unsignedCode === 137 || signal === 'SIGKILL') && !killed && !causes.some((cause) => cause.id === 'killed')) {
    causes.push({
      id: 'sigkill',
      title: '进程被强制终止',
      severity: 'warning',
      confidence: 'medium',
      detail: '游戏收到 SIGKILL，可能是系统内存不足、安全软件或外部结束进程。',
      evidence: signal ? `信号：${signal}` : `退出代码：${code}`,
      suggestions: ['检查系统内存与安全软件，并确认不是手动结束了进程。'],
    });
  }

  const hasCrashReport = files.crashReports.length > 0;
  const crashed = !killed && (abnormalCode || Boolean(signal) || causes.length > 0 || (hasCrashReport && codeNumber === 0));
  let primary = causes[0] || null;
  if (!primary && hasCrashReport) {
    primary = {
      id: 'crash-report',
      title: '游戏崩溃并生成了崩溃报告',
      severity: 'error',
      confidence: 'medium',
      detail: '启动器找到了本次运行生成的崩溃报告，但日志中没有匹配到常见关键词。',
      evidence: path.basename(files.crashReports[0]),
      suggestions: [
        '打开诊断页查看崩溃报告摘要，或导出报告后在社区求助。',
        '尝试移除最近安装的模组，并确认 Java 版本与游戏匹配。',
      ],
    };
    causes.push(primary);
  }
  if (!primary && crashed) {
    primary = {
      id: 'unknown',
      title: '游戏异常退出',
      severity: 'error',
      confidence: 'low',
      detail: `游戏进程以代码 ${code == null ? '未知' : code} 退出，但日志中没有找到明确的崩溃关键词。`,
      evidence: '建议查看完整启动日志和崩溃报告目录。',
      suggestions: [
        '打开日志抽屉查看退出前的最后几行输出。',
        '导出诊断报告，里面包含启动参数、系统信息和日志摘要。',
      ],
    };
    causes.push(primary);
  }

  const durationSec = Math.max(0, Math.round((Number(info.duration) || 0) / 1000));
  const exitExplanation = killed
    ? '你从启动器结束了游戏进程，这不是崩溃。'
    : signal
      ? `游戏进程收到 ${signal} 信号后结束，运行了约 ${durationSec} 秒。`
      : codeNumber === 0
        ? `游戏正常结束，运行了约 ${durationSec} 秒。`
        : `游戏进程异常结束，退出代码 ${codeNumber == null ? '未知' : codeNumber}，运行了约 ${durationSec} 秒。`;

  const suggestions = [];
  for (const cause of causes) {
    for (const suggestion of cause.suggestions) {
      if (!suggestions.includes(suggestion)) suggestions.push(suggestion);
    }
  }
  if (crashed && !suggestions.length) {
    suggestions.push('导出诊断报告，并附上最近安装的模组列表，方便进一步排查。');
  }

  const id = `diag-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const record = {
    id,
    createdAt: Date.now(),
    crashed,
    killed,
    severity: primary ? primary.severity : 'info',
    title: killed ? '游戏已由用户结束' : (primary ? primary.title : '游戏正常退出'),
    summary: killed
      ? '这次退出是启动器主动结束进程，不属于崩溃。'
      : primary
        ? primary.detail
        : '游戏正常退出，没有发现崩溃迹象。',
    exit: {
      code: codeNumber,
      signal: signal || null,
      duration: Number(info.duration) || 0,
      explanation: exitExplanation,
    },
    versionId: String(info.versionId || ''),
    gameDir: files.gameDir,
    causes,
    suggestions,
    files: {
      logs: files.logs,
      crashReports: files.crashReports,
      launchLog: files.launchLog,
    },
    evidence: causes.map((cause) => ({ title: cause.title, line: cause.evidence || '' })),
    logExcerpt: redact(safeRead(files.launchLog) || safeRead(files.gameLogs[0] || '') || logTail),
    logTail: redact(logTail),
    mods: listMods(files.gameDir),
    system: buildSystemInfo({
      appVersion: info.appVersion,
      javaPath: info.javaPath || '',
      javaMajor: info.javaMajor || 0,
      versionId: info.versionId || '',
      settings: s,
    }),
  };
  return record;
}

function listMods(gameDir) {
  const dir = path.join(String(gameDir || ''), 'mods');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(jar|jar\.disabled)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, 300);
  } catch (err) {
    return [];
  }
}

function buildSystemInfo(extra = {}) {
  const s = extra.settings || settings.get();
  const cpus = os.cpus() || [];
  const selected = {
    gameDir: s.gameDir,
    memoryMb: s.memoryAuto !== false ? settings.recommendedMemory() : s.memoryMb,
    memoryAuto: s.memoryAuto !== false,
    memoryOptimize: s.memoryOptimize !== false,
    width: s.width,
    height: s.height,
    fullscreen: s.fullscreen,
    versionIsolation: s.versionIsolation,
    downloadSource: s.downloadSource,
    authMode: s.authMode,
    theme: s.theme,
    uiScale: s.uiScale,
  };
  return {
    generatedAt: new Date().toISOString(),
    launcher: {
      name: 'MinePilot',
      version: extra.appVersion || '',
      platform: platform.label(),
      platformId: platform.name(),
      arch: process.arch,
      electron: process.versions.electron || '',
      chromium: process.versions.chrome || '',
      node: process.versions.node,
    },
    os: {
      platform: process.platform,
      release: os.release(),
      version: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '',
      arch: process.arch,
      cpus: cpus.length,
      cpuModel: cpus[0] ? cpus[0].model : '',
      totalMemoryMb: Math.round(os.totalmem() / 1048576),
      freeMemoryMb: Math.round(os.freemem() / 1048576),
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
    },
    java: {
      path: extra.javaPath || s.javaPath || '',
      major: extra.javaMajor || 0,
    },
    game: {
      versionId: extra.versionId || '',
      gameDir: extra.settings ? extra.settings.gameDir : s.gameDir,
    },
    environment: {
      LANG: process.env.LANG || '',
      DISPLAY: process.env.DISPLAY || '',
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || '',
      XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE || '',
    },
    settings: selected,
  };
}

function recordPath(id) {
  return path.join(ensureDir(), 'records', `${String(id || '').replace(/[^a-z0-9-]/gi, '')}.json`);
}

function save(record) {
  if (!record || !record.id) return null;
  ensureDir();
  const file = recordPath(record.id);
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  fs.writeFileSync(path.join(ensureDir(), 'latest.json'), JSON.stringify(record, null, 2), 'utf8');

  const historyFile = path.join(ensureDir(), 'history.json');
  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch (err) { history = []; }
  if (!Array.isArray(history)) history = [];
  history.unshift({
    id: record.id,
    createdAt: record.createdAt,
    title: record.title,
    severity: record.severity,
    versionId: record.versionId,
    code: record.exit ? record.exit.code : null,
    subject: record.summary,
  });
  history = history.slice(0, MAX_HISTORY);
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), 'utf8');

  // 只保留历史中列出的记录，避免诊断目录无限增长。
  try {
    const keep = new Set(history.map((item) => recordPath(item.id)));
    for (const filePath of listFiles(path.join(ensureDir(), 'records'), /\.json$/i)) {
      if (!keep.has(filePath)) fs.rmSync(filePath, { force: true });
    }
  } catch (err) {
    logger.warn('清理诊断历史失败:', err.message);
  }
  return record;
}

function latest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ensureDir(), 'latest.json'), 'utf8'));
  } catch (err) {
    return null;
  }
}

function history() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ensureDir(), 'history.json'), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    return [];
  }
}

function get(id) {
  if (id) {
    try { return JSON.parse(fs.readFileSync(recordPath(id), 'utf8')); } catch (err) { return null; }
  }
  return latest();
}

function markdown(record) {
  const lines = [
    '# MinePilot 诊断报告',
    '',
    `生成时间：${new Date(record.createdAt).toLocaleString('zh-CN')}`,
    `版本：${record.versionId || '未知'}`,
    `结论：${record.title}`,
    '',
    record.summary,
    '',
    '## 退出信息',
    '',
    `- 退出代码：${record.exit && record.exit.code != null ? record.exit.code : '未知'}`,
    `- 信号：${record.exit && record.exit.signal ? record.exit.signal : '无'}`,
    `- 运行时长：${Math.round(((record.exit && record.exit.duration) || 0) / 1000)} 秒`,
    `- 说明：${record.exit ? record.exit.explanation : '—'}`,
    '',
    '## 可能原因',
    '',
  ];
  if (!record.causes || !record.causes.length) lines.push('没有识别到明确原因，请查看日志摘要。', '');
  (record.causes || []).forEach((cause, index) => {
    lines.push(`### ${index + 1}. ${cause.title}`, '', `- 置信度：${cause.confidence}`, `- 说明：${cause.detail}`, '');
    if (cause.evidence) lines.push('```text', redact(cause.evidence), '```', '');
    lines.push('建议：', '');
    for (const suggestion of cause.suggestions || []) lines.push(`- ${suggestion}`);
    lines.push('');
  });
  lines.push('## 已安装模组', '');
  if (record.mods && record.mods.length) for (const mod of record.mods) lines.push(`- ${mod}`);
  else lines.push('没有找到模组文件。');
  lines.push('', '## 系统信息', '', '```json', JSON.stringify(record.system, null, 2), '```', '');
  lines.push('## 日志摘要', '', '```text', redact(record.logExcerpt || '没有日志内容'), '```', '');
  lines.push('', '> 报告中的访问令牌、会话令牌已经隐藏。请只把报告发送给你信任的人。', '');
  return lines.join('\n');
}

function addFileEntry(entries, zipName, file) {
  try {
    if (!file || !fs.existsSync(file)) return;
    const stat = fs.statSync(file);
    if (!stat.isFile()) return;
    // 日志必须先在内存中脱敏再写入压缩包，不能直接复制原文件。
    const text = safeRead(file, MAX_EXPORT_FILE);
    entries.push({
      name: zipName,
      data: Buffer.from(redact(text), 'utf8'),
    });
  } catch (err) { /* ignore */ }
}

function exportReport(record, outputPath) {
  if (!record) throw new Error('没有可导出的诊断记录');
  ensureDir();
  const target = path.resolve(outputPath || path.join(config.root(), 'diagnostics', 'MinePilot-Diagnostic.zip'));
  const stamp = new Date(record.createdAt || Date.now());
  const date = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}${String(stamp.getSeconds()).padStart(2, '0')}`;
  const entries = [];
  entries.push({ name: 'REPORT.md', data: Buffer.from(markdown(record), 'utf8') });
  entries.push({ name: 'report.json', data: Buffer.from(JSON.stringify(record, null, 2), 'utf8') });
  entries.push({ name: 'system.json', data: Buffer.from(JSON.stringify(record.system, null, 2), 'utf8') });
  entries.push({
    name: 'README.txt',
    data: Buffer.from([
      'MinePilot 诊断报告',
      `生成时间：${stamp.toLocaleString('zh-CN')}`,
      '',
      'REPORT.md 是给人看的说明。',
      'report.json 是原始诊断数据。',
      'logs/ 目录是启动日志、Minecraft 日志和崩溃报告。',
      'system.json 是系统与 Java 信息。',
      '',
      '报告会隐藏访问令牌；仍请只发送给信任的人。',
    ].join('\n'), 'utf8'),
  });
  const used = new Set(entries.map((entry) => entry.name));
  const addUnique = (name, file) => {
    let zipName = name;
    let counter = 2;
    while (used.has(zipName)) {
      const ext = path.extname(name);
      zipName = `${path.basename(name, ext)}-${counter}${ext}`;
      counter += 1;
    }
    used.add(zipName);
    addFileEntry(entries, zipName, file);
  };
  for (const file of (record.files && record.files.logs) || []) addUnique(`logs/${path.basename(file)}`, file);
  for (const file of (record.files && record.files.crashReports) || []) addUnique(`crash-reports/${path.basename(file)}`, file);
  const modList = listMods(record.gameDir || '');
  entries.push({
    name: 'mods/list.txt',
    data: Buffer.from(modList.length ? modList.join('\n') : '没有找到模组文件。\n', 'utf8'),
  });
  // 保留 mods/list.txt，方便直接搜索模组文件名。
  createZip(entries, target, { onEntry: null });
  return { ok: true, path: target, fileName: path.basename(target), bytes: fs.statSync(target).size, date };
}

module.exports = {
  analyze,
  save,
  latest,
  history,
  get,
  exportReport,
  buildSystemInfo,
  markdown,
  redact,
  listMods,
};