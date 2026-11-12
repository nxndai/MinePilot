# MinePilot

**当前最新版本：v1.11.6（2026-11-12 更新）** · [GitHub 仓库](https://github.com/nxndai/MinePilot) · [查看 Release 页面](https://github.com/nxndai/MinePilot/releases)

> **正版提示**：本启动器仅作为本地游戏管理器，内置的下载功能仅用于拉取用户已合法拥有的游戏文件，请确保您已购买正版 Minecraft。

## 安全声明

- 本启动器开源（MIT），源码、构建脚本和打包工具全部随仓库提供，可公开审计。
- 游戏客户端、依赖库、资源文件、Modrinth / CurseForge 模组和整合包下载均强制校验 SHA1/SHA512；Java 运行时强制校验 SHA256。校验失败会删除文件并中止，不会继续安装。
- Forge / NeoForge 安装器从官方 Maven 或所配置的镜像获取，并在运行前检查 JAR 结构；启动器更新在更新源提供摘要时校验 SHA256。
- 请仅从本项目的 GitHub Releases 页面（https://github.com/nxndai/MinePilot/releases）下载。第三方网盘、群文件或转载站的安装包存在被篡改的风险；每个安装包旁均提供 `.sha256` 校验文件。

## 快速开始

- 下载 `MinePilot_Setup_1.11.6.exe`。
- 双击安装（如果提示未知发布者，选择“仍要运行”）。
- 不想安装时，可下载 `MinePilot_1.11.6_portable.zip`，解压到普通可写目录后双击 `MinePilot.exe` 直接运行。
- 首次启动 → 在「设置 → 下载」勾选“在线下载” → 设置 Java → 下载版本 → 开始游戏。
- 需要英文界面时，在「设置 → 语言」切换到 English；启动游戏时会自动把游戏语言改为英文（`en_us`）。

如果只需要启动本机已安装的版本，可以不开启在线下载。

遇到安装、下载或杀毒软件报毒问题，先看 [常见问题（FAQ）](#faq)。

一个轻量的 Minecraft Java 版启动器，使用 Electron 独立实现。

界面与交互参考了 [Plain Craft Launcher (PCL)](https://github.com/Meloong-Git/PCL) 的设计思路，但**没有复制或修改 PCL 的源代码**。PCL 的源码虽然公开，但采用自定义的《PCL 分发有限许可》，并不是 OSI 认证的开源许可证；本项目因此选择独立实现，详见文末的许可说明。

## 功能

- 版本管理：扫描 `versions/` 目录，识别原版与 `inheritsFrom` 继承式版本（Fabric / Forge / NeoForge / Quilt / OptiFine 等）。
- 原版下载：从 Mojang 官方源获取版本清单，逐版本安装客户端、依赖库、natives 与资源文件。下载源可选“自动（官方优先、镜像兜底）”“BMCLAPI 镜像优先”或“仅官方源”，元数据、依赖库、资源文件和加载器安装器都会按选择顺序尝试，并在失败时自动回退。
- 启动前完整性校验：每次启动自动检查客户端主文件、运行库、natives、日志配置、资源索引和资源对象。开启“在线下载”时，缺失或 SHA1 校验失败的文件会在启动前自动补全；关闭时只做本地校验，发现缺失会提示开启开关后修复。已校验文件使用“大小 + 修改时间”缓存，第二次启动只做快速检查。加载器版本会检查它继承的原版 client.jar。
- 加载器安装：在「版本」页或「下载」页点击「加载器」，会自动识别并一键安装 **Fabric / Forge / NeoForge / Quilt**。Fabric、Quilt 通过官方 Meta 获取启动配置并补全库文件；Forge、NeoForge 自动下载官方安装器、调用 Java 静默安装并识别生成的版本，全程无需手动下载或放置文件。弹窗会标记当前已安装版本，并默认选择推荐/稳定版。
- 模组下载：在「模组」页从 **Modrinth** 或 **CurseForge** 搜索模组，按目标版本的游戏版本与加载器（Fabric / Forge / NeoForge / Quilt）过滤，并支持「功能、优化、科技、魔法、冒险、装饰、世界生成、库/API」等分类筛选。安装时会先展示依赖检查弹窗和依赖树，列出主模组、必需前置、层级关系、是否已存在以及风险提示；确认后自动解析并补齐 required 前置，下载到该版本的 `mods` 目录；作者标注的 optional 推荐前置默认一并勾选下载，也可以在弹窗里取消，只安装必需前置。支持选择具体文件版本、SHA1 校验和安装进度显示。Modrinth 开箱可用；CurseForge 官方 API 要求在「设置 → 模组来源」填入自己的 API Key，Key 只保存在本机，不会上传到其他服务器。
- 可视化模组管理：在「模组与整合包」页按实例列出已安装模组，复选框即可启用/禁用；禁用只是把文件重命名为 `.jar.disabled`，不会移动文件。列表会读取 `fabric.mod.json`、`quilt.mod.json`、`neoforge.mods.toml`、`mods.toml` 或 `mcmod.info` 显示模组名称、版本、加载器和客户端/服务端标记，并同时识别游戏目录和便携目录里的 mods。
- 模组健康检查：读取模组元数据里的 `depends` / `dependencies` 后检查缺失的必需前置、前置版本范围、被禁用前置、重复 modid 和客户端/服务端模组混装，并在实例卡片上直接列出问题文件和修复入口。支持按名称、加载器、客户端/服务端和“有问题的”状态筛选，可对当前筛选结果批量启用或禁用。
- 模组更新检查：按已启用 JAR 的 SHA1 在 Modrinth 反查版本，再按当前游戏版本与加载器获取最新版本，列出“已安装 → 可更新”的差异并提供项目页面入口。没有发布到 Modrinth、无法联网或作者禁用第三方下载的模组会被跳过，不会把猜测结果当成更新。
- 整合包在线下载与导入导出：在「模组与整合包」页切到「整合包」，可以直接搜索 **Modrinth 整合包**并下载 `.mrpack`，校验 SHA1 后自动创建独立实例，不改动当前实例；下载和导入都会显示进度并支持取消。本地导入则把 `.mrpack` 或 `.zip` 拖到导入区，先预览整合包名称、Minecraft 版本、加载器、文件数量和警告，再确认导入；导入方式可选「新建独立实例」或「合并到当前实例」，默认新建独立实例。`.mrpack` 导入会按清单下载文件并校验 SHA512；带 Minecraft/加载器信息时会自动安装对应版本并创建强制隔离的独立实例，避免污染现有模组。也可以把当前实例导出为 `.mrpack`（推荐，可被其他启动器识别）或 `.zip`，导出内容包含 mods、config、defaultconfigs、kubejs、scripts、resourcepacks、shaderpacks、datapacks 和 options.txt，不包含存档、日志、账户或启动器设置。CurseForge 清单 ZIP 只识别不下载，避免猜测文件直链。
- 资源包 / 光影 / 数据包管理：新增「内容」页，按实例列出 `resourcepacks`、`shaderpacks` 和 `datapacks`，读取 `pack.mcmeta` 的名称、描述、格式版本与图标；资源包启用状态写入 `options.txt`，光影写入 `config/iris.properties`，停用会重命名/移动而不删除文件。支持导入 ZIP、预览详情、删除到内容回收站，以及从 Modrinth 按资源包/光影/数据包类型搜索下载并自动启用。
- 联机与内网穿透：新增「联机」页，为 Terracotta / EasyTier / frp 提供官方引导和可选配置模板。填写可执行文件、参数和工作目录后可以一键启动/停止本机联机工具、查看输出并复制局域网地址，参数直接传给进程而不经过 shell。**不捆绑任何第三方二进制、不代管密钥、不绕过正版认证**；浏览器版只展示引导，不能启动本机程序。
- 多账户与安全存储：账户面板支持多个离线账户和多个 Microsoft 账户，可快速切换、设置备注和查看登录有效期；启动时和切换账户时会自动刷新过期凭据。桌面版通过 Electron `safeStorage`（系统钥匙串）加密保存令牌，文件中不再出现明文 access/refresh token；系统安全存储不可用时会明确警告并退回明文。离线账户名与启动身份保持同步。
- 插件市场与权限声明：新增 HTTPS JSON 插件索引，可从「设置 → 插件」刷新市场并安装；安装前展示 `plugin.json` 的 `permissions.network` 域名白名单，安装时按 SHA-256 校验压缩包。插件 API 新增 `registerPanel()`、`getMods()`、`getContent()` 和下载事件 `download:started/progress/completed`；联网域名在 Worker 内通过 fetch/XHR/WebSocket/importScripts 统一拦截，未声明的域名一律拒绝。仓库内提供 `docs/plugin-index.json` 与示例插件，索引格式见下文。
- 账户：离线账户与 Microsoft 正版登录。Microsoft 使用 OAuth 2.0 设备代码流，登录后自动取得正版用户名、UUID 与 Minecraft 访问令牌，可在正版服务器使用。若浏览器没有自动打开，可点「复制链接」手动访问 `https://www.microsoft.com/link`；在浏览器里登录后还需要点「继续 / 接受」完成授权。
- 离线启动：离线 UUID（`MD5("OfflinePlayer:<name>")`）、JVM / 游戏参数替换、natives 解压、日志实时回显。
- 崩溃诊断：游戏异常退出时自动读取退出代码、启动日志、Minecraft 日志、`crash-reports` 和 `hs_err_pid*.log`，用通俗语言给出按可信度排序的原因与处理建议；支持一键导出 ZIP 诊断报告（说明、JSON、系统/Java 信息、脱敏日志、模组清单），并保留最近 12 次异常记录。
- 可行动诊断：内置已知崩溃模式库，包含 OptiFine 与 Fabric 冲突、重复 modid、加载器/架构不匹配、缺少 Fabric API、依赖不完整、内存不足和 Java 版本不匹配等；原因卡片会给出具体修复按钮，例如直接禁用 OptiFine、打开模组管理或 Java 设置、自动安装匹配的 Java。诊断页还可以一键生成**脱敏分享摘要**（隐藏令牌、用户名、本地路径和 IP）并复制，方便粘贴到 Issue 或聊天；公开分享前仍建议自己检查一遍。
- 启动器更新：可配置 HTTPS manifest 或 GitHub Releases 更新源，手动/启动时检查新版本，显示更新说明，下载时校验 SHA256（源提供时），一键启动安装程序。未配置更新源时不会联网，也不会伪造“官方更新服务器”。
- 插件系统：从本地 ZIP 或 HTTPS JSON 索引安装插件，启用/停用/移除；插件在 Web Worker 中运行，通过受限 API 注册命令/面板、读取公开状态与模组列表、监听下载事件，不能直接访问页面 DOM、账户令牌或启动器文件系统。联网默认关闭，只允许 `permissions.network` 声明的域名；插件仍可能上传你主动提供的数据，只应安装可信来源。
- 跨平台：平台相关逻辑集中到 `src/core/platform.js`，支持 Windows / macOS / Linux 的元数据 OS 规则、natives 分类与扩展名、默认游戏目录、Java 发现/Adoptium 安装包（Windows ZIP、macOS/Linux tar.gz）、系统打开命令和 Unix 进程组结束。当前仓库的安装包构建脚本仍只针对 Windows；macOS/Linux 需要在对应系统安装 Node/Electron 后自行打包，详见“跨平台说明”。
- Java 管理：自动发现已安装的 Java 并显示发行版、完整版本号、位数和路径；按游戏版本判断所需 Java 版本，默认选择满足要求的**最低版本**，避免过新的 Java 与旧模组冲突。设置页可以为每个实例单独指定 Java（覆盖自动匹配），手动添加或从列表隐藏 Java，并设置默认 Java。
- Java 自动安装：除 Eclipse Adoptium（Temurin）外，新增 Azul Zulu 与 Amazon Corretto 两种发行版；下载后强制校验 SHA256，校验失败立即删除并中止。Zulu 通过 Azul 元数据 API 选择当前平台包，Corretto 使用官方 latest 包与独立 SHA256 文件；任一来源不可用时可以切换其他发行版。
- 内存管理：默认按物理内存自动推荐分配（2–12 GB），避免手动分配过大拖慢系统；也可以关闭自动分配后手动调整 1–16 GB。可选的 G1GC 垃圾回收调优会减少长时间游玩时的 GC 卡顿和内存抖动，仅在 Java 8 及以上启用；如果 JVM 参数里已经指定了其他 GC，会保留用户设置并跳过内置调优。检测到 32 位 Java 时会自动把堆限制为 1 GB，避免 JVM 无法启动。
- 内存清理：设置页显示当前系统内存占用，可手动清理其他程序暂时不用的工作集，把物理内存腾给游戏。普通清理默认跳过系统关键进程、启动器自身和由启动器启动的游戏进程；深度清理会通过 UAC 请求管理员权限，调用 Windows 系统级工作集、待机列表和文件缓存整理，释放量更大，可能出现短暂卡顿。两种模式都不结束进程、不删除数据；检测到游戏正在运行时不会执行会波及游戏的全量系统整理。
- 版本隔离：开启后每个版本使用独立的 `mods`、`saves`、`options.txt` 等数据目录，避免不同版本/模组互相污染；关闭时沿用全局游戏目录，但检测到 `versions\<版本号>\mods`、`saves`、`options.txt` 等版本独立数据时会自动隔离该实例（PCL 整合包无需手动开启），已有全局模组不会自动迁移。若启动时提示 `EPERM`/“无法写入游戏数据目录”，请确认是从 Windows 桌面快捷方式直接启动（不要在聊天窗口、预览页或沙箱中启动），或把游戏目录换到普通可写文件夹，并将启动器与 Java 加入安全软件信任列表。也可以先双击 `repair-game-dirs.cmd`，为所有版本补齐 `logs`、`saves`、`crash-reports`、`downloads` 等目录。如果原目录存在但仍无法写入文件，启动器会自动改用程序目录下的 `data\game\<版本号>` 便携数据目录，并把原版本的模组、存档和配置复制过去。
- 存档管理：在「存档」页按实例列出 `saves/` 里的世界，显示世界名、最后游玩时间、大小、文件数和从 `level.dat` 读取的游戏版本；支持创建 ZIP 备份、恢复备份、导出和导入世界压缩包，删除存档时默认先自动备份到同实例的 `backups/`。导入/恢复会先解压到临时目录并校验存在 `level.dat`，确认后再合并覆盖并回滚失败操作。未隔离的多个实例共用同一个 `saves/` 时，界面会提示操作会影响所有共享实例。云同步（WebDAV / S3）暂未内置，备份文件仍保存在本机。
- 角色工坊：导入、预览、切换和删除本地皮肤与披风。支持 64×64、64×32、128×128 PNG 皮肤和 64×32、64×64、128×64 披风，自动校验 PNG 文件头与尺寸；经典/纤细模型可切换，预览会同时显示披风。皮肤库独立于账户系统，离线账户也能保存并预览，本地皮肤头像会同步到侧栏和首页。图片默认只保存在本机；登录 Microsoft 正版账户后，可以把当前皮肤上传到 Mojang 档案，让原版游戏直接显示。离线账户没有可写入的 Mojang 档案，游戏内仍显示 Steve/Alex，需要配合支持本地皮肤的模组。
- 外观：深色/浅色主题、默认渐变/纯色/本机图片背景、90%–125% 界面缩放和动画开关。背景图片支持 PNG/JPG/WebP/GIF，限制 12 MB 并校验文件签名；缩放使用 Electron 原生缩放，高 DPI 屏幕下不会裁切内容，并遵循系统“减少动态效果”设置。
- 界面语言：支持简体中文与 English 切换，设置在「设置 → 语言」中，切换后界面自动刷新；启动游戏时会同步修改该实例 `options.txt` 的 `lang` 值（中文 `zh_cn` / 英文 `en_us`），让游戏语言默认跟随启动器，同时保留分辨率、音量等其他游戏设置。
- 运行监控：游戏启动后实时显示 CPU 使用率、内存占用/分配、累计 CPU 时间、线程数、PID、运行时长和最近 120 行日志，并绘制 CPU 走势。可以打开完整日志、复制日志或一键结束整个游戏进程树。
- 下载管理：可选自动、BMCLAPI 镜像或官方源，并发线程数 1–32；自动模式官方优先并在失败时切换镜像，BMCLAPI 模式镜像优先并在失败时回退官方。**“在线下载”默认关闭**，开启后才能安装版本、下载模组/整合包和自动安装 Java；关闭时只使用本机已有文件。
- 设置：界面语言、游戏目录、默认 Java、按实例指定 Java、Java 列表管理（添加/隐藏/设为默认）、自动/手动内存分配、GC 调优、内存清理（普通/深度）、窗口分辨率/全屏、JVM 参数、下载源、并发下载数、是否下载资源文件、在线下载开关、离线玩家名、版本隔离、CurseForge API Key、插件索引地址、联机工具配置、主题、背景、界面缩放和动画。
- 一键删除启动器：设置页底部提供「删除启动器」，确认后强制关闭启动器并删除程序文件、桌面/开始菜单快捷方式和卸载登记。设置、账户、缓存、皮肤以及 Minecraft 游戏存档都会保留；删除后需要重新下载安装包才能再次启动。
- 启动日志抽屉、安装进度与速度显示、取消安装、删除版本、打开游戏/Mods/日志目录。

> 本地皮肤只保存在 MinePilot 数据目录。原版客户端不会读取本地 PNG：离线账户游戏内固定显示 Steve/Alex；登录 Microsoft 正版账户后可在角色工坊点「应用到游戏」上传皮肤；离线账户若要在游戏内显示，需要配合支持本地皮肤的模组（如 CustomSkinLoader）。启动器内预览和头像不受影响。PCL 是源码公开但采用自定义《PCL 分发有限许可》的项目，不是 OSI 开源项目；MinePilot 未复制其代码或素材。

<a id="faq"></a>
<a name="faq"></a>

## 常见问题（FAQ）

> 先看这里，再搜索 [已有 Issue](https://github.com/nxndai/MinePilot/issues)。提交 Bug 时请使用「Bug 反馈」模板，并附上诊断报告。

### 为什么提示“未知发布者”？

MinePilot 当前的 Windows 构建没有代码签名证书，SmartScreen 会把未签名程序标记为“未知发布者”。这表示 Windows 无法验证发布者，不等于文件一定有问题，也不等于杀毒软件已经确认它是病毒。

- 只从 [GitHub Releases](https://github.com/nxndai/MinePilot/releases) 下载，并核对同目录的 `.sha256` 文件：
  ```powershell
  Get-FileHash .\MinePilot_Setup_1.11.6.exe -Algorithm SHA256
  ```
- 安装包提示时选择「更多信息」→「仍要运行」；便携版如果被 SmartScreen 拦住，确认来源后选择「仍要运行」。
- 如果文件来自网盘、群文件或转载站，直接删除，重新从 Release 下载；不要为了绕过提示关闭整个杀毒软件。

### 为什么下载失败？

1. 检查「设置 → 下载」里的“在线下载”是否已开启。它默认关闭；关闭时只能使用本机已有的版本和文件。
2. 在「设置 → 下载」切换下载源：自动（官方优先、镜像兜底）、BMCLAPI 镜像优先或仅官方源，然后重试。官方源和镜像都失败时，检查代理、防火墙、DNS 或更换网络。
3. 确认游戏目录可写、磁盘空间充足，并从桌面或开始菜单正常启动。聊天窗口、预览页或沙箱可能禁止写入，表现为 `EPERM` 或“无法写入游戏数据目录”。
4. 下载模组或整合包时，CurseForge 需要先在「设置 → 模组来源」填入自己的 API Key；Modrinth 不需要。
5. 安装 Forge / NeoForge 需要可用的 Java。先在「设置 → Java 管理」确认默认 Java 和版本匹配，或开启在线下载让启动器自动安装 Java。
6. 下载校验失败通常意味着文件不完整，或下载内容被网络代理/镜像改写。删除该版本的下载缓存后重试，不要继续使用校验失败的文件。仍无法解决时，记录错误文字、版本号和安装方式，按「Bug 反馈」模板附上诊断报告。

### 存档页里的世界会跟着版本隔离吗？

会。存档页按当前选择的实例读取 `saves/`：开启版本隔离，或检测到该版本有独立的 `saves/` 等数据时，每个版本使用自己的存档目录；只有共用全局目录的实例才可能共用同一个 `saves/`，页面会明确提示“操作会影响所有共享实例”。备份写到该实例目录的 `backups/`，不会上传到云端。删除存档默认先备份；恢复备份会覆盖同名世界，导入同名世界则需要先删除或改名。

### 模组显示“缺少前置”或“前置已禁用”怎么办？

先在模组页点「检查问题」，展开问题卡片查看是哪个文件缺少哪个 modid、需要什么版本范围。缺少前置可以用「搜索缺失前置」跳到 Modrinth 下载；前置已禁用时，在同一页启用对应文件即可。重复 modid 表示同一个 modid 有多个 JAR，保留一个并删除或禁用其余文件。版本范围不匹配时，优先安装模组作者要求的版本，不要只改文件名。

### 为什么 Minecraft 1.20 的模组页是空的？

Modrinth 的搜索索引里几乎没有只标记 `1.20` 的模组，绝大多数项目只标记 `1.20.1`；如果实例还是原版，也没有加载器，模组本来就不会被加载。请安装 **1.20.1**，并为它安装 Forge、Fabric 或 NeoForge，再在该实例的模组页搜索。不要直接把 1.20.1 的模组装进 1.20，版本可能不兼容。

### 为什么 VeinMiner 安装后没有效果？

先看下载到的文件名：`veinminer-paper-x.y.z.jar` 是 **Paper 服务端插件**，只能放进服务端 `plugins/`，客户端 `mods/` 不会加载它；Bukkit/Spigot/Folia/Purpur 版本同理。客户端应安装 Forge/Fabric/NeoForge 版本，并确认实例本身装了对应加载器。1.11.2 起，原版实例会提示先安装加载器，纯服务端项目会标记「仅服务端」并禁用安装；客户端安装也只会从对应加载器的文件里选择。Fabric 版 VeinMiner 可能还需要 Fabric API、Fabric Language Kotlin 等前置，安装前看依赖预览里的缺失提示。

### 为什么启动器没有选最高版本的 Java？

自动匹配会优先选择满足该游戏版本要求的**最低** Java 大版本，避免过新的 Java 与旧 Forge/Fabric 模组或加载器不兼容。例如 1.20.1 需要 Java 17，即使系统也装了 Java 21，默认仍使用 Java 17。如果某个实例确实需要更高版本，可在「设置 → Java 管理 → 按版本指定 Java」中单独覆盖；覆盖后启动器会尊重你的选择。

### 诊断分享摘要安全吗？

摘要会隐藏访问令牌、用户名、本地绝对路径和 IP，并省略模组文件名，但仍可能包含游戏版本、加载器、错误类型和系统概况。它不会自动上传到任何服务器；“分享”只是复制到剪贴板。粘贴到公开 Issue 或聊天前，请再检查一遍是否包含不想公开的信息。

### 为什么杀毒软件报毒？

MinePilot 使用 Electron 运行时和自解压安装器，而且当前构建没有代码签名。部分杀毒软件会对“未签名 + 自解压/释放文件 + 联网下载”的程序给出启发式告警，因此存在误报的可能；但也不能排除下载源被篡改，不能一概而论。

- 先按上面的方法核对文件来源和 SHA256。哈希不一致时不要运行，直接重新下载。
- 不要把“关闭实时保护”当作解决方案。确认文件来自官方 Release 且哈希正确后，才考虑把安装包或安装目录加入安全软件的信任列表；如果文件已被隔离，先恢复并核对哈希。
- 如果确认是官方 Release 仍被拦截，可以向杀毒软件厂商提交误报，并附上文件名、版本和 SHA256，帮助后续版本减少误报。
- 不要使用第三方“优化版”“绿色版”或来路不明的整合包；这些文件无法通过本项目的哈希校验。

### 遇到 Bug 怎么反馈？

1. 先搜索 [已有 Issue](https://github.com/nxndai/MinePilot/issues)，避免重复提交。
2. 打开 [新建 Issue](https://github.com/nxndai/MinePilot/issues/new/choose)，选择「Bug 反馈」。
3. 尽量附上诊断报告：启动器左侧「诊断」→ 右上角「导出报告」，把生成的 ZIP 拖进 Issue；如果表单不能直接上传附件，可以先提交，再编辑 Issue 补传。若启动器无法打开或无法导出，请在模板中说明原因，并附上截图或错误文字。
4. 写清启动器版本、安装方式（安装包/便携版）、Windows 版本、复现步骤和期望行为。诊断报告可能包含本地路径、用户名和模组列表，上传前请检查并删除敏感信息。
5. 安全漏洞不要公开提交，请按 [SECURITY.md](SECURITY.md) 私下联系。

## 更新记录

### 1.11.6

- 模组页新增「模组 / 整合包」选项；切到「整合包」后可直接搜索 Modrinth 整合包，下载 `.mrpack` 并自动创建独立实例，不修改当前实例。
- 整合包下载使用官方 Modrinth CDN，校验文件 SHA1，显示下载/导入进度，并支持取消。
- 导入本地整合包时新增「新建独立实例 / 合并到当前实例」选项；`.mrpack` 默认按整合包声明的 Minecraft 和加载器新建实例。
- 修复诊断证据和长模组标题超出容器的问题：长文本自动换行并限制行数，超出部分显示省略号；悬停可查看完整证据。
- 同时提供 `MinePilot_1.11.6_portable.zip` 便携版（解压即用），安装包与便携包内容一致。

### 1.11.5

- 模组安装前的依赖检查现在会列出作者标注的 **optional 推荐前置**，并与必需前置一起构成完整依赖树；默认勾选“同时下载推荐前置”，也可以取消后只安装必需前置。
- 推荐前置支持递归解析，Modrinth 和 CurseForge 的 optional 依赖都会纳入清单；依赖检查窗口会显示“推荐前置”标记、数量和说明。
- 安装请求新增 `includeOptional` 选项，只有用户确认勾选时才会下载可选依赖；必需前置仍然始终安装。
- 补充推荐前置预览、安装选择和必需/可选依赖区分的回归测试。

### 1.11.4

- 修复正常退出被误判为崩溃：启动命令里的 `lwjgl-glfw-...-natives-windows.jar` 曾被当成“本机运行库加载失败”，即使退出码为 0 也会弹错误；现在退出码 0 且没有崩溃报告时按正常退出处理，并清理上一次的错误卡片。
- 正常退出后会显示“游戏已退出，本次运行 X 秒”，不再打开崩溃日志或生成新的诊断记录。
- 角色工坊新增「应用到游戏」：登录 Microsoft 正版账户后，可以把当前本地皮肤上传到 Mojang 档案，原版游戏内即可显示。离线账户没有可写入的皮肤档案，界面和说明会明确提示需要正版账户或本地皮肤模组。
- 皮肤页文案区分“启动器预览”和“游戏内显示”，避免把本地 PNG 误认为会自动注入游戏。
- 启动日志头部的版本号改为读取实际应用版本，不再固定显示 1.8.0。
- 补充正常退出、误匹配本机库路径和皮肤上传的回归测试。

### 1.11.3

- 修复模组页的加载器死循环：原版实例不再显示不可点击的「需加载器」，而是允许先把客户端模组下载到 `mods`，同时明确提示游戏暂时不会加载。
- 如果同一 Minecraft 版本已经安装 Forge/Fabric/NeoForge/Quilt 实例，模组页会直接列出这些实例，可一键切换为目标版本，不需要重新下载加载器。
- 模组页新增「安装加载器」入口，可直接打开加载器安装弹窗；加载器下载失败时提供官方下载页，装好后刷新版本列表即可。
- 没有加载器时安装模组只选择客户端文件，仍会排除 Paper 等服务端插件；CurseForge 文件也会按 Client/Server 标记过滤。
- 加载器版本查询增加日志，便于区分网络失败、版本列表为空和安装失败。

### 1.11.2

- 修复原版实例安装模组时选中服务端插件的问题：没有 Forge/Fabric/NeoForge/Quilt 的实例会明确提示先安装加载器，不再把 `veinminer-paper` 这类 Paper 插件写进 `mods`。
- Modrinth/CurseForge 搜索结果会标记「客户端」「双端」「仅服务端」；纯服务端项目沉底并禁用安装按钮，客户端加载器安装时只保留对应加载器的文件。
- 模组搜索结果支持点击标题或「介绍」按钮打开 Modrinth/CurseForge 项目页。
- 设置页改用响应式 CSS Grid，修复两列布局下卡片被拆开、控件错位的问题；Java 列表、路径和操作按钮在窄窗口下不再横向溢出。
- 补充模组侧别过滤、项目页 URL 和原版实例安装拦截的回归测试。

### 1.11.1

- 修复「在线下载」关闭时模组页错误显示“没有找到模组”的问题；现在会明确提示需要先开启在线下载。
- 开启在线下载后模组页会自动重新搜索，无需手动切换页面。
- 模组搜索无结果时显示目标版本、加载器、关键词和分类，并显示搜索参数，便于区分筛选问题与 Modrinth 网络问题。
- 新增「查看日志内容」：即使「打开日志目录」或系统跳转链接失败，也能在启动器内查看、复制脱敏后的 `minepilot.log`。
- 外部链接或目录无法打开时，改为弹窗显示可复制的链接/路径，不再只提示失败。
- 模组搜索日志新增 `source`、`gameVersion`、`loader`、`query`、`category` 与结果数量，便于定位返回 0 条的情况。
- 模组页对 Minecraft 1.20 + Modrinth 的空结果给出明确提示：Modrinth 的 1.20 筛选基本为空，需安装 1.20.1 并添加 Forge/Fabric/NeoForge，而不是当成网络故障。
- 安装器在覆盖安装前会结束残留的 MinePilot 进程；若目录被占用或无写入权限，会显示具体路径和处理建议，不再只报“访问被拒绝”。
- 提供 `MinePilot_1.11.1_portable.zip` 便携版，解压到用户可写目录即可运行，绕过安装目录权限问题。

### 1.11.0

- 新增「内容」页：按实例管理资源包、光影和数据包，支持启用/停用、详情预览、ZIP 导入、删除到回收站，以及从 Modrinth 搜索下载。
- 新增「联机」页：为 Terracotta / EasyTier / frp 提供官方引导和本地工具配置，一键启动/停止、查看日志、复制局域网地址；不捆绑第三方二进制，不绕过正版认证，浏览器版只提供引导。
- 账户体系升级：多离线/多 Microsoft 账户、快速切换、头像与备注、过期提示和自动刷新；桌面版使用 Electron `safeStorage` 加密令牌，并迁移旧版单账户数据。
- 插件生态升级：新增 HTTPS JSON 插件市场、安装前权限确认、SHA-256 校验、联网域名白名单，以及面板注册、读取模组/内容和下载事件 API。
- 补齐中英文界面、插件索引示例与四组回归测试（账户、内容、插件、联机），更新版本号至 1.11.0 并重新构建 Windows 安装包。

### 1.10.0

- 新增「存档」页：按实例读取 `saves/`，显示世界名、最后游玩时间、大小、文件数和游戏版本；支持 ZIP 备份、恢复、导入、导出和删除前自动备份，并在共享 `saves/` 的实例上给出影响提示。
- 新增最小 NBT 读取器解析 `level.dat`，不依赖外部库；恢复/导入会先解压到临时目录、校验 `level.dat`，确认后再合并，失败时回滚。
- 模组管理新增依赖完整性检查：缺失前置、前置被禁用、版本范围不匹配、重复 modid、客户端/服务端混装；支持按名称、加载器、客户端/服务端和问题状态筛选，并可批量启用/禁用当前筛选结果。
- 新增模组更新检查：按 JAR 的 SHA1 在 Modrinth 反查版本，再按当前游戏版本和加载器列出可用更新；没有发布到 Modrinth 的模组会跳过。
- 诊断新增已知崩溃模式库（OptiFine + Fabric、重复 modid、加载器不匹配、Java 架构、缺少 Fabric API 等）和可执行修复按钮；新增“分享脱敏摘要”，隐藏令牌、用户名、本地路径和 IP 后复制。
- Java 管理新增多版本列表（发行版、版本号、位数、路径）、按实例指定 Java、手动添加/隐藏/设为默认；自动安装新增 Azul Zulu 与 Amazon Corretto，仍强制 SHA256 校验。
- 中英文界面补齐存档、模组健康检查、诊断原因和 Java 管理的动态文案，并新增翻译回归测试，避免动态列表再次退回中文。
- 更新版本号至 1.10.0，并重新生成 Windows 安装包与独立应用。

### 1.9.0

- 设置页新增「删除启动器」：确认后强制关闭启动器，并删除程序文件、桌面/开始菜单快捷方式和卸载登记。
- 删除操作只清理启动器本身；设置、账户、缓存、皮肤以及 Minecraft 游戏目录和存档都会保留，避免误删游戏数据。
- 先让界面返回结果再退出，由随程序附带的卸载器等待启动器完全退出后删除；便携版也会跳过程序目录内的 `data` 目录，缺少卸载器的旧版则回退到后台清理脚本。
- README 新增常见问题（FAQ），并完善 GitHub Issue 模板：Bug 反馈要求附诊断报告，功能请求补充使用场景和模块分类。
- 更新版本号至 1.9.0，并重新生成 Windows 安装包与独立应用。

### 1.8.2

- 重做内存清理：在基础工作集清理之外新增管理员深度清理，通过 Windows 系统级接口整理全系统工作集、待机列表和文件缓存，明显提高单次释放量。
- 深度清理通过 UAC 请求管理员权限；用户取消时仍保留基础清理结果，不结束进程、不删除数据。
- 检测到游戏正在运行时跳过会波及游戏进程的全量系统整理，只清理其他进程和系统缓存。
- 设置页内存卡片增加深度清理说明，并更新版本号、重新生成 Windows 安装包与独立应用。

### 1.8.1

- 修复「关于」页外部链接在部分 Windows 环境下只启动后台 Edge 进程、不显示浏览器窗口的问题：优先使用系统 URL 关联，并保留 Shell、资源管理器和 `start` 回退。
- 移除界面中的「PCL 风格」定位文案，统一改为轻量的 Minecraft Java 版启动器描述；对 PCL 的独立实现与许可说明保持不变。
- 重新平衡设置页两列布局，减少中间大片留白，并把内存清理入口放到设置页顶部和第一张卡片。
- 更新版本号至 1.8.1，并重新生成 Windows 安装包与独立应用。

### 1.8.0

- 新增启动器界面语言切换：支持简体中文与 English，设置在「设置 → 语言」，切换后自动刷新界面并保存到本地配置。
- 启动游戏时自动把该实例 `options.txt` 的 `lang` 改为启动器语言（`zh_cn` / `en_us`），保留分辨率、音量、按键等其他游戏设置；写入失败只记录警告，不阻断启动。
- 完成启动器主要界面、对话框、版本列表、模组分类、提示信息和游戏状态的英文文案，模组名、版本名与游戏日志保持原文，避免误翻译用户内容。
- 更新版本号至 1.8.0，并重新生成 Windows 安装包、独立应用与 Edge 备用版。

### 1.7.0

- 新增“在线下载”开关，默认关闭；关闭时只读取本地游戏文件，安装版本、模组/整合包和 Java 自动安装会提示先开启。
- README 顶部新增版本信息、安全声明、正版提示与快速开始。
- Java 运行时下载新增 SHA256 强制校验，校验失败会删除安装包并中止。

- 新增崩溃智能诊断：自动分析退出代码、启动日志、Minecraft 日志、崩溃报告和 JVM 本机错误，识别内存不足、Java 版本不匹配、模组注入/依赖冲突、图形驱动、文件损坏、natives 缺失、端口占用和进程被强制结束等情况。
- 新增诊断页和一键 ZIP 报告：包含通俗结论、按可信度排序的原因、证据行、处理建议、退出信息、系统/Java 信息、模组清单和脱敏日志；自动隐藏 `--accessToken`、Bearer 令牌和 JWT，只保留最近 12 次记录。
- 新增启动器更新：支持 HTTPS manifest 与 GitHub Releases，版本比较、平台/架构安装包选择、更新说明、下载进度、SHA256 校验和一键安装；未配置更新源时明确显示“未配置”，不会访问默认远程地址。
- 新增插件机制：本地 ZIP 安装、启用/停用/移除，插件在 Web Worker 中运行，通过 `minepilot.registerCommand`、`toast`、`on` 和只读 `invoke` 扩展启动器；插件命令显示在「设置 → 插件」。安装前会显示信任警告。
- 新增跨平台底层支持：Mojang OS/arch 规则、Linux `.so` / macOS `.dylib` natives、Unix Java 发现与 Adoptium tar.gz 安装、macOS 默认游戏目录、`open`/`xdg-open`、Unix 进程组结束和 macOS 应用菜单。Windows 行为保持兼容。
- 修复启动命令日志中可能包含访问令牌的问题；退出诊断和插件 API 均不暴露账户令牌。
- 更新版本号至 1.7.0，并重新生成 Windows 独立应用/安装包与 Edge 备用版。

### 1.6.0

- 新增「角色工坊」：本地皮肤/披风图库，支持拖入或选择 PNG 导入、尺寸与文件头校验、经典/纤细模型切换、披风和角色实时预览、启用/停用/删除，以及本地皮肤头像同步。
- 新增外观设置：深色/浅色主题、默认渐变/纯色/本机图片背景、90%–125% 界面缩放和动画开关；背景图持久化到本地，支持 PNG/JPG/WebP/GIF 并限制 12 MB。
- 界面缩放改用 Electron 原生缩放，125% 下仍能保持完整窗口布局；补充浅色主题组件覆盖、响应式断点和减少动态效果支持。
- 新增「运行监控」：CPU、内存/分配、线程数、PID、运行时长、CPU 走势和最近 120 行日志；支持打开/复制日志与一键结束游戏进程树。
- 新增下载源选择（自动 / BMCLAPI 镜像优先 / 仅官方源）和 1–32 并发下载；自动模式官方优先、镜像兜底，BMCLAPI 模式镜像优先、官方兜底。
- 修复旧配置 `useMirror` 与新下载源字段的迁移，以及本地 API 对大尺寸皮肤/背景图片请求体的限制。
- 修复便携版首次启动时 Chromium 单实例锁目录不存在导致启动器退出的问题；启动前会创建 `chromium` 与 `crash` 目录。
- 重新生成独立应用、安装程序与 Edge 备用版。

### 1.5.0

- 新增「模组与整合包」可视化模组列表：按当前实例展示已安装模组，复选框直接启用/禁用，禁用文件改名为 `.jar.disabled`，不移动 `.jar`。
- 模组列表读取 Fabric、Quilt、NeoForge、Forge 和旧版 `mcmod.info` 元数据，显示名称、版本与所在目录；支持一键刷新和打开 mods 目录。
- 新增整合包拖拽导入：支持 Modrinth `.mrpack`、MinePilot 导出的 `.zip` 和常见 `mods/config` 目录结构 ZIP；导入前展示名称、Minecraft/加载器版本、文件数量与兼容性警告。
- `.mrpack` 导入会按清单下载文件、校验 SHA512 并解压 `overrides/`；包含 Minecraft 与加载器信息的整合包会自动安装对应加载器，并创建带 `.minepilot.json` 标记的独立实例，强制版本隔离。
- 新增当前实例导出：可导出 `.mrpack` 或 `.zip`；只打包模组与配置内容，不包含存档、日志、账户信息。
- 新增导入/导出进度条与取消导入；导入完成后自动刷新版本列表并切换到新实例。
- 重新生成独立应用、安装程序与 Edge 备用版。

### 1.4.0

- 新增启动前文件完整性校验：自动检查客户端主文件、核心库、natives、日志配置、资源索引与资源对象，缺失或损坏时在启动前自动补全。
- 校验使用 SHA1 + 本地缓存；未变化的文件第二次启动不再重复计算哈希，兼顾安全与启动速度。
- 加载器版本会校验继承的原版 client.jar，修复加载器版本缺少主文件时无法启动的问题。
- 新增模组依赖检查弹窗：安装前展示主模组、必需前置、依赖层级、已存在状态和缺失提示，确认后一键安装全部必需文件。
- 依赖树同时支持 Modrinth 与 CurseForge；解析失败时会明确提示，而不是静默跳过。
- 重新生成独立应用、安装程序与 Edge 备用版。

### 1.3.0

- 新增 Forge / NeoForge / Quilt 一键安装，与原有 Fabric 一起覆盖四个主流加载器。
- 加载器弹窗会自动识别当前 Minecraft 版本可用的版本，并默认选中推荐/稳定版；已安装的加载器会显示版本号。
- Fabric、Quilt 直接写入版本配置并补全库文件；Forge、NeoForge 自动下载官方安装器、调用 Java 安装并识别生成的版本，无需手动下载或放置文件。
- 安装器下载后会校验 JAR 文件头，避免把错误页面当成安装器；Forge/NeoForge 安装失败时会附上日志路径。
- 修复 NeoForge 1.20.1 的 `net.neoforged:forge` 坐标被误识别为普通 Forge 的问题。
- 重新生成独立应用与安装程序 `MinePilot_Setup_1.3.0.exe`，并同步 Edge 备用版。

### 1.2.1

- 重新生成独立应用安装程序 `MinePilot_Setup_1.2.1.exe`。
- 修复独立应用里「打开链接 / 打开数据目录 / 打开日志目录」仍然没有反应的问题。
- 打开目录改为优先显式启动 `explorer.exe`，不再只依赖会“返回成功但没打开窗口”的系统关联。
- 打开链接改为优先显式启动 Edge 新窗口，失败后再回退系统默认浏览器；失败会在右下角显示具体原因和路径。
- 渲染进程为打开操作增加 8 秒超时，IPC 卡住时也会弹出错误提示。
- 以上流程同时同步到 Edge 备用版。

### 1.2.0

- 发布真正的独立应用版：桌面和开始菜单快捷方式直接指向 `MinePilot.exe`，使用 Electron 原生窗口，不再经过 `wscript.exe`、`MinePilot.vbs` 或 Microsoft Edge。
- 新增独立应用安装程序 `MinePilot_Setup_1.2.0.exe`，默认安装到 `%LOCALAPPDATA%\Programs\MinePilot`，无需管理员权限。
- 独立应用优先使用程序目录旁的 `data`；如果安装包旁边存在旧便携版 `MinePilotWeb\data`，安装时会建立目录链接继续使用原账户、设置和游戏数据。
- 桌面快捷方式带 `--no-sandbox` 兼容参数，避免部分 Windows 安全策略下 Chromium 沙箱导致窗口无法启动。
- Edge 应用窗口版继续保留为备用方案，不再作为默认启动方式。

### 1.1.1

- 修复「打开数据目录 / 日志目录 / PCL 链接」点击后没有反应、也不显示错误的问题。
- 打开目录改为依次尝试程序内置的 `MinePilot.exe --open`（ShellExecuteW）、`explorer.exe` 和 `cmd start`；链接优先交给系统默认浏览器，必要时回退到 Edge。
- 启动 Explorer/浏览器时不再使用隐藏窗口标志，避免窗口被系统隐藏。
- 三种方式都失败时，界面右下角会显示具体失败原因，不再静默失败。

## 跨平台说明（Windows / macOS / Linux）

平台差异已经集中到 `src/core/platform.js`：Mojang 的 `rules.os.name` / `arch`、旧版 natives classifier、Linux `.so` 与 macOS `.dylib` 解压、默认游戏目录、Java 可执行文件查找、Adoptium 的 tar.gz/zip 选择、`open` / `xdg-open` 和 Unix 进程组结束都在这里处理。

当前发布物和构建脚本仍是 **Windows**：

- `runtime/electron/` 是由 `tools/download-electron.js` 下载的 Windows x64 运行时（不提交到源码仓库），`tools/package-win.js`、`tools/package-desktop-installer.js`、`tools/package-web.js`、`tools/package-installer.js` 都只面向 Windows；
- 本仓库没有内置 macOS `.app` 或 Linux AppImage/deb 的构建产物；
- 本环境只能在 Windows 上实际运行和截图验证。macOS/Linux 的代码路径已经实现，但没有在真实 macOS/Linux 机器上完成端到端启动测试，不能声称“已在三个系统验证”。

如果要自行构建 macOS/Linux 版，需要在该系统准备 Node.js、npm 和 Electron 33，然后使用 Electron 打包工具（例如 `@electron/packager` 或 `electron-builder`）把仓库作为应用目录打包；macOS 还需要按自己的签名/公证流程处理。macOS 的 `.app` 内部不适合写便携数据，`main.js` 会自动改用 `~/Library/Application Support/MinePilot`；Windows/Linux 仍优先使用程序目录旁的 `data/`。Linux 运行 Adoptium 自动安装时需要系统提供 `tar`；macOS 默认游戏目录为 `~/Library/Application Support/minecraft`，Linux 为 `~/.minecraft`。

## 崩溃诊断报告

游戏异常退出后，主进程会自动分析并在「诊断」页展示结论；也可以从右上角导出 ZIP。报告包含：

- `REPORT.md`：通俗结论、退出代码/信号、按可信度排序的原因、证据和分步建议；
- `report.json`：原始诊断数据；
- `system.json`：操作系统、CPU/内存、Java、启动器版本和脱敏后的设置；
- `logs/`：启动日志、`latest.log`、`debug.log`，以及本次运行产生的崩溃报告；
- `mods/list.txt`：已安装模组文件名。

导出前会隐藏 `--accessToken`、`--clientId`、Bearer 令牌、JWT 和常见 token JSON 字段。仍请只把报告发送给你信任的人；报告可能包含本地路径、用户名和模组列表。诊断记录默认只保留最近 12 次，存放在数据目录的 `diagnostics/` 下。

## 启动器更新源

更新源默认留空。留空时启动器不会连接任何更新服务器。可以在「设置 → 启动器更新」填写 HTTPS 地址，或设置环境变量 `MINEPILOT_UPDATE_URL`；也支持直接粘贴 GitHub 仓库地址，启动器会转换为 GitHub Releases API。

manifest 示例：

```json
{
  "version": "1.11.6",
  "notes": "修复……\n新增……",
  "publishedAt": "2026-10-31T12:00:00Z",
  "assets": [
    {
      "name": "MinePilot_Setup_1.11.6.exe",
      "url": "https://example.com/downloads/MinePilot_Setup_1.11.6.exe",
      "platform": "windows",
      "arch": "x64",
      "sha256": "安装包的 SHA256",
      "size": 123456789
    }
  ]
}
```

`platform` 可使用 `windows` / `darwin` / `linux`，`arch` 使用 `x64` / `arm64` / `ia32`。GitHub Releases 会自动读取 `tag_name`、`body`、`assets` 和可用的 `digest`。下载地址必须是 HTTPS（本地调试可用 `127.0.0.1` / `localhost`）；提供 `sha256` 时会强制校验，不匹配会删除文件。启动器不会自动下载或安装更新，必须由用户点击。

## 插件

插件是本地 ZIP，解压后目录结构如下：

```text
my-plugin/
  plugin.json
  main.js
```

`plugin.json`：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "author": "你的名字",
  "description": "插件说明",
  "apiVersion": 1,
  "main": "main.js",
  "permissions": {
    "network": ["api.example.com", "*.github.com"]
  }
}
```

`id` 必须与安装后的文件夹名一致，只能使用小写字母、数字、点、下划线和短横线。`permissions.network` 是联网域名白名单，支持精确域名和 `*.example.com` 通配；省略或留空表示**禁止联网**，`["*"]` 表示任意域名（安装时会高亮为高风险）。插件在安装前会展示这些权限，并对 ZIP 做 SHA-256 校验。

`main.js` 在 Web Worker 中运行，不能直接访问页面 DOM、`localStorage`、启动器文件系统或账户令牌；可以通过受限 API 扩展：

```js
minepilot.registerPanel('status', '插件状态', '这里只显示纯文本，不能注入 HTML。');

minepilot.registerCommand('hello', '打个招呼', () => {
  minepilot.toast('你好，MinePilot！');
  return '完成';
});

minepilot.getMods('<targetVersionId>').then((result) => {
  minepilot.toast(`已安装 ${result.mods.length} 个模组`);
});

minepilot.on('download:completed', (event) => {
  if (event.ok) minepilot.toast(`下载完成：${event.kind}`);
});
```

可用 API：`toast(text, tone)`、`registerCommand(id, title, handler)`、`registerPanel(id, title, text)`、`getMods(targetVersionId)`、`getContent(targetVersionId, type)`、`on(event, handler)`（`settings:changed`、`launch:exit`、`crash:detected`、`download:started`、`download:progress`、`download:completed`）和只读 `invoke(channel, args)`（`app:info`、`settings:get`、`versions:list`、`monitor:state`、`diagnostics:latest`、`java:detect`、`mods:list`、`content:list`）。插件命令会出现在「设置 → 插件」；面板显示为纯文本。

### 插件市场索引

「设置 → 插件 → 插件市场」默认读取 [`docs/plugin-index.json`](docs/plugin-index.json)，也可以填写任意 HTTPS JSON 地址。格式：

```json
{
  "updatedAt": "2026-10-31T00:00:00Z",
  "plugins": [
    {
      "id": "my-plugin",
      "name": "我的插件",
      "version": "1.0.0",
      "description": "插件说明",
      "author": "你的名字",
      "homepage": "https://example.com/my-plugin",
      "download": "https://example.com/my-plugin.zip",
      "sha256": "64 位十六进制 SHA-256",
      "permissions": { "network": ["api.example.com"] }
    }
  ]
}
```

`download` 必须是 HTTPS；`sha256` 必填，安装前会校验，缺失或校验失败会拒绝安装。索引只读取 `plugins` 数组，单次最多 200 条；无效条目会被跳过并在界面提示。下载后还会核对插件包内 `plugin.json` 的 `id` 与 `permissions.network`，与索引不一致时拒绝安装，避免“展示 A、实际 B”。默认索引中的示例插件源码在 `docs/plugins/`，可以解压后自行审计。

## 直接运行

源码仓库不包含体积较大的 Electron 运行时（`runtime/` 已在 `.gitignore` 中排除）。首次从源码运行需要 Node.js 22+，并执行一次：

```powershell
node tools\download-electron.js
```

脚本会下载 Electron 33.2.0（x64）到 `runtime/electron/`。完成后可以：

1. 双击根目录的 **`MinePilot.cmd`**；
2. 或在此目录执行：

   ```powershell
   .\runtime\electron\electron.exe .
   ```

首次启动会显示欢迎页。请先到「设置 → 下载」开启“在线下载”，再到「下载」页安装一个正式版（例如 1.20.1）。如果本机没有 Java，可在「设置 → Java 管理」中选择已有 Java，或开启在线下载后自动安装。

> 如果从受限的终端/沙箱环境启动，Chromium 可能无法创建子进程。请在普通 Windows 桌面环境中运行。

## 测试

```powershell
npm test
```

测试覆盖启动器语言持久化、非法值回退、游戏 `options.txt` 的语言写入（保留其他设置、CRLF 和新建文件场景）、静态与动态中英文文案，以及自动内存推荐、32 位 Java 上限、G1GC 参数、内存设置持久化和内存清理脚本。`tests/mods.test.js` 覆盖模组依赖树、推荐前置和整合包下载地址白名单；`tests/accounts.test.js`、`tests/content.test.js`、`tests/plugins.test.js` 和 `tests/netplay.test.js` 还覆盖多账户加密/迁移、资源包/光影/数据包启停、插件权限与市场 SHA-256、联机参数校验。GitHub Actions 会在每次 push / pull request 时执行语法检查与测试。

## 发布构建

Windows 构建/发布工作流位于 [`.github/workflows/release.yml`](.github/workflows/release.yml)：

- 推送 `v*` 标签时自动构建两个安装包、生成 `.sha256` 并创建/更新 GitHub Release；
- 也可以在 Actions 页面手动触发，填写版本号并选择是否发布 Release；
- 工作流会下载固定版本 Electron 33.2.0，执行 `package-win.js`、`package-desktop-installer.js`、`package-web.js` 和 `package-installer.js`；
- 上传未签名安装包和校验文件作为 workflow artifacts；
- 便携版不在 Actions 产物里：工作流只产出两个安装包，`MinePilot_<版本>_portable.zip` 需要本地执行 `node tools/package-win.js` 后把 `dist/MinePilot` 打包成 ZIP（排除 `data`），再手动上传到 Release；
- SignPath 签名步骤已预留，但在申请通过前保持禁用。

首次手动构建已通过（[run 41101445713](https://github.com/nxndai/MinePilot/actions/runs/41101445713)），产物包含两个安装包、两个 `.sha256` 和 Release 说明。安全问题和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 独立应用版（默认）

打包后的 `dist/MinePilot/MinePilot.exe` 是独立应用主程序：
- 原生 Electron 窗口和任务栏图标，不再打开 Edge；
- 桌面快捷方式目标为 `MinePilot.exe`，参数为 `--no-sandbox`；
- 程序目录旁的 `data\` 用于保存配置、账户、日志和便携游戏数据。

重新构建：

```powershell
node tools\package-win.js
node tools\package-desktop-installer.js
```

桌面快捷方式如果仍指向 `wscript.exe`，说明运行的是旧版快捷方式；重新运行安装程序，或把快捷方式目标改为 `dist\MinePilot\MinePilot.exe`。

如果双击 `MinePilot.exe` 没有任何窗口，请改用桌面快捷方式（已带 `--no-sandbox`），或手动运行：

```powershell
.\dist\MinePilot\MinePilot.exe --no-sandbox
```

## Edge 应用窗口版（备用）

部分电脑的安全软件会拦截未签名的 Electron/Chromium，导致 `MinePilot.exe` 双击后没有任何窗口。如果遇到这种情况，请使用：

`dist/MinePilotWeb/MinePilot.exe`

它由原生引导程序启动本地 Node 服务，再用 Microsoft Edge 的应用窗口加载同一套界面，不依赖 Electron。为了避开部分电脑对 `%APPDATA%` 新目录的写入拦截，Edge 版的启动器数据放在程序目录下的 `data\`，游戏目录仍使用 `%APPDATA%\.minecraft`。可以用 `node tools\package-web.js` 重新构建。

桌面快捷方式实际调用同目录的 `MinePilot.vbs`，由系统自带的 `wscript.exe` 启动本地服务，这样可以避开“未签名 exe 被安全软件直接拦截”的问题。

如果安全软件连这个引导程序也拦截，可以双击同目录的 `启动_MinePilot.cmd`。这个脚本只调用系统自带的 Node 运行时和 Edge。

## 安装包（Windows）

独立应用版安装程序：

```powershell
node tools\package-desktop-installer.js
```

输出为 `dist/installer/MinePilot_Setup_<版本号>.exe`，当前版本是 `MinePilot_Setup_1.11.6.exe`。GitHub Release 中的 Windows 安装包由 GitHub Actions 从公开源码重新构建，实际 SHA256 以 Release 说明和同名 `.sha256` 文件为准。安装程序是一个小型 C# 引导器 + 追加 ZIP 的自解压包（规避 NSIS 32 位编译器对超大 Electron 文件的 mmap 限制），约 110 MB：

1. 默认安装到 `%LOCALAPPDATA%\Programs\MinePilot`，**不需要管理员权限**；
2. 创建桌面和开始菜单快捷方式，快捷方式直接启动 `MinePilot.exe --no-sandbox`，并注册卸载项；
3. 不会把 `data\`、账户信息或游戏数据打进安装包；
4. 升级安装时保留目标目录已有的 `data\`；不会把旧便携版数据打进安装包；
5. 卸载时保留 `data\`，不会删除账户和设置。

Edge 备用版安装包仍可用 `node tools\package-installer.js` 构建，输出为 `dist/installer/MinePilot_Edge_Setup_<版本号>.exe`（本次为 `MinePilot_Edge_Setup_1.11.6.exe`），不会覆盖独立应用安装包。

两个安装包共用 `tools/installer/sfx/Installer.cs` 编译的小型 C# 安装器：安装数据用 Windows 自带 `tar.exe` 打成 ZIP 后追加在 exe 末尾，安装/卸载时再解压或清理。它们都没有代码签名，首次运行时 Windows SmartScreen 可能提示“未知发布者”，选择“更多信息 → 仍要运行”即可。

## 应用图标

应用图标是独立绘制的“草方块 + 蓝色启动面”，不包含 PCL 或 Mojang 的素材。图标源文件由 `tools/make-icon.py` 生成：

- `assets/icon.png`：1024×1024 主图标，用于 Electron 窗口和“关于”页；
- `assets/MinePilot.ico`：16 / 24 / 32 / 48 / 64 / 128 / 256 多尺寸 Windows 图标；
- `assets/favicon.png`：Edge 应用窗口的网页图标。

重新生成：

```powershell
python tools\make-icon.py
```

构建 Edge 版时，`tools/package-web.js` 会把 `assets/MinePilot.ico` 复制到发布目录，并通过 `csc /win32icon` 嵌入 `MinePilot.exe`；安装程序也会用它作为安装包图标和快捷方式图标。

## 打包为独立程序

```powershell
node tools\package-win.js
```

输出目录为 `dist/MinePilot/`，双击其中的 `MinePilot.exe` 即可运行。脚本会：

1. 复制 `runtime/electron/` 到 `dist/MinePilot/`；
2. 把 `electron.exe` 重命名为 `MinePilot.exe`；
3. 把启动器源码复制到 `resources/app/`，并复制 `MinePilot.ico`；
4. 如果存在 `dist/MinePilotWeb/data`，创建 `dist/MinePilot/data` 目录链接，升级时继续使用原数据。

再运行 `node tools\package-desktop-installer.js` 生成独立应用安装包。Edge 版安装包使用 `node tools\package-installer.js`，两者不要混用。

## 数据与目录

| 内容 | 默认位置 |
| --- | --- |
| 启动器配置、日志、自动安装的 Java（独立应用便携版） | 程序目录下的 `data\` |
| 启动器配置、日志、自动安装的 Java（独立应用安装版） | `%APPDATA%\MinePilot\`；若安装时检测到旧便携 data，则使用安装目录下的 `data\` |
| 启动器配置、日志、自动安装的 Java（Edge 备用版） | 程序目录下的 `data\` |
| Microsoft 账户令牌（`accounts.json`） | 启动器数据目录；桌面版用系统安全存储加密，安全存储不可用时退回明文并提示 |
| CurseForge API Key（`config.json`） | 启动器数据目录，本地明文保存，请勿分享 |
| 本地皮肤/披风图库 | 启动器数据目录下的 `skins\`；索引为 `index.json`，图片为 PNG |
| 自定义背景图 | 启动器数据目录下的 `theme\` |
| 游戏目录 | `%APPDATA%\.minecraft\` |
| 版本 | `<游戏目录>\versions\<版本号>\` |
| 版本隔离后的数据 | `<游戏目录>\versions\<版本号>\`（mods、saves、options.txt 等） |
| 依赖库 | `<游戏目录>\libraries\` |
| 资源文件 | `<游戏目录>\assets\` |

设置环境变量 `MINEPILOT_HOME` 可以把启动器数据目录改到任意位置（便携模式）：

```powershell
$env:MINEPILOT_HOME = "D:\MinePilotData"
.\runtime\electron\electron.exe .
```

> `MINEPILOT_HOME` 只改变启动器自己的数据目录（配置、账户、日志、缓存、自动安装的 Java）；游戏目录仍由「设置 → 游戏目录」决定，默认是 `%APPDATA%\.minecraft`。要完全隔离测试环境，两处都要改。

Microsoft 登录默认使用公开的 OAuth 客户端 ID。如果你有自己的 Azure 应用注册，建议覆盖它（应用需支持「移动和桌面应用程序」公共客户端，并允许 `XboxLive.SignIn XboxLive.offline_access`）：

```powershell
$env:MINEPILOT_MS_CLIENT_ID = "你的 Azure 应用客户端 ID"
```

登录令牌保存在数据目录的 `accounts.json` 中，仅用于本机启动游戏；退出 Microsoft 账户会删除该文件中的令牌。请像保护密码一样保护这个文件。

## 目录结构

```
main.js                  Electron 主进程 / IPC
preload.js               contextBridge 安全桥
src/core/
  config.js              路径与数据目录
  settings.js            设置读写与校验
  logger.js              文件日志
  net.js                 下载、SHA1 校验、并发与重试
  auth.js                离线 UUID 与档案
  accounts.js            Microsoft 账户持久化与启动档案
  microsoft.js           Microsoft OAuth 设备代码、Xbox / Minecraft 认证
  loaders.js             Fabric / Forge / NeoForge / Quilt 元数据
  zip.js                 轻量 ZIP 解压与打包
  java.js                Java 发现、版本探测、自动安装
  mojang.js              版本清单、继承合并、参数规则、镜像
  installer.js           原版 / 四种加载器安装
  skinmanager.js         本地皮肤 / 披风图库与激活状态
  appearance.js          自定义背景图持久化
  procstats.js           Windows / Unix 进程 CPU / 内存采样
  platform.js            Windows / macOS / Linux 平台差异
  diagnostics.js         崩溃分析、脱敏与诊断报告导出
  updater.js             启动器更新检查、下载与校验
  plugins.js             本地插件安装与开关
  monitor.js             运行监控日志缓冲、状态与结束进程
  launcher.js            启动游戏（含版本隔离）
  versions.js            本地版本扫描
  mods.js                Modrinth 模组 / 整合包搜索、依赖解析与安装
  modmanager.js          已安装模组列表与启用/禁用
  modpack.js             .mrpack / ZIP 整合包下载、导入导出
  curseforge.js          CurseForge 模组搜索、依赖解析与安装
renderer/                HTML / CSS / 原生 JS 界面
  js/diagnostics.js      诊断页
  js/updater.js          更新界面
  js/plugins.js          插件 Worker 宿主与插件管理
tools/                   下载 Electron、打包桌面版 / Edge 版 / 安装程序、生成图标
runtime/electron/        内置 Electron 运行时
```

## 已知限制

- Microsoft 登录需要联网并打开浏览器输入一次性代码；如果公开客户端 ID 被微软调整，可通过 `MINEPILOT_MS_CLIENT_ID` 换用自己注册的 Azure 应用。
- Forge / NeoForge 安装器需要本机已有符合要求的 Java；启动器不会在安装前自动下载 Java，请先在「设置 → Java 管理」中安装（自动安装需要先开启“在线下载”）。
- OptiFine / LiteLoader 目前只做识别，不提供自动安装；可识别已由其他安装器装好的继承式版本。
- 本地皮肤/披风默认只在启动器内预览、管理和生成本地头像，不会自动注入离线游戏。登录 Microsoft 正版账户后可以在角色工坊主动上传皮肤到 Mojang 档案；离线账户不会写回 Mojang，原版游戏内固定显示 Steve/Alex，需要支持本地皮肤的模组。
- 自动更新需要自行配置 HTTPS 更新源；未配置时不会连接任何更新服务器。整合包导入已支持 `.mrpack` 和常见 ZIP；**在线搜索并下载整合包只支持 Modrinth**，CurseForge 整合包没有文件直链，只能用本地 `.zip` 导入。
- CurseForge 官方 API 需要你自行申请 API Key；没有 Key 时只能使用 Modrinth。API Key 仅保存在本机 `config.json`，请勿分享给别人。
- 导入带下载清单的 `.mrpack` 需要能访问清单里的下载地址；网络不可用或下载地址失效时，导入会中止并保留已完成文件。
- “在线下载”默认关闭；首次安装版本、下载模组/整合包或自动安装 Java 前，需要到「设置 → 下载」手动开启。
- 启动器不会绕过正版验证；启动游戏时只会按设置写入语言（`options.txt` 的 `lang`）、模组、配置等必要数据。
- 离线账户启动时，游戏仍会尝试查询正版账户属性并得到 HTTP 401。启动器会把这段堆栈压缩成一行提示，不影响单人游戏；原始日志仍保存在日志文件中。
- 首次启动会自动检测 Java；如果本机没有合适的 Java，会提示从 Eclipse Adoptium 下载 Temurin JRE（Windows 优先使用清华镜像，macOS/Linux 使用官方 tar.gz），也可以改选 Azul Zulu 或 Amazon Corretto。自动安装 Java 同样要求先开启“在线下载”，并强制校验 SHA256。
- 崩溃诊断是基于日志关键词和退出代码的启发式分析，不能保证 100% 找到根因；导出报告中的日志已脱敏，但仍可能包含本地路径、用户名和模组列表。
- 插件在 Web Worker 中运行，不能直接操作页面或读取账户令牌，但仍可自行联网。请只安装可信来源的插件；插件作者和插件行为由你自行判断。
- macOS / Linux 的平台代码已经实现，但当前仓库只提供 Windows 安装包构建脚本，且本次发布没有在真实 macOS/Linux 机器上完成端到端验证。需要在这些系统上自行安装 Node/Electron 并打包。

## 关于 PCL 的许可

PCL 的源码发布在 <https://github.com/Meloong-Git/PCL>，采用作者自定的《PCL 分发有限许可》与《PCL 存储库合理使用指南》，**不是** MIT / GPL 之类的开源许可证。该许可对「大量使用」有额外要求，包括但不限于：

- 必须明确标注第三方修改，且名称需以 `Plain Craft Launcher (PCL)` 开头并加后缀；
- 关于页面首屏需署名原作者龙腾猫跃并提供赞助入口；
- 需公开修改后的源码、保留许可文件；
- Windows 端 UI 主色调须为蓝色；
- 不得加入「赞助解锁」类功能。

因此本项目**没有**复制 PCL 代码，而是按 PCL 的使用习惯重新实现。界面中保留了对 PCL 的署名与链接；如果你要基于 PCL 源码二次开发，请先阅读其仓库中的 `LICENCE` 并遵守对应条款。

## 正版声明

Minecraft 是 Mojang Studios 的商标。本项目与 Mojang、Microsoft、PCL 作者均无隶属关系。本启动器仅作为本地游戏管理器，内置的下载功能仅用于拉取用户已合法拥有的游戏文件，请确保您已购买正版 Minecraft。请购买正版 Minecraft：<https://www.minecraft.net/zh-hans/store/minecraft-java-bedrock-edition-pc>。

## License

本项目自身代码以 MIT 许可证发布，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。Minecraft 游戏文件、Mojang 资源与 PCL 相关素材不在本项目的许可范围内。

