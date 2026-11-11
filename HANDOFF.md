# MinePilot 交接说明（2026-11-11）

这是给下一个对话的入口文档，先读这里，再读 `README.md` 和当前 diff。

## 1. 项目与当前状态

- 项目路径：`C:\Users\these\Desktop\deeep`
- 类型：Electron Minecraft 启动器（主进程 `main.js`，Web 预览服务 `server.js`，渲染层 `renderer/`）。
- 主分支：`main`
- 上一个已发布版本：`v1.11.5`（提交 `f08f06c`，已推送并发布 Release）。
- 当前本地 HEAD：`git log -1`，提交标题 `wip: add modpack option and fix text overflow`（**仅本地提交，尚未 push**）。
- 当前源码版本：`package.json` 里是 **1.11.6**，但 **1.11.6 还没有打标签/发布**。
- 工作区当前应是干净的；`HANDOFF.md` 和所有 1.11.6 改动都在 `d4f1d8d` 里。

## 2. 用户最近的要求

1. **增加整合包选项**：模组页需要能像模组一样选择/搜索整合包，而不是只能导入本地文件。
2. **修复显示超出容器**：长文本显示不全时用省略号，不能撑破所在卡片/弹窗。

当前实现的是：
- 模组页新增「模组 / 整合包」分段选项。
- 整合包类型下搜索 Modrinth 整合包，结果按钮为「下载整合包」。
- 下载 `.mrpack` 后自动创建独立实例，不修改当前实例。
- 本地导入整合包时新增「新建独立实例 / 合并到当前实例」选择。
- 诊断证据和长模组标题增加行数限制/省略号。

## 3. 本次改动文件

### `renderer/index.html`
- 增加 `#mod-type-tabs`：「模组 / 整合包」。

### `renderer/js/mods.js`
- 新增 `projectType` 状态、`isModpack()`、`setProjectType()`。
- 搜索请求带上 `projectType`；整合包只支持 Modrinth。
- 整合包结果行使用 `data-modpack-install`。
- 新增 `chooseModpack()`：选 `.mrpack` 版本 -> 确认 -> 调 `modpack:download` -> 刷新版本列表并选中新实例。
- 导入整合包弹窗新增新实例/当前实例单选，并把 `mode` 传给 `modpack:import`。
- 搜索失败、空状态、提示文案适配整合包。

### `src/core/modpack.js`
- 新增 `installFromUrl()`：
  - 只允许 `https://cdn.modrinth.com/...` 和 `https://cdn-raw.modrinth.com/...`。
  - 下载 `.mrpack` 到缓存目录，SHA1 校验，调用 `importPack(..., { mode: 'new' })`。
  - 进度映射：下载 0-48%，导入 50-100%。
  - 结束后清理临时目录。
- 导出 `installFromUrl`。

### `main.js` / `server.js`
- 新增 `modpack:download` IPC / Web 路由（在线下载开关、忙锁、取消、进度事件）。
- `modpack:import` 透传 `mode`（`new` / `current`）。

### `renderer/styles.css`
- `.diag-evidence`：`-webkit-line-clamp: 5`、`white-space: pre-wrap`、`overflow: hidden`、`overflow-wrap: anywhere`，超出显示省略号。
- `.mod-title-link`：单行省略，避免长标题撑破模组卡片。
- `.pack-mode`：导入模式单选样式。

### `renderer/js/diagnostics.js`
- 证据 `<pre>` 增加 `title`，悬停可看完整内容。

### `tests/mods.test.js`
- 新增整合包 URL 白名单拒绝测试。
- 现有推荐前置、模组安装测试仍通过。

### `README.md`
- 版本号改为 1.11.6。
- 更新记录写入 1.11.6 功能说明。

## 4. 已验证

- `npm test`：13 组测试全部通过（包含 mods 的推荐前置、整合包 URL 白名单测试）。
- Electron 真实界面：
  - 「模组 / 整合包」切换正常；
  - 整合包占位符变为“搜索 Modrinth 整合包…”；
  - 结果按钮渲染为“下载整合包”。
- 全页面文本溢出扫描：所有页面（包括诊断页）均无文本超出容器。
- 诊断页长证据被限制为 5 行并显示省略号。

## 5. 尚未完成 / 失败原因

### 在线整合包搜索/下载没有完成端到端实测

当前环境访问 Modrinth 返回：

```text
api.modrinth.com/v2/search 请求失败：fetch failed
```

直接 `fetch` 和 `curl` 也都失败：

```text
curl: (35) Recv failure: Connection was reset
```

这是**当前网络到 Modrinth 的连接被重置**，不是本次代码逻辑错误。单元测试、UI 切换、按钮渲染已经验证；在线搜索和 `.mrpack` 实际下载需要等网络恢复后补测。

### 1.11.6 还没发布

需要执行：

```powershell
# 1. 确认/提交工作区
git status --short
npm test
node tools/package-win.js

# 2. 安装包
node tools/package-desktop-installer.js

# 3. 便携包（按之前版本的做法，排除 data）
$src=(Resolve-Path 'dist\MinePilot').Path
$zip=Join-Path (Resolve-Path 'dist').Path 'MinePilot_1.11.6_portable.zip'
tar.exe -a -c -f $zip -C $src --exclude=data --exclude=./data .
(Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()

# 4. 提交、推送、打标签
git add ...
git commit -m "feat: add online modpack option and fix text overflow"
git push origin main
git tag -a v1.11.6 -m "MinePilot 1.11.6"
git push origin v1.11.6

# 5. 等 GitHub Actions 构建 Release
# 6. 下载/上传 portable zip + .sha256 到 Release，并补充 Release 说明
```

发布时注意：
- GitHub Actions 构建的安装包哈希和本机构建不同，Release 里要用 Actions 生成的哈希。
- 上传 portable 需要 `uploads.github.com`（此前环境要固定 `20.205.243.161`，用 `curl --resolve`）。
- GitHub API/token 从 `git credential fill` 取，不要把 token 写入文件或回答。

## 6. 设计约束（下一位不要改错）

- **在线整合包目前只支持 Modrinth**。CurseForge 整合包清单没有文件直链，本版本仍要求用户用下方「导入整合包」选本地 `.zip`；不要假装能直接下载 CurseForge 整合包。
- `installFromUrl` 只允许 Modrinth CDN，不能放宽成任意 URL 下载器。
- 下载整合包必须 `mode: 'new'`，不能覆盖用户当前实例。
- 本地 `.mrpack` 导入默认「新建独立实例」；用户手动选「合并到当前实例」才可合并。
- 长文本修复优先用省略号/行数限制，不要用无限换行把卡片撑高。
- 在线下载仍受「设置 → 下载 → 在线下载」开关控制。

## 7. 测试与运行环境注意

- 本项目测试必须用完整文件访问权限运行，因为 `tests/*` 会在系统临时目录创建文件；DSH 沙箱下会报 EPERM。
- Electron 必须启动为 Electron 模式：如果环境里设置了 `ELECTRON_RUN_AS_NODE`，先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`，否则会报 `bad option: --no-sandbox`。
- `dist/`、`.test-data/` 是 gitignore 的构建/测试产物；不要提交。
- 已删除旧的 `.test-data`（约 1.9GB）和 `gcm-diagnose.log`，项目根目录现在只保留源码、文档、构建脚本和 `dist` 构建产物。
- 真实用户数据在 `%APPDATA%\MinePilot` 和 `%APPDATA%\.minecraft`，不要覆盖或清理。

## 8. 下一步建议

1. 先看 `git diff` 和 `HANDOFF.md`，确认 1.11.6 改动。
2. 网络恢复后手动测试：模组页 -> 整合包 -> 搜索 “Fabulously Optimized” -> 下载 -> 确认创建独立实例 -> 启动。
3. 测完构建安装包、发布 `v1.11.6`。
4. 如果用户继续反馈“显示超出”，先问清是哪个页面/元素；当前扫描已覆盖所有主页面，诊断证据和模组标题已加省略号。