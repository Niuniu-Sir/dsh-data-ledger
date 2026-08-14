// 数据台账 · host 半：注册 /api/data-ledger/* HTTP 接口（对标 rc.6 webServer 路由模式）
import { collectInventory } from './inventory.mjs'
import { moveToTrash, restoreFromTrash, purgeTrash, openInExplorer } from './trash.mjs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-data-ledger'
export const inject = ['webServer']

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

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const current = () => ({
    enabled: config.enabled ?? true,
    trashDays: Number(config.trashDays ?? 30),
    refreshSeconds: Number(config.refreshSeconds ?? 20),
  })

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
      const r = await moveToTrash(home, body?.path ?? '')
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

  ctx.effect(() => {
    const disposers = routes.map((r) => ctx.webServer.register(r))
    return () => { for (const d of disposers) d() }
  }, 'data-ledger: routes')
}
