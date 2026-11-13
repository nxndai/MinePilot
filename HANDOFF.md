# MinePilot 交接说明（2026-11-12）

这是给下一个对话的入口文档，先读这里，再读 `README.md` 和当前 diff。

## 1. 项目与当前状态

- 项目路径：`C:\Users\these\Desktop\deeep`
- 类型：Electron Minecraft 启动器（主进程 `main.js`，Web 预览服务 `server.js`，渲染层 `renderer/`）。
- 主分支：`main`
- 当前 HEAD：`ee03eb3` `chore: release 1.11.9`，**已推送**。
- 源码版本：`package.json` = **1.11.9**。
- **`v1.11.9` 已打标签、已发布 Release**（6 个附件，含便携包；修复更新包下载失败，改为镜像回退 + 断点续传）。
- 上一个版本 `v1.11.8`（`1aef5ad`）同样已发布；CI + Build Windows release 均 success。
- `dist/`、`.test-data/` 是 gitignore 的构建产物。

历史：上一个版本 `v1.11.5`（`f08f06c`）。

## 2. 1.11.6 做了什么

1. **模组页新增整合包选项**：`renderer/index.html` 加 `#mod-type-tabs`（模组 / 整合包）；
   `renderer/js/mods.js` 新增 `projectType` 状态、`isModpack()`、`setProjectType()`、`chooseModpack()`。
2. **在线整合包下载**：`src/core/modpack.js` 新增 `installFromUrl()`，只允许
   `cdn.modrinth.com` / `cdn-raw.modrinth.com`，下载 `.mrpack` → SHA1 校验 → 强制 `mode: 'new'` 建独立实例。
3. **IPC/Web 路由**：`main.js` / `server.js` 新增 `modpack:download`（在线开关、忙锁、取消、进度）。
4. **本地导入整合包**：新增「新建独立实例 / 合并到当前实例」，`modpack:import` 透传 `mode`。
5. **长文本修复**：`.diag-evidence` 限 5 行 + 省略号；`.mod-title-link` 单行省略；证据 `<pre>` 加 `title` 悬停全文。

## 3. 已验证

- `npm test`：13 组全通过（含整合包 CDN 白名单拒绝测试）。
- **真机在线整合包链路实测通过**（生产代码，非 mock）：
  搜索「Fabulously Optimized」→ 21 个结果（全部 `project_type: modpack`）→ 下载
  `Fabulously.Optimized-5.4.1.mrpack` → 自动装 Fabric 0.14.23 / MC 1.20.1 → 下载 51 个清单文件、
  覆盖 27 个 → 生成含 48 个 mod 的独立实例，`.minepilot.json` 标记正确，版本列表可见、可选中。
- UI 标签切换、占位符、按钮文案此前已在真实 Electron 窗口验证过。

### 未验证（下次补）

- **整合包 UI 点击层仍未补测**：「点整合包标签 → 下载整合包 → 版本弹窗 → 确认」只有代码契约级核对。
  （之前以为 Electron 在本会话跑不起来，现在知道加 `--no-sandbox` 就能跑，见第 8 节。）
- 补测方法：`.\dist\MinePilot\MinePilot.exe --no-sandbox --remote-debugging-port=9333`，
  然后走一遍「模组 → 整合包 → 搜索 Fabulously Optimized → 下载整合包 → 选择版本 → 下载并导入」。
- 自动化脚本：`C:\Users\these\AppData\Local\Temp\mp-e2e\ui-e2e.js`（整合包）和
  `update-ui.js` / `update-download-test.js`（更新按钮）；临时目录可能被清理，需要时按同思路重写。

## 4. 发布流程（1.11.6 已跑通的顺序）

```powershell
# 1. 本地构建便携应用
node tools/package-win.js

# 2. 本地安装包（写进 dist\installer 并自动生成 .sha256）
node tools/package-desktop-installer.js

# 3. 便携包（排除 data）
$src=(Resolve-Path 'dist\MinePilot').Path
$zip=Join-Path (Resolve-Path 'dist').Path "MinePilot_1.11.6_portable.zip"
tar.exe -a -c -f $zip -C $src --exclude=data --exclude=./data .
$h=(Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"$h  MinePilot_1.11.6_portable.zip" | Set-Content "$zip.sha256" -Encoding ascii -NoNewline

# 4. 同步文档（用户明确要求：以后每次发版都要一起更新）
#    README.md：顶部「当前最新版本」与日期、快速开始里的文件名（安装包 / 便携包）、
#               受影响的功能条目、更新记录新增小节、已知限制
#    HANDOFF.md：当前状态、已验证 / 未验证、网络与归档约定

# 5. 提交推送（信息别用 wip:）
git add -A; git commit -m "feat: ..."; git push origin main

# 6. 打标签触发 Actions 构建
git tag -a v1.11.6 -m "MinePilot 1.11.6"; git push origin v1.11.6

# 7. 等 Actions 成功，再把 portable zip + .sha256 用 API 传到 Release，
#    并把「新增 / 验证」小节和便携版条目补进 Release 说明
```

发布时注意：

- **本地归档 = 本地构建，Release = Actions 构建，两者 SHA256 必然不同**（实测 1.11.5：本地
  `bd1bb548…`，Release `a27ea102…`）。归档里放本地构建即可，别把 Actions 哈希写到本地 `.sha256`。
- 上传 Release 附件走 `uploads.github.com`（需真实 IP，见下节网络说明）。
- GitHub token 从 `git credential fill` 取，不要写进文件或回答里。

## 5. 产物归档约定（用户明确要求：以后每次都这样）

| 内容 | 目录 | 命名 |
| --- | --- | --- |
| 桌面安装包 | `dist\installer\` | `MinePilot_Setup_<版本>.exe` + `.sha256` |
| 便携版 | `dist\` | `MinePilot_<版本>_portable.zip` + `.sha256` |
| Edge 备用版 | `dist\installer\` | `MinePilot_Edge_Setup_<版本>.exe` + `.sha256`（1.11.2 起本地没再建，只有 Actions 建） |

每次发布后都要把新版本按上面的命名补进这两个目录，历史版本（1.7.0 → 1.11.6）都在里面，别清理。

## 6. 网络环境（重要，容易踩坑）

- **本机访问 GitHub 需要 Steam++（Watt Toolkit）加速器**。它没启动时：DNS 正常解析到真实 IP，
  但所有 GitHub IP 的 TLS 都被 reset（`curl: (35) Recv failure: Connection was reset`），
  ghproxy 一类镜像同样被 reset。
- 加速器启动时会把 `*.github.com` 劫持到 `127.0.0.1`；如果它返回 **502**，那是它自己的上游节点故障，
  本地躺着中枪，不是 GitHub 挂了，也不是代码问题。
- 绕过办法 A（首选）：让用户启动/重启加速器，然后 `curl --resolve github.com:443:<真实IP>`。
- 绕过办法 B：本地 CONNECT 代理（`C:\Users\these\AppData\Local\Temp\mp-e2e\gh-proxy.js`），
  对 `github.com` / `api.github.com` / `uploads.github.com` / `codeload` / `release-assets` 硬编码实测可用 IP，
  然后 `git -c http.proxy=http://127.0.0.1:8899 <命令>`。注意：**IP 会失效，要现测现换**；
  `20.205.243.166` 曾在 `net.connect` 下超时而 `curl` 下可用，别把某一组 IP 当常量。
- 代理用完记得 `git config --local --unset http.proxy`，别留在仓库里。
- Modrinth 现在可直连（`api.modrinth.com`、`cdn.modrinth.com` 均 200），不需要代理。

## 7. 设计约束（不要改错）

- **在线整合包目前只支持 Modrinth**。CurseForge 整合包清单没有文件直链，仍要求用户导入本地 `.zip`；
  不要假装能直接下载 CurseForge 整合包。
- `installFromUrl` 只允许 Modrinth CDN，不能放宽成任意 URL 下载器。
- 下载整合包必须 `mode: 'new'`，不能覆盖用户当前实例。
- 本地 `.mrpack` 导入默认「新建独立实例」；用户手动选「合并到当前实例」才可合并。
- 长文本修复优先用省略号/行数限制，不要把卡片撑高。
- 在线下载仍受「设置 → 下载 → 在线下载」开关控制（`settings.onlineDownloads`）。

## 8. 测试与运行环境注意

- `npm test` 必须用完整文件访问权限运行（`tests/*` 会写系统临时目录），沙箱下会 EPERM。
- **改 README 要注意目录**：`tests/docs.test.js` 会检查「目录里的每条链接都能命中锚点」「每个二级章节都有
  `<a id>` 锚点」「没有未被目录引用的锚点」。新增章节时记得同时加锚点和目录条目，否则 `npm test` 会失败。
- **`MINEPILOT_HOME` 只隔离启动器数据，不隔离 `settings.gameDir`**。做整合包/版本测试时必须显式把
  `gameDir` 指到临时目录，否则会往真实 `%APPDATA%\.minecraft` 里装实例（1.11.6 测试时踩过一次，
  已按 `.minepilot.json` 标记确认后删除，只留下 3.5MB Fabric 库缓存）。
- DSH 环境默认带 `ELECTRON_RUN_AS_NODE=1`，启动 Electron 前必须清除，否则报 `bad option: --no-sandbox`。
- **本会话里启动打包版必须加 `--no-sandbox`**，否则启动即退出：
  `.\dist\MinePilot\MinePilot.exe --no-sandbox --remote-debugging-port=9333`。
  注意 `--remote-debugging-port` 只有和 `--no-sandbox` 一起用才不崩；配合 CDP 可以正常驱动 UI。
  另外**不要给它设 `MINEPILOT_HOME` 到临时目录**——那样单实例锁会创建失败（`Lock file can not be created`）
  然后直接退出；用默认 `%APPDATA%\MinePilot` 反而正常。
- 真实用户数据在 `%APPDATA%\MinePilot` 和 `%APPDATA%\.minecraft`，不要覆盖或清理。

## 9. 下一步建议

1. 用户继续反馈「显示超出」时，先问清页面/元素；当前已覆盖诊断证据与模组标题。
2. 下一版发布按第 4、5 节流程走，别忘了同步本地归档和 README。
3. 更新按钮已可用；若用户要求，再补「启动时自动提示有新版本」的 toast。

## 10. 启动器更新按钮（2026-11-12，已随 1.11.7 发布）

需求：更新不能要求用户先填更新源；点一下要能跳到仓库并下载最新安装包。

实现：

- `src/core/updater.js`：`feedUrl()` 现在回落到内置 `OFFICIAL_REPO`（`https://github.com/nxndai/MinePilot`），
  设置 `updateFeedUrl` 或 `MINEPILOT_UPDATE_URL` 仍可覆盖；`snapshot()` 新增 `custom` / `source` / `releaseUrl`，
  `configured` 恒为 true（永远有源可用）。
- `src/core/net.js`：新增 `httpFetch()`，桌面版优先用 **Electron `net.fetch`**（信任系统根证书与系统代理），
  Node 环境回退到全局 `fetch`。**这是关键修复**：Steam++ 等加速器做 TLS 中间人时，Node 自带 fetch 会
  报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，换成 Electron 网络栈后测更新检查直接成功。
  `fetchJson` / `fetchText` / `downloadFile` 三处都已改用它。
- `renderer/index.html` + `renderer/js/updater.js` + `renderer/styles.css`：侧栏底部新增更新按钮，
  没有新版本时是「检查更新」，发现新版本时高亮成「更新到 vX.Y.Z」；点击执行
  检查 → 打开发布页 → 下载安装包（SHA256 校验）→ 询问是否安装并重启。
  设置页和关于页各加「打开发布页」按钮。
- `renderer/js/about.js`：修掉侧栏版本号被整体覆盖的问题（现在只更新 `#side-version-text`）。

已验证（真实窗口 + CDP）：

- 默认源检查更新成功，显示「已是最新版本（1.11.6）」，穿过加速器的 TLS 中间人也没问题。
- 用本地假更新源（version 9.9.9）验证：侧栏变成「更新到 v9.9.9」、关于页显示版本与说明、
  点下载后状态变「已下载 9.9.9，可以安装并重启」、`updates/` 收到安装包且 SHA256 匹配。
## 11. 1.11.8：联机增强与账户详情（已发布）

### 联机（`src/core/netplay.js` + `renderer/js/netplay.js`）

- `checkPorts({ port })`：TCP 探测 `127.0.0.1` 与各网卡端口是否监听，返回 `anyListening` / `privateOnly` / `advice`。
  **只检测本机**，不做外网探测（外网可达性依赖端口映射，无法在本机判断）。
- `buildShareText(profile, context)`：生成含启动命令与局域网地址的可复制文本，带空格的参数会加引号。
- `exportProfiles` / `importProfiles`：**两端必须用同一套 id 正则** `^[a-zA-Z0-9._-]{1,80}$`，
  否则会出现"能导出但导入被静默丢弃"（1.11.8 修过一次，别改回去）。
- 游戏联动：`settings.netplayAutoStartGame`（开房后启动实例）、`settings.netplayStopOnGameExit`
  （收到 `launch:exit` 时停掉联机进程）。新增的 settings 字段要同时加进 `ALLOWED_KEYS`、`defaults()`
  和 `sanitize` 的布尔分支。

### 账户（`main.js` 里的两个 IPC）

- `auth:profile-detail`：合并 `accounts.summary()` + `skinmanager.list()`；
  **没有账户记录时会用 `settings.offlineName` + `auth.offlineUuid()` 兜底**，否则详情整列是「—」。
- `auth:export-clean`：脱敏导出，只输出账户标识和 `curseforgeApiKey` / `gistToken` / `updateFeedUrl`
  的布尔值，不写任何令牌与密钥明文。

### 验证

- `tests/netplay.test.js` 已扩到覆盖导出/导入往返、非法 id 过滤、缺可执行文件跳过、分享文本引号、端口越界回落。
- 真机窗口（`--no-sandbox --remote-debugging-port=9333` + CDP）：端口检测、账户详情、复制联机信息三处均通过。

## 12. 1.11.9：修复「检测到更新但下载失败」（已发布）

### 根因（已实测确认）

`github.com/.../releases/download/...` 只是 302，真正的字节来自
**`release-assets.githubusercontent.com`**。这个域名在本机连得上 TCP，但 TLS 之后一个字节都收不到
（`curl -L` 25 秒 0 字节）；而检查更新走 `api.github.com` 是通的 —— 所以表现就是"能检测到、下载必然失败"。
加速器（Steam++）只接管了 `github.com` / `api.github.com`，没有接管这个 CDN 域名。

### 修法（`src/core/updater.js` + `src/core/net.js`）

- `updateSources(url)`：GitHub Release 资源额外给两个镜像候选 `https://ghfast.top/`、`https://ghproxy.net/`，
  可用 `MINEPILOT_UPDATE_MIRROR` 覆盖。实测 `ghfast.top` 约 670KB/s；`gh-proxy.com` / `gh.llcks.cc` /
  `ghproxy.cc` 等要么 reset、要么证书错误，别加进列表。
- 下载循环：主地址 `retries: 1` + 20s 空闲超时（没数据就换源），镜像 30s 空闲超时 + 3 次重试。
- `net.downloadFile` 新增 `resume` 选项：已有 `.part` 就带 `Range: bytes=N-` 续传；服务器忽略 Range
  （返回 200）时自动从头重写；续传模式下失败**不删分片**，由后续重试接着下；全部失败才清理。
- 续传时 SHA1 无法继续累加，改为完成后对整份文件重新计算；更新包仍然强制校验 Release 的 SHA256。

### 实测

真实 113MB 安装包：修复前每次都失败；修复后「github.com 90s 无数据 → 切 ghfast.top → 断续重试 →
约 7 分钟完成 → SHA256 `a29065fb…` 与 Release 一致」。

### 踩坑：PowerShell 写文件会带 BOM

用 `Set-Content -Encoding UTF8` 改过 `package.json` 后，文件开头多了 BOM，`JSON.parse` 直接报
`Unexpected token ''`，导致 `package-desktop-installer.js` 失败、`dist/MinePilot/resources/app/package.json`
也跟着带 BOM（打包出来的应用会起不来）。**改 JSON/Markdown 后要检查并去掉 BOM**：

```powershell
node -e "const fs=require('fs');const b=fs.readFileSync('package.json');if(b[0]===0xEF)fs.writeFileSync('package.json',b.slice(3))"
```
