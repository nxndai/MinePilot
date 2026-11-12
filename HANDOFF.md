# MinePilot 交接说明（2026-11-12）

这是给下一个对话的入口文档，先读这里，再读 `README.md` 和当前 diff。

## 1. 项目与当前状态

- 项目路径：`C:\Users\these\Desktop\deeep`
- 类型：Electron Minecraft 启动器（主进程 `main.js`，Web 预览服务 `server.js`，渲染层 `renderer/`）。
- 主分支：`main`
- 当前 HEAD：`9757ccb` `feat: add online modpack option and fix text overflow`，**已推送**。
- 源码版本：`package.json` = **1.11.6**。
- **`v1.11.6` 已打标签、已发布 Release**（6 个附件：Setup / Edge Setup / portable 各带 `.sha256`）。
- CASI 状态：CI + Build Windows release 两个 workflow 均 success。
- 工作区当前干净；`dist/`、`.test-data/` 是 gitignore 的构建产物。

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

- **UI 点击层没跑成**：本会话内 Electron 启动即崩（`dist` 里 33.2.0、`runtime` 里 20.18.0 都一样，
  `--shot` 返回 `0x80000003`；清 `ELECTRON_RUN_AS_NODE`、加 `MINEPILOT_NO_SANDBOX/DISABLE_GPU/SINGLE_PROCESS`
  均无效，无崩溃日志）。所以「点整合包标签 → 点下载整合包 → 版本弹窗 → 确认」这一段只有代码契约级核对。
- 补测方法：在本机双击 `dist\MinePilot\MinePilot.exe`，走一遍
  「模组 → 整合包 → 搜索 Fabulously Optimized → 下载整合包 → 选择版本 → 下载并导入」。
- 自动化脚本留在 `C:\Users\these\AppData\Local\Temp\mp-e2e\ui-e2e.js`（CDP 驱动真实窗口，
  需要 `--remote-debugging-port=9333`）；临时目录可能被系统清理，需要时按同思路重写。

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

# 4. 提交推送（信息别用 wip:）
git add -A; git commit -m "feat: ..."; git push origin main

# 5. 打标签触发 Actions 构建
git tag -a v1.11.6 -m "MinePilot 1.11.6"; git push origin v1.11.6

# 6. 等 Actions 成功，再把 portable zip + .sha256 用 API 传到 Release，
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
- **`MINEPILOT_HOME` 只隔离启动器数据，不隔离 `settings.gameDir`**。做整合包/版本测试时必须显式把
  `gameDir` 指到临时目录，否则会往真实 `%APPDATA%\.minecraft` 里装实例（1.11.6 测试时踩过一次，
  已按 `.minepilot.json` 标记确认后删除，只留下 3.5MB Fabric 库缓存）。
- DSH 环境默认带 `ELECTRON_RUN_AS_NODE=1`，启动 Electron 前必须清除，否则报 `bad option: --no-sandbox`。
- 真实用户数据在 `%APPDATA%\MinePilot` 和 `%APPDATA%\.minecraft`，不要覆盖或清理。
- 本会话内 Electron 无法启动（见第 3 节），UI 验证需要在桌面手动做。

## 9. 下一步建议

1. UI 点击层补测（见第 3 节），确认版本弹窗与进度条。
2. 用户继续反馈「显示超出」时，先问清页面/元素；当前已覆盖诊断证据与模组标题。
3. 下一版发布按第 4、5 节流程走，别忘了同步本地归档。