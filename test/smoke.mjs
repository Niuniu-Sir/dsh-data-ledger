// 数据台账 · 自测：盘点 + 回收站 + 路径校验（独立于 DSH，直接 node 运行）
// 用法: node test/smoke.mjs
import { collectInventory, fmtSize } from '../lib/inventory.mjs'
import { moveToTrash, restoreFromTrash, purgeTrash, validateDeletable } from '../lib/trash.mjs'
import { writeFile, mkdir, rm, stat, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { strict as assert } from 'node:assert'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
let pass = 0, fail = 0
const check = (name, fn) => Promise.resolve().then(fn)
  .then(() => { pass++; console.log('PASS', name) })
  .catch((e) => { fail++; console.log('FAIL', name, '→', e.message) })

await check('盘点不抛错且六组齐全', async () => {
  const inv = await collectInventory({ home, trashDays: 30 })
  const ids = inv.groups.map(g => g.id)
  assert.deepEqual(ids, ['sessions', 'storages', 'skills', 'memory', 'logs', 'trash'])
  console.log('  总览:', inv.totals.deletableSize, JSON.stringify(inv.totals.groupCounts))
  for (const g of inv.groups) {
    if (g.items.length) {
      console.log(`  [${g.title}] ${g.items.length} 项，首项:`, JSON.stringify(g.items[0]).slice(0, 200))
    }
  }
  console.log('  只读参考:', inv.readonly.length, '项')
})

await check('对话组区分主/子代理', async () => {
  const inv = await collectInventory({ home, trashDays: 30 })
  const sess = inv.groups.find(g => g.id === 'sessions')
  const subs = sess.items.filter(i => i.kind === 'subagent')
  const mains = sess.items.filter(i => i.kind === 'main')
  assert.ok(subs.length >= 1, '应有子代理会话')
  assert.ok(mains.length >= 1, '应有主对话')
  const s = subs[0]
  assert.ok(s.parentTitle && s.summary.includes('隶属主对话'), '子代理应标注隶属关系')
  console.log(`  子代理 ${subs.length} 个 / 主对话 ${mains.length} 个，示例: ${s.name} → ${s.parentTitle}`)
})

await check('路径校验：项目文件被拒', async () => {
  const r = await validateDeletable(home, 'D:\\HomeRailProjects\\AGENTS.md')
  assert.equal(r.ok, false)
})
await check('路径校验：profiles 被拒', async () => {
  const r = await validateDeletable(home, join(home, 'profiles'))
  assert.equal(r.ok, false)
})
await check('路径校验：越界穿越被拒', async () => {
  const r = await validateDeletable(home, join(home, '..', '..', 'Windows'))
  assert.equal(r.ok, false)
})

await check('删除→回收站→恢复 全流程', async () => {
  const testFile = join(home, '_ledger-smoke-test.log')
  await writeFile(testFile, 'ledger smoke test\n')
  const v = await validateDeletable(home, testFile)
  assert.equal(v.ok, true, '根目录 .log 应允许删除')
  const r1 = await moveToTrash(home, testFile)
  assert.equal(r1.ok, true, r1.error)
  assert.equal(existsSync(testFile), false)
  const meta = JSON.parse(await readFile(join(r1.trashPath, 'meta.json'), 'utf8'))
  assert.equal(meta.originalPath, testFile)
  const r2 = await restoreFromTrash(home, r1.trashPath)
  assert.equal(r2.ok, true, r2.error)
  assert.equal(existsSync(testFile), true)
  await rm(testFile, { force: true })
})

await check('回收站彻底删除', async () => {
  const testFile = join(home, '_ledger-smoke-test2.log')
  await writeFile(testFile, 'purge test\n')
  const r1 = await moveToTrash(home, testFile)
  assert.equal(r1.ok, true)
  const r2 = await purgeTrash(home, r1.trashPath)
  assert.equal(r2.ok, true, r2.error)
  assert.equal(existsSync(r1.trashPath), false)
})

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
