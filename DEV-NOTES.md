# DSH 插件开发笔记（数据台账实战沉淀）

> 用途：下一个自建插件（环评引擎）直接复用本文的每一条结论，不必重新踩坑。
> 版本基准：DSH 0.1.0-rc.6 · Node 24 · pnpm 11.21 · Windows。

## 1. 插件最小形态（官方 bundle）

```
dsh-data-ledger/
├── package.json        # dsh.bundle.patch → ./cordis.patch.yml；dsh.client 声明 client 半
├── cordis.patch.yml    # - insert: [{ id, name:'包名', config:{...} }]
├── lib/index.mjs       # host 半：export name / inject / apply(ctx, config)
├── client/main.js      # client 半：window.__ModuleLoader__.load(...)
└── test/*.mjs          # 独立 node 测试，不依赖 DSH 运行
```

- package.json 关键字段：`exports` 必须含 `"./client"` 与 `"./package.json"`；`dsh.bundle.patch` 指向 cordis.patch.yml；`dsh.client = { platform:"web", inject:[...], immediately:true }`。
- cordis.patch.yml 只做一件事：insert 自己一行（id + name + config）。config 会被原样传给 apply(ctx, config)。
- 零 `@deepseek-ai/*` 硬导入：host 靠 `inject` 声明服务（如 `['webServer']`），client 靠 `inject` 数组；import 第三方只会增加解析风险。

## 2. client 半契约（实测 win-notify 模式）

```js
window.__ModuleLoader__.load({
  id: "包名",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    // ... 定义 inject / apply(ctx) ...
    exports.name = ...; exports.inject = inject; exports.apply = apply;
    return module.exports;
  }
});
```

- **纯 DOM、零框架**最稳（track/better-sidebar 都这么干）：不引 React，无构建链。
- `inject` 里声明的服务会注入 ctx；不需要服务就 `[]`。
- `apply(ctx)` 里挂 UI 时防重复挂载（window 全局标记）；`document.body` 可能未就绪，要处理 DOMContentLoaded。
- fetch 走同源 `/api/...`；window.confirm 做两步确认足够。

## 3. host 半路由（实测 balance-meter/track 模式）

```js
export const inject = ['webServer']
ctx.effect(() => {
  const disposers = routes.map(r => ctx.webServer.register(r))
  return () => disposers.forEach(d => d())
}, 'name: routes')
// 路由对象: { kind:'exact', path:'/api/xxx', handler: async (req,res) => { try { await 逻辑 } catch(e){ json500 } } }
// res = Node 原生 ServerResponse：res.writeHead(status,{'content-type':'application/json'}) + res.end(JSON.stringify(...))
// 读 body：for await (const c of req) 收集 → JSON.parse
```

- **handler 必须 await 内部异步**（包装成 async + try/catch），否则错误静默、测试也抓不到结果。
- 405：手动 requireMethod 检查。

## 4. 路径安全（删除类插件必读）

- 白名单 = 数据根数组；`resolve()` 后做前缀比对（注意 `root + sep`，防 `sessions2` 前缀撞车）。
- **必须 realpath 复核**（防符号链接逃逸）；恢复场景文件已不存在 → `{ allowMissing:true }` 改为校验父目录 realpath。
- 整个数据区根目录本身禁删；DSH 主目录禁删。
- 删除 = rename 进回收站（同卷，快且可逆）；回收站条目 = `<时间戳>-<原名>/` 目录，内含原文件 + `meta.json {originalPath, deletedAt}`，恢复读 meta 即可。

## 5. 本机数据文件结构（盘点要用）

| 文件 | 结构 | 要点 |
|---|---|---|
| `storages/session_projcache.json` | `{unit, global, tables:{sessions:{<sessionId>:{identity:{createdAt,cwd}, rows:{title:{val}, sessionStats:{val:{turns,...}}}}}}}` | 会话标题/轮数/工作区都在这，**不用解压 zstd 日志** |
| `storages/track.json` 等 | 同为 `{unit,global,tables}` 三件套 | tables.<表名> = 记录 map，条数 = Object.keys().length |
| `sessions/<工作区>/<会话id>/` | 会话 id 直接当目录名（有/无 `session-` 前缀两种都有） | 投影缓存与磁盘目录按名对齐；缓存有而目录没有 = 已归档 |
| SQLite 库 | Node 24 内置 `node:sqlite`（DatabaseSync）可读 | 表名查 sqlite_master；用 `{readOnly:true}` |

## 6. 安装与 pnpm 陷阱（实测）

- 开发期：`dsh plugin --profile web add link:<绝对路径>`（改代码即时生效）；发布期用 file:/git/npm。
- `dsh plugin` = pnpm 转发 + 对账：exit 0 才把包名写进 `dsh.profile.bundles`；exit≠0 时依赖已装但**不会挂载**，重跑一次 `dsh plugin --profile web install` 可补对账。
- **pnpm 11 `allowBuilds` 是映射格式**（`pkg: true`），写列表会被拆坏；`pnpm approve-builds --all` 可非交互批准。
- pnpm 会自动往 pnpm-workspace.yaml 塞 `minimumReleaseAgeExclude`（发布 <24h 的包），属正常现象。
- node-pty 类构建依赖要 `pnpm rebuild <pkg>` 补跑 install 脚本。

## 7. 测试策略（不依赖 DSH 也能全链路验证）

1. `node --check` 全部源码（含 client，只验语法不执行）。
2. 逻辑层单测：直接 import lib/*.mjs 跑（盘点/回收站/校验），真实 DSH_HOME 上做"删→恢复→真删"回路。
3. **host 全链路**：mock ctx（`webServer.register` 收集路由）→ `apply(ctx, config)` → 用 `Readable.from` 造 req、造 res 骨架 → `await route.handler(req,res)` → 断言状态码与 JSON。**不需要重启就能验完全部接口**。
4. UI 层靠用户眼睛验收（无 headless 浏览器时的现实选择）。

## 8. 踩过的坑（别再犯）

- **【头号坑】`$DSH_HOME` 契约**：dsh 启动时**不把 home 写回 `process.env.DSH_HOME`**（官方内部走 resolveDshHome() 回退；第三方插件若只读环境变量且 apply 时同步抛错 → **整个 profile fail-loud，dsh web 直接崩**）。实例：dsh-memento 空 dbPath 时报 MISSING_DSH_HOME。我方对策（双保险）：① 自建插件一律 `process.env.DSH_HOME || join(homedir(), '.dsh')` 自带回退（data-ledger 已如此，故未崩）；② 对只认环境变量的第三方插件，在 cordis.patch.yml 写死绝对路径 dbPath。可向官方提 issue：boot 后 `process.env.DSH_HOME ??= resolveDshHome()`。
- **工具注册**（v0.2 实测）：`import { defineTool } from '@deepseek-ai/dsh-tools'` + `export const inject = ['tools', ...]` + `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`。**output.schema 必须显式 `additionalProperties: true`**（否则 defineTool 抛 UNSUPPORTED_SCHEMA）。独立 node 测试解析不到该包 → 临时 junction 桥：`mklink /J node_modules\@deepseek-ai <全局DSH>\node_modules\@deepseek-ai`，测完即拆（DSH 运行时由官方 loader 接管解析，不受影响）。
- `node:fs/promises` **没有** `existsSync`（在 node:fs）。
- 测试文件里 `await writeFile(...)` 若从 `node:fs`（回调版）导入会报 "cb must be function"。
- 路由包装器不 await 内层 handler → 测试读到 status 0，真机上错误也会静默。
- 恢复校验不要对"已不存在的原文件"做 realpath（见 §4）。
- 客户端定时刷新别用 busy 早退 + 不清定时器的写法（会永久停刷）；finally 里统一重排定时器。
- pnpm-workspace.yaml 的 allowBuilds 见 §6。
