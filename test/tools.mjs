// 数据台账 · 管家工具测试：mock ctx 驱动 6 个 ledger_* 工具
// 用法: node test/tools.mjs
import { apply } from '../lib/index.mjs'
import { writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { strict as assert } from 'node:assert'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')

const registered = []
const ctx = {
  effect(fn) { fn(); return () => {} },
  webServer: { register(r) { registered.push(r); return () => {} } },
  tools: { register(t) { registered.push(t); return () => {} } },
}
apply(ctx, { enabled: true, trashDays: 30, refreshSeconds: 20 })
const tools = registered.filter(t => t.name?.startsWith('ledger_'))
const find = (n) => tools.find(t => t.name === n)

let pass = 0, fail = 0
const check = (name, fn) => Promise.resolve().then(fn)
  .then(() => { pass++; console.log('PASS', name) })
  .catch((e) => { fail++; console.log('FAIL', name, '→', e.message) })

await check('注册 6 个管家工具', async () => {
  assert.equal(tools.length, 6)
  for (const n of ['ledger_scan', 'ledger_clean_orphans', 'ledger_delete_paths', 'ledger_restore_path', 'ledger_purge_expired', 'ledger_report_done']) {
    assert.ok(find(n), '缺少 ' + n)
  }
})

await check('ledger_scan 返回结构化快报', async () => {
  const r = await find('ledger_scan').execute({}, {})
  assert.equal(r.ok, true)
  assert.ok(Array.isArray(r.orphans))
  assert.ok(Array.isArray(r.idle30d))
  assert.ok(Array.isArray(r.legacyData))
  assert.ok(Array.isArray(r.oldLogs))
  assert.ok(r.totals && r.trash && r.state)
  console.log(`  对话 ${r.totals.groupCounts.sessions} · 孤儿 ${r.orphans.length} · 30天未动 ${r.idle30d.length} · 回收站 ${r.trash.count}`)
})

await check('ledger_delete_paths 拒绝项目文件', async () => {
  const r = await find('ledger_delete_paths').execute({ paths: ['D:\\HomeRailProjects\\AGENTS.md'] }, {})
  assert.equal(r.ok, true)
  assert.equal(r.failedCount, 1)
  assert.equal(r.movedCount, 0)
})

await check('ledger_delete_paths 根日志全流程（删→恢复）', async () => {
  const testFile = join(home, '_ledger-tools-test.log')
  await writeFile(testFile, 'tools test\n')
  const del = await find('ledger_delete_paths').execute({ paths: [testFile] }, {})
  assert.equal(del.movedCount, 1, JSON.stringify(del))
  assert.equal(existsSync(testFile), false)
  const res = await find('ledger_restore_path').execute({ path: del.moved[0].trashPath }, {})
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(existsSync(testFile), true)
  await rm(testFile, { force: true })
})

await check('ledger_scan 拒绝空路径', async () => {
  const r = await find('ledger_restore_path').execute({ path: '' }, {})
  assert.equal(r.ok, false)
})

await check('ledger_report_done 写锚点', async () => {
  const r = await find('ledger_report_done').execute({}, {})
  assert.equal(r.ok, true)
  const scan = await find('ledger_scan').execute({}, {})
  assert.equal(scan.state.daysSinceReport, 0)
})

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
