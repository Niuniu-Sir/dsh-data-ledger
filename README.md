# dsh-data-ledger · 数据管理 / Data Ledger

[English](README.en.md) · 简体中文

[![version](https://img.shields.io/badge/version-0.4.9-blue)](package.json)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2563eb)](https://github.com/topics/dsh-plugin)

**DSH 本地数据统一管理看板 + AI 管家**：凡因使用 DeepSeek Harness 产生的本地数据（对话 / 数据文件 / 技能 / 记忆库 / 日志 / 浏览器存储），全部可见、可追溯来源、可回收站式删除；并给智能体装上 `ledger_*` 工具，让它自己看懂并打理这些数据。

**A unified local-data dashboard + AI steward for DeepSeek Harness**: every piece of local data produced by DSH (conversations, data files, skills, memory DBs, logs, browser storage) becomes visible, traceable to its origin plugin, and recyclable; a set of `ledger_*` tools lets the agent inspect and manage it on its own.

---

## ✨ 功能 / Features

### 看板（给人）/ Dashboard (for humans)
- 右侧「数据管理」面板：分组展示 **对话 / 数据文件 / 技能 / 记忆库 / 日志 / 回收站 / 浏览器存储 / 只读参考**，每组显示数量与体积
- 每项展示：**来源（哪个插件/官方）· 名称 · 大小 · 时间 · 一句话摘要**
- **两层折叠**：分组点击收起；主对话行点击收起其子代理（默认全部收起）
- **树状嵌套**：主对话/分支在前，AI 子代理缩进其下（`↳`），孤儿子代理单独列出
- 删除进回收站（可恢复、**永不自动清空**——清不清由人点名）；**删除主对话自动连坐其子代理**（一并进回收站）
- 复制路径 / 资源管理器定位 / 浏览器存储键查看与清除（键名打码）
- 深浅色主题自适应（官方色板两套硬编码），点面板外自动收回

### AI 管家（给智能体）/ AI Steward (for the agent)
- `ledger_scan` 全盘盘点（总量、孤儿、30 天未动、遗留数据、回收站状态）
- `ledger_delete_paths` 移入回收站（**必须先向用户列清单并得到明确同意**）
- `ledger_restore_path` 恢复；`ledger_purge_paths` **只清用户点名**的回收站条目
- `ledger_report_done` 每周巡检节奏锚点
- 配套技能 `ledger-steward`：每周主动巡检、**只问不动**——管家没有任何清除权限，一切动作先问人

## 🔒 安全边界 / Safety

- 只管理 `~/.dsh` 内的 DSH 数据；**绝不触碰用户项目文件**（报告、事实库等）
- 路径白名单 + realpath 复核（防符号链接逃逸），越界一律拒绝
- 删除永远先进回收站；彻底删除需双重确认
- 凭据类文件只显示位置与大小，**内容永不显示**
- 零第三方依赖、无网络请求

## 🚀 安装 / Install

```sh
dsh plugin --profile web add github:Niuniu-Sir/dsh-data-ledger
```

装完重启 `dsh web`。卸载：`dsh plugin --profile web remove dsh-data-ledger`（数据文件保留，可按需清理）。

## 🖱 使用 / Usage

1. 右侧中部偏下的 📋 方块按钮 → 滑出面板；点面板外任意处收回
2. 点分组标题展开/收起；点主对话行展开/收起其子代理
3. 对智能体说「看看有多少垃圾」，管家列清单提议、**你点名才清**（每周自动巡检一次）

## ⚙️ 配置 / Config（cordis.patch.yml 内 `data-ledger` 行）

| 字段 | 默认 | 说明 |
|---|---|---|
| enabled | true | 启用开关 |
| trashDays | 30 | 回收站保留天数 |
| refreshSeconds | 20 | 面板自动刷新间隔（秒） |

## 🛠 开发 / Development

```sh
node --check lib/*.mjs client/main.js      # 语法
node test/smoke.mjs                         # 盘点/回收站/校验
node test/http.mjs                          # 面板接口全链路（mock ctx）
node test/tools.mjs                         # 管家工具
```

架构与踩坑记录见 [DEV-NOTES.md](DEV-NOTES.md)（DSH 插件开发实战手册：link 安装禁 import 官方包、$DSH_HOME 契约、工具注册、pnpm 陷阱等）。版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 📄 License

MIT © Niuniu-Sir
