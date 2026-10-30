# Contributing to MinePilot

Thanks for helping improve MinePilot. This is an independent MIT-licensed
project; do not copy PCL source code or assets into the repository.

## Development setup

Requirements: Windows 10/11 x64 and Node.js 22 or newer.

```powershell
node tools\download-electron.js
npm test
.\runtime\electron\electron.exe .
```

The `runtime/` directory is generated and is not committed. See the README for
packaging and installer instructions.

## Before opening a pull request

- Keep changes focused and explain the user-facing effect.
- Run `npm test`.
- Run `node --check` on the files you changed.
- Test the affected page in both Chinese and English when changing UI text.
- Do not commit `dist/`, `runtime/`, `.test-data/`, account tokens, logs with
  personal data, or signing credentials.
- Do not change the license or add third-party code without documenting its
  license in `NOTICE`.

## Commit messages

Use a short imperative subject, for example:

```text
settings: keep game language in sync on launch
```

## Security reports

Do not open a public issue for security problems. Follow
[SECURITY.md](SECURITY.md) and email `asdf45612378900@163.com`.