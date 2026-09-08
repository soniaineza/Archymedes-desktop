# Archymedes Desktop

A coding agent that lives on your desktop. An Electron client for the
[Archymedes](https://github.com/chrisnkuno/archymedes-cli) agent — chat with a
model that reads, edits, and runs commands in your workspace, with every edit
snapshotted, diffable, and revertible.

![status](https://img.shields.io/badge/license-Apache--2.0-blue)

## Features

- **Agent chat** — streaming responses, tool calls rendered TUI-style, message
  queueing while the agent works, `@file` mentions for context
- **Sessions** — every conversation autosaves; resume, rename, delete past chats
- **Diff & revert** — agent edits snapshot the file first: view a real unified
  diff (`±` on any tool card, or the *agent edits* box in the sidebar) and
  revert with one click
- **Editor** — syntax highlighting, line numbers, Tab/auto-indent, `Ctrl+/`
  comments, line duplication
- **Multi-terminal** — real PTY shells in tabs, `Ctrl+`` ` `` to focus
- **Workspace tools** — Quick Open (`Ctrl+P`), command palette
  (`Ctrl+Shift+P`), full-text search (`Ctrl+Shift+F`), live file watching
- **Costs** — live spend in your currency, priced from the CLI's dated
  per-model catalog with cached-token discounts; unpriced models say so
- **9 providers** — Anthropic, OpenAI, Gemini, Grok, DeepSeek, Mistral, Groq,
  Ollama (local), any OpenAI-compatible endpoint
- **5 themes** — monochrome dark/light, Solarized dark/light, high contrast

## Quick start

```bash
npm install
npm run dev
```

1. **Open Workspace…** — pick any folder on your machine
2. **Settings** → choose a provider, paste your API key (stored locally)
3. **Ask** — e.g. *“explain this project”*, *“fix the failing test in @src”*

## Package a release

```bash
npm run package:win     # Windows NSIS installer
npm run package:dir     # unpacked build
```

## Architecture

```
src/
├── main/            Electron main process
│   ├── core/        Engine ported from @archymedes/core (the CLI's core):
│   │                money/pricing (micros cost accounting, dated catalog),
│   │                model-capabilities, workspace boundary (symlink-safe
│   │                confinement, edit_file, glob, grep), bounded command
│   │                executor, 9-provider registry
│   ├── agent/       Adapter seam + Anthropic / OpenAI-compatible adapters,
│   │                provider-neutral tool loop
│   └── …            IPC, sessions, diffs, watcher, git, pty terminals
├── preload/         contextBridge — the only renderer↔main boundary
└── renderer/        React UI (no orange, monochrome by default)
```

Security model: the renderer is sandboxed and can only act through the typed
preload API; every agent file operation resolves inside the workspace root
(symlinks included); spawned commands never see the app's credentials.

## Shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+P` | Quick open file |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+F` | Search in files |
| `Ctrl+B` / `Ctrl+J` | Toggle sidebar / terminal |
| `Ctrl+S` | Save file |
| `Ctrl+/` | Toggle comment |
| `/help` | In-chat command list |

## License

Apache-2.0, matching the CLI. Archymedes Desktop is an independent client and
is not affiliated with the Archymedes CLI's maintainers.
