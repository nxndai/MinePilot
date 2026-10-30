# SignPath Foundation 申请材料

> 状态：申请尚未提交。公开仓库已建立（https://github.com/nxndai/MinePilot），并已加入 GitHub Actions 测试；正式构建 workflow、公开 Release 和签名流程仍待补齐。
> 本文是可直接粘贴到申请表的英文草稿，以及提交前检查清单。

## 先说明两件事

1. **SignPath Foundation 不发可下载的 PFX 证书。** 通过审核后，签名在 SignPath 的 HSM 中完成，由 CI 提交待签文件并取回已签名产物；私钥不会导出。
2. **申请中的法律声明、身份信息和条款必须由你本人确认。** 我可以整理材料、生成 CI 配置和核对产物，但不能代替你接受条款或提交实名信息。

## 提交前必须补齐

- [x] 公开仓库地址（GitHub 或 Gitee），能匿名访问源码
- [x] 仓库根目录包含 `LICENSE`（MIT）和完整 README
- [ ] 至少一条 CI 构建记录（GitHub Actions / GitLab CI 等；当前 workflow 只做语法检查与测试，构建 workflow 待补）
- [ ] 至少一个公开 Release，包含安装包和 `.sha256`
- [ ] 项目网站或 Release 页面地址
- [ ] 有效的联系邮箱
- [ ] 确认项目不含商业授权代码、PCL 代码或素材
- [ ] 由你本人阅读并同意 SignPath Foundation 条款

## 可直接粘贴的英文申请内容

以下 `<...>` 需要替换成真实信息。

### Organization

```text
MinePilot Contributors
```

### Project name

```text
MinePilot
```

### Repository URL

```text
https://github.com/nxndai/MinePilot
```

### Project website / release page

```text
https://github.com/nxndai/MinePilot/releases
```

### License

```text
MIT
```

### Short description

```text
MinePilot is an independent, MIT-licensed Minecraft Java Edition launcher for
Windows, built with Electron. It manages local game versions and Java runtimes,
installs Fabric/Forge/NeoForge/Quilt loaders, manages mods and modpacks, supports
Microsoft and offline accounts, verifies local game files, and provides crash
diagnostics. It does not bypass Mojang authentication. Online downloads are
opt-in and are limited to files the user is entitled to. The project contains no
source code or assets copied from Plain Craft Launcher (PCL).
```

### Why does the project need code signing?

```text
MinePilot is distributed as a Windows installer and a portable executable.
Unsigned builds trigger SmartScreen "Unknown publisher" warnings, which is a
major trust barrier for a community launcher and makes tampered third-party
copies harder to distinguish from official releases. Signing the release
binaries would let users verify the publisher and the release pipeline, and
would reduce false-positive malware warnings.
```

### Build process

```text
Windows build (same scripts locally and in CI):
- checkout the public repository
- install Node.js 22
- run node tools/download-electron.js to fetch pinned Electron 33.2.0 Windows x64
- run node tools/package-win.js
- run node tools/package-desktop-installer.js
- run node tools/package-installer.js
- publish SHA256 checksums and the Windows artifacts

The current GitHub Actions workflow (CI) runs syntax checks and tests on every
push. A separate release workflow will run the packaging steps above and submit
the unsigned binaries to SignPath before publishing.
```

### Signing scope

```text
MinePilot.exe                  (Electron application executable)
MinePilot_Setup_1.8.0.exe      (Windows installer)
MinePilot_Edge_Setup_1.8.0.exe (Edge fallback installer)
```

### Release process

```text
Releases are built from a tagged commit in GitHub Actions. Each release includes
the installer, the portable application, and SHA256 checksum files. Release
notes identify the exact version and known limitations.
```

### Current code signing

```text
No. The current Windows builds are unsigned.
```

### Security contact

```text
<security@example.com>
```

## 申请时可能被追问的点

- **公开仓库必须能匿名访问。** 如果仓库仍是私有，先公开或提供只读镜像。
- **构建必须能在 CI 复现。** 不能只上传 `dist/`；必须能从源码运行打包脚本。
- **项目不能是商业产品或付费服务。** 如果以后加入付费功能，需要重新确认资格。
- **安装包和主程序都要签。** 只签安装器、不签 `MinePilot.exe`，SmartScreen 仍可能拦截。
- **签名后不要改动 EXE。** 任何重新打包都会破坏签名；正确顺序是先完成打包，再提交 SignPath 签名，最后计算 SHA256 并发布。
- **第三方运行时。** Electron 使用其自身许可证，仓库应保留 `NOTICE` 和 Electron 许可说明。

## 通过后需要接入的流程

1. 在 SignPath 创建 organization / project / signing policy / artifact configuration。
2. 在 GitHub 仓库 Secrets 中保存 SignPath API token，不要提交到仓库。
3. 在 CI 中先构建未签名产物，再调用 SignPath 签名，最后下载已签名产物。
4. 对签名后的文件重新计算 SHA256，更新 Release 的 `.sha256`。
5. 用 `signtool verify /pa /v` 验证签名，并在一台干净的 Windows 机器上检查 SmartScreen。

## 下一步

公开仓库和测试 CI 已就绪。后续需要：

- 增加 Windows 构建/发布 workflow；
- 创建第一个包含安装包和 `.sha256` 的公开 Release；
- 把本文件中的占位联系邮箱替换成真实邮箱；
- 由你本人提交申请并接受 SignPath Foundation 条款；
- 审核通过后，在 CI 中接入 SignPath 签名并重新计算签名后产物的 SHA256。