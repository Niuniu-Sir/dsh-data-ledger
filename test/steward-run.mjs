// 管家巡检一次：真实驱动插件里的 ledger_* 工具（与未来会话同一代码路径）
import { apply } from '../lib/index.mjs'

const registered = []
const ctx = {
  effect(fn) { fn(); return () => {} },
  webServer: { register(r) { registered.push(r); return () => {} } },
  tools: { register(t) { registered.push(t); return () => {} } },
}
apply(ctx, { enabled: true, trashDays: 30, refreshSeconds: 20 })
const find = (n) => registered.find(t => t.name === n)

console.log('=== ledger_scan ===')
const scan = await find('ledger_scan').execute({}, {})
console.log(JSON.stringify(scan, null, 2))

console.log('=== ledger_clean_orphans（第一档，自动） ===')
const clean = await find('ledger_clean_orphans').execute({}, {})
console.log(JSON.stringify(clean, null, 2))

console.log('=== ledger_purge_expired（回收站到期） ===')
const purge = await find('ledger_purge_expired').execute({}, {})
console.log(JSON.stringify(purge, null, 2))

console.log('=== ledger_report_done（巡检锚点） ===')
const done = await find('ledger_report_done').execute({}, {})
console.log(JSON.stringify(done, null, 2))
