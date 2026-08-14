# dsh-data-ledger · Data Ledger / 数据管理

[简体中文](README.md) · English

[![version](https://img.shields.io/badge/version-0.4.9-blue)](package.json)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2563eb)](https://github.com/topics/dsh-plugin)

**A unified local-data dashboard + AI steward for DeepSeek Harness**: every piece of local data produced by DSH (conversations, data files, skills, memory DBs, logs, browser storage) becomes visible, traceable to its origin plugin, and recyclable; a set of `ledger_*` tools lets the agent inspect and manage it on its own.

**DSH 本地数据统一管理看板 + AI 管家**：凡因使用 DeepSeek Harness 产生的本地数据，全部可见、可追溯来源、可回收站式删除；并给智能体装上 `ledger_*` 工具，让它自己看懂并打理这些数据。

---

## ✨ Features

### Dashboard (for humans)
- Right-side (configurable left) sliding panel, grouped into **sessions / storages / skills / memory / logs / trash / localStorage / readonly**, each group showing count and total size
- Every row shows: **origin (which plugin / official) · name · size · time · one-line summary**
- **Two-level collapse**: click a group header to collapse the group; click a main-conversation row to collapse its subagents (groups collapsed by default)
- **Tree nesting**: main conversations/forks first, AI subagents indented underneath (`↳`); orphaned subagents listed separately
- Recycle-bin deletes (30 days, restorable); **deleting a main conversation cascades to its subagents** (all into the recycle bin)
- Copy path / reveal in Explorer / localStorage keys viewer with masking
- Light & dark themes (two hardcoded official palettes), click-outside to close, draggable width (floor locked to the user's measured 262px, up to 800px)

### AI Steward (for the agent)
- `ledger_scan` — full inventory (totals, orphans, 30-day idle, legacy data, trash status)
- `ledger_clean_orphans` — tier-1 auto-clean (orphans / uninstalled-plugin leftovers / logs older than 30 days, no prompt)
- `ledger_delete_paths` — tier-2 batch delete (user-approved only)
- `ledger_restore_path` / `ledger_purge_expired` — restore / purge expired trash
- `ledger_report_done` — weekly inspection anchor
- Bundled skill `ledger-steward`: weekly proactive inspection, two-tier rules, safety rails

## 🔒 Safety

- Only manages DSH data under `~/.dsh`; **never touches user project files** (reports, fact bases, …)
- Path allow-list + realpath re-check (symlink-escape proof); out-of-scope paths rejected
- Deletes always go to the recycle bin first; permanent deletion needs double confirmation
- Credential files show location & size only — **contents are never displayed**
- Zero third-party dependencies, no network requests

## 🚀 Install

```sh
dsh plugin --profile web add github:Niuniu-Sir/dsh-data-ledger
```

Restart `dsh web` afterwards. Uninstall: `dsh plugin --profile web remove dsh-data-ledger` (data files stay; clean up via the panel as needed).

## 🖱 Usage

1. Click the 📋 floating button → the panel slides in; click anywhere outside to dismiss
2. Click group headers to expand/collapse; click a main-conversation row to collapse its subagents
3. Tell the agent "how much junk is there" — the steward reports and cleans per the two-tier rules (weekly automatic inspection)

## ⚙️ Config (the `data-ledger` row in cordis.patch.yml)

| Field | Default | Meaning |
|---|---|---|
| enabled | true | master switch |
| trashDays | 30 | recycle-bin retention days |
| refreshSeconds | 20 | panel auto-refresh interval (s) |

## 🛠 Development

```sh
node --check lib/*.mjs client/main.js      # syntax
node test/smoke.mjs                         # inventory / recycle bin / path checks
node test/http.mjs                          # panel API end-to-end (mock ctx)
node test/tools.mjs                         # steward tools
```

Architecture & pitfalls: [DEV-NOTES.md](DEV-NOTES.md) (a practical DSH-plugin field manual: no `@deepseek-ai/*` imports for link-installed plugins, the `$DSH_HOME` contract, native tool registration, pnpm traps, …). History: [CHANGELOG.md](CHANGELOG.md).

## 📄 License

MIT © Niuniu-Sir
