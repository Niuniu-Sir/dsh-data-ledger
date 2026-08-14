// 数据台账 · host 半
// 1) 面板 HTTP 接口（/api/data-ledger/*）
// 2) AI 管家工具（ledger_*）——让智能体自己看懂并清理本地数据
//
// 禁止静态 import '@deepseek-ai/*'：本包以 link: 装进 profile，
// Node 从 D:\DSH_TEST\dsh-data-ledger 解析，走不到 $DSH_HOME/profiles/node_modules。
import { collectInventory } from './inventory.mjs'
import { moveToTrash, restoreFromTrash, purgeTrash, openInExplorer } from './trash.mjs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'

export const name = 'dsh-data-ledger'
export const inject = ['webServer', 'tools']

const DAY = 86400000

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
const requireMethod = (req, res, method) => {
  if (req.method === method) return true
  json(res, 405, { ok: false, error: 'method-not-allowed' })
  return false
}
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
}
const route = (path, handler) => ({
  kind: 'exact',
  path,
  handler: async (req, res) => {
    try { await handler(req, res) } catch (error) {
      json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  },
})

/** 原生 ToolDefinition（不经 defineTool）：parameters 用 JSON Schema，output 仍由 registry 校验。 */
const jsonText = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
const tool = (name, description, parameters, execute) => ({
  name,
  description,
  parameters,
  output: { schema: { type: 'object', additionalProperties: true }, render: jsonText },
  execute,
})
const emptyParams = { type: 'object', properties: {} }

// ---- 管家状态（每周巡检节奏） ----
async function readState(home) {
  const p = join(home, 'storages', 'data-ledger-state.json')
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return { lastReportTs: 0 } }
}
async function writeState(home, state) {
  const p = join(home, 'storages', 'data-ledger-state.json')
  await writeFile(p, JSON.stringify(state, null, 2))
}

/** 删除主对话/分支时，连坐其名下全部子代理（一并进回收站，仍可恢复） */
async function deleteWithCascade(home, p) {
  const r = await moveToTrash(home, p)
  if (!r.ok) return { ok: false, error: r.error, moved: [], movedCount: 0 }
  const moved = [{ path: p, trashPath: r.trashPath }]
  try {
    const inv = await collectInventory({ home, trashDays: 30 })
    const sessions = inv.groups.find(g => g.id === 'sessions')?.items ?? []
    const root = sessions.find(i => i.path === p && (i.kind === 'main' || i.kind === 'fork'))
    if (root?.key) {
      const children = sessions.filter(i => i.depth === 1 && i.parentKey === root.key)
      for (const c of children) {
        const cr = await moveToTrash(home, c.path)
        if (cr.ok) moved.push({ path: c.path, trashPath: cr.trashPath, cascaded: true })
      }
    }
  } catch { /* 级联失败不影响主删除结果 */ }
  return { ok: true, moved, movedCount: moved.length }
}

// ---- 管家扫描：精简、面向模型上下文 ----
async function stewardScan(home) {
  const inv = await collectInventory({ home, trashDays: 30 })
  const now = Date.now()
  const sessions = inv.groups.find(g => g.id === 'sessions')?.items ?? []
  const memory = inv.groups.find(g => g.id === 'memory')?.items ?? []
  const logs = inv.groups.find(g => g.id === 'logs')?.items ?? []
  const trash = inv.groups.find(g => g.id === 'trash')?.items ?? []
  // 孤儿：主对话已不在磁盘上的子代理（第一档，可自动清）——未被嵌套的 depth-0 子代理
  const orphans = sessions.filter(i => i.kind === 'subagent' && i.depth === 0)
  // 30 天未动的对话（第二档，需用户确认）
  const idle30d = sessions.filter(i => i.mtime && now - i.mtime > 30 * DAY)
  // 遗留垃圾：已卸载插件的数据 + 30 天前的日志（第一档）
  const legacy = memory.filter(i => i.origin.includes('已卸载'))
  const oldLogs = logs.filter(i => i.mtime && now - i.mtime > 30 * DAY)
  const expired = trash.filter(i => i.expiresAt && i.expiresAt < now)
  const state = await readState(home)
  return {
    ok: true,
    generatedAt: now,
    dshHome: home,
    totals: { deletableBytes: inv.totals.deletableBytes, deletableSize: inv.totals.deletableSize, groupCounts: inv.totals.groupCounts },
    orphans: orphans.map(({ name, path, size, parentTitle }) => ({ name, path, size, parentTitle })),
    idle30d: idle30d.map(({ name, path, size, mtime }) => ({ name, path, size, mtime, days: Math.floor((now - mtime) / DAY) })),
    legacyData: legacy.map(({ name, path, size }) => ({ name, path, size })),
    oldLogs: oldLogs.map(({ name, path, size, mtime }) => ({ name, path, size, mtime })),
    trash: { count: trash.length, bytes: trash.reduce((a, i) => a + (i.size || 0), 0), expiredCount: expired.length },
    state: { lastReportTs: state.lastReportTs, daysSinceReport: Math.floor((now - (state.lastReportTs || 0)) / DAY) },
  }
}

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const current = () => ({
    enabled: config.enabled ?? true,
    trashDays: Number(config.trashDays ?? 30),
    refreshSeconds: Number(config.refreshSeconds ?? 20),
  })

  // ============ 面板 HTTP 接口 ============
  const routes = [
    route('/api/data-ledger/config', (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      json(res, 200, { ok: true, ...current() })
    }),
    route('/api/data-ledger/inventory', async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      if (!current().enabled) return json(res, 200, { ok: true, disabled: true })
      const inv = await collectInventory({ home, trashDays: current().trashDays })
      json(res, 200, { ok: true, ...inv })
    }),
    route('/api/data-ledger/delete', async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readBody(req)
      const r = await deleteWithCascade(home, body?.path ?? '')
      json(res, r.ok ? 200 : 400, r)
    }),
    route('/api/data-ledger/restore', async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readBody(req)
      const r = await restoreFromTrash(home, body?.path ?? '')
      json(res, r.ok ? 200 : 400, r)
    }),
    route('/api/data-ledger/purge', async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readBody(req)
      const r = await purgeTrash(home, body?.path ?? '')
      json(res, r.ok ? 200 : 400, r)
    }),
    route('/api/data-ledger/open-path', async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const body = await readBody(req)
      const r = await openInExplorer(home, body?.path ?? '')
      json(res, r.ok ? 200 : 400, r)
    }),
  ]

  // ============ AI 管家工具 ============
  const tools = [
    tool(
      'ledger_scan',
      '数据台账管家：扫描 DSH 本地数据，返回总量、孤儿记录（主对话已归档的子代理）、30 天未动的对话、已卸载插件遗留数据、过期日志与回收站状态。用户问"产生了多少垃圾/占了多少空间"或每周例行巡检时使用。只读，不删除任何东西。',
      emptyParams,
      async () => stewardScan(home),
    ),
    tool(
      'ledger_clean_orphans',
      '数据台账管家（第一档·自动清理，无需用户确认）：把孤儿子代理对话（主对话已被用户归档删除）、已卸载插件遗留数据、30 天前的过期日志移入回收站。全部可恢复（回收站保留 30 天）。绝不触碰用户的项目文件。执行后返回清理清单。',
      emptyParams,
      async () => {
        const scan = await stewardScan(home)
        const targets = [
          ...scan.orphans.map(i => ({ ...i, reason: '主对话已归档' })),
          ...scan.legacyData.map(i => ({ ...i, reason: '已卸载插件遗留' })),
          ...scan.oldLogs.map(i => ({ ...i, reason: '30 天前日志' })),
        ]
        const moved = [], failed = []
        for (const t of targets) {
          const r = await moveToTrash(home, t.path)
          if (r.ok) moved.push({ ...t, trashPath: r.trashPath })
          else failed.push({ ...t, error: r.error })
        }
        return { ok: true, movedCount: moved.length, failedCount: failed.length, moved, failed }
      },
    ),
    tool(
      'ledger_delete_paths',
      '数据台账管家（第二档·需用户批准后调用）：把指定路径批量移入回收站。只能删除 ledger_scan 返回的、且用户已明确同意删除的数据（对话、数据文件、日志等）。绝不触碰用户项目文件。',
      {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: '要删除的路径列表（来自 ledger_scan 的输出，需用户已批准）' },
        },
        required: ['paths'],
      },
      async (args) => {
        const moved = [], failed = []
        for (const p of (args.paths ?? [])) {
          const r = await deleteWithCascade(home, p)
          if (r.ok) moved.push(...r.moved.map(m => ({ ...m, from: p })))
          else failed.push({ path: p, error: r.error })
        }
        return { ok: true, movedCount: moved.length, failedCount: failed.length, moved, failed }
      },
    ),
    tool(
      'ledger_restore_path',
      '数据台账管家：把回收站里的条目恢复到原位置（用户反悔时使用）。',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: '回收站条目路径（来自 ledger_scan / 台账面板的回收站列表）' },
        },
        required: ['path'],
      },
      async (args) => restoreFromTrash(home, args.path ?? ''),
    ),
    tool(
      'ledger_purge_expired',
      '数据台账管家：彻底删除回收站里已超过保留期（默认 30 天）的条目。用户确认"回收站到期自动清空"后使用；未到期条目不动。',
      emptyParams,
      async () => {
        const inv = await collectInventory({ home, trashDays: current().trashDays })
        const trashItems = inv.groups.find(g => g.id === 'trash')?.items ?? []
        let count = 0
        for (const t of trashItems) {
          if (t.expiresAt && t.expiresAt < Date.now()) {
            const r = await purgeTrash(home, t.path)
            if (r.ok) count++
          }
        }
        return { ok: true, purged: count }
      },
    ),
    tool(
      'ledger_report_done',
      '数据台账管家：记录"本周巡检汇报已完成"的时间戳（每周主动巡检节奏的锚点）。向用户汇报完巡检结果后调用一次。',
      emptyParams,
      async () => {
        const ts = Date.now()
        await writeState(home, { lastReportTs: ts })
        return { ok: true, lastReportTs: ts }
      },
    ),
  ]

  ctx.effect(() => {
    const disposers = routes.map((r) => ctx.webServer.register(r))
    return () => { for (const d of disposers) d() }
  }, 'data-ledger: routes')
  ctx.effect(() => {
    const disposers = tools.map((t) => ctx.tools.register(t))
    return () => { for (const d of disposers) d() }
  }, 'data-ledger: tools')
}
