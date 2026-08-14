// 数据台账 · 主机全链路测试：用模拟 ctx 驱动 apply()，走真实路由处理器
// 用法: node test/http.mjs
import { apply } from '../lib/index.mjs'
import { writeFile, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Readable } from 'node:stream'
import { strict as assert } from 'node:assert'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')

// —— 模拟 DSH 上下文 ——
const registered = []
const registeredTools = []
const ctx = {
  effect(fn) { fn(); return () => {} },
  webServer: { register(route) { registered.push(route); return () => {} } },
  tools: { register(t) { registeredTools.push(t); return () => {} } },
}
apply(ctx, { enabled: true, trashDays: 30, refreshSeconds: 20 })
assert.ok(registered.length === 7, '应注册 7 条路由，实际 ' + registered.length)
assert.ok(registeredTools.length === 6, '应注册 6 个管家工具，实际 ' + registeredTools.length)

// —— 模拟 HTTP 请求/响应 ——
function makeReq(method, url, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method
  req.url = url
  return req
}
function makeRes() {
  const res = { status: 0, body: '' }
  res.writeHead = (s, h) => { res.status = s }
  res.end = (b) => { res.body = typeof b === 'string' ? b : JSON.stringify(b) }
  return res
}
async function call(route, method, url, body) {
  const req = makeReq(method, url, body)
  const res = makeRes()
  await route.handler(req, res)
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch { }
  return { status: res.status, json: parsed }
}
const find = (path) => registered.find(r => r.path === path)

let pass = 0, fail = 0
const check = (name, fn) => Promise.resolve().then(fn)
  .then(() => { pass++; console.log('PASS', name) })
  .catch((e) => { fail++; console.log('FAIL', name, '→', e.message) })

await check('GET /config 返回配置', async () => {
  const r = await call(find('/api/data-ledger/config'), 'GET', '/api/data-ledger/config')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.trashDays, 30)
})

await check('GET /inventory 返回六组+只读', async () => {
  const r = await call(find('/api/data-ledger/inventory'), 'GET', '/api/data-ledger/inventory')
  assert.equal(r.status, 200)
  assert.ok(r.json.ok)
  assert.equal(r.json.groups.length, 6)
  assert.ok(Array.isArray(r.json.readonly))
  assert.ok(r.json.totals.groupCounts.sessions >= 1)
})

await check('POST /delete 根日志 → 回收站 → restore 还原', async () => {
  const testFile = join(home, '_ledger-http-test.log')
  await writeFile(testFile, 'http test\n')
  const del = await call(find('/api/data-ledger/delete'), 'POST', '/api/data-ledger/delete', { path: testFile })
  assert.equal(del.status, 200, del.json?.error)
  assert.equal(del.json.ok, true)
  assert.equal(del.json.movedCount, 1)
  assert.equal(existsSync(testFile), false)
  const trashPath = del.json.moved[0].trashPath
  const inv = await call(find('/api/data-ledger/inventory'), 'GET', '/api/data-ledger/inventory')
  assert.ok(inv.json.groups.find(g => g.id === 'trash').items.some(i => i.path === trashPath))
  const res = await call(find('/api/data-ledger/restore'), 'POST', '/api/data-ledger/restore', { path: trashPath })
  assert.equal(res.json.ok, true, res.json.error)
  assert.equal(existsSync(testFile), true)
  await rm(testFile, { force: true })
})

await check('POST /delete 拒绝越界路径', async () => {
  const r = await call(find('/api/data-ledger/delete'), 'POST', '/api/data-ledger/delete', { path: 'D:\\HomeRailProjects\\AGENTS.md' })
  assert.equal(r.status, 400)
  assert.equal(r.json.ok, false)
})

await check('POST /delete 拒绝 profiles', async () => {
  const r = await call(find('/api/data-ledger/delete'), 'POST', '/api/data-ledger/delete', { path: join(home, 'profiles') })
  assert.equal(r.status, 400)
  assert.equal(r.json.ok, false)
})

await check('POST /purge 彻底删除回收站条目', async () => {
  const testFile = join(home, '_ledger-http-test2.log')
  await writeFile(testFile, 'purge test\n')
  const del = await call(find('/api/data-ledger/delete'), 'POST', '/api/data-ledger/delete', { path: testFile })
  assert.equal(del.json.ok, true)
  const pur = await call(find('/api/data-ledger/purge'), 'POST', '/api/data-ledger/purge', { path: del.json.moved[0].trashPath })
  assert.equal(pur.json.ok, true, pur.json.error)
  assert.equal(existsSync(del.json.moved[0].trashPath), false)
})

await check('错误方法返回 405', async () => {
  const r = await call(find('/api/data-ledger/inventory'), 'POST', '/api/data-ledger/inventory', {})
  assert.equal(r.status, 405)
})

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
