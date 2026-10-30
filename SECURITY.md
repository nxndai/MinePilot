# Security Policy / 安全政策

## Supported versions / 支持版本

| Version | Supported |
| --- | --- |
| 1.8.x | Yes |
| < 1.8.0 | No |

## Reporting a vulnerability / 报告安全问题

Please **do not open a public issue** for security problems.

请**不要**通过公开 Issue 报告安全问题。

Send an email to:

```text
asdf45612378900@163.com
```

Use the subject prefix `[MinePilot Security]` and include:

- MinePilot version and Windows version;
- installation type (installer, portable, Edge fallback, or source);
- steps to reproduce;
- impact and any proof of concept;
- relevant logs with access tokens, refresh tokens and personal paths removed.

请不要发送 Microsoft 账户密码、访问令牌、刷新令牌或私钥。日志中如包含这些内容，请先删除。

## Scope / 范围

In scope:

- Microsoft/offline account handling and token storage;
- plugin isolation and IPC boundaries;
- path traversal, arbitrary file write/delete, command injection;
- download integrity checks and update-source handling;
- privilege escalation or code execution through launcher-controlled files.

Out of scope:

- Windows SmartScreen warnings caused by unsigned builds;
- issues in upstream PCL, Electron, Java, mods or modpacks;
- problems that require a modified launcher binary;
- social engineering and third-party download sites.

## Response / 处理

This is a volunteer project. I will try to acknowledge a report within 7 days and
will coordinate a fix and disclosure timeline with the reporter. Please do not
publish details before a fix or mitigation is available.

## Release verification / 发布校验

Every release includes SHA256 checksum files. Download only from:

https://github.com/nxndai/MinePilot/releases

The current builds are not code-signed, so SmartScreen may show an unknown
publisher warning. Verify the SHA256 value before running an installer.