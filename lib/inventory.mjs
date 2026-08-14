// 数据台账 · 盘点模块（零 DSH 依赖，纯 Node 内置模块，可独立测试）
// 目标：把 ~/.dsh 里由 DSH/插件产生的数据，全部盘出来：
//   来源（哪个插件/官方）· 位置（文件夹+文件名）· 内容一句话摘要。
import { readFile, readdir, stat, lstat, mkdir } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { join, resolve, sep, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

let DB = null
try { ({ DatabaseSync: DB } = await import('node:sqlite')) } catch { /* 旧 Node，无 node:sqlite 时降级 */ }

const sizeCache = new Map()
const MAX_DU_ENTRIES = 20000

/** 递归目录大小；超上限截断并标记近似。结果按路径缓存（一次进程内）。 */
async function du(dir) {
  if (sizeCache.has(dir)) return sizeCache.get(dir)
  let total = 0, entries = 0, truncated = false
  const walk = async (d) => {
    let list
    try { list = await readdir(d) } catch { return }
    for (const n of list) {
      if (++entries > MAX_DU_ENTRIES) { truncated = true; return }
      const p = join(d, n)
      try {
        const s = await stat(p)
        if (s.isDirectory()) await walk(p)
        else total += s.size
      } catch { /* 忽略单个不可读项 */ }
    }
  }
  try { await walk(dir) } catch { /* 根不可读 */ }
  const result = { bytes: total, truncated }
  sizeCache.set(dir, result)
  return result
}

/** 人类可读大小 */
export function fmtSize(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

async function readJsonSafe(p) {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null }
}

/** 读取 SKILL.md 的 frontmatter（name/description） */
async function skillSummary(skillDir) {
  try {
    const t = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
    const m = /^---\n([\s\S]*?)\n---/.exec(t)
    if (m) {
      const fm = {}
      for (const line of m[1].split('\n')) {
        const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
        if (kv) fm[kv[1]] = kv[2].trim()
      }
      return { name: fm.name || basename(skillDir), description: fm.description || '(无描述)' }
    }
    return { name: basename(skillDir), description: '(无描述)' }
  } catch { return null }
}

/** SQLite 表行数（尽力而为，失败返回 null） */
function dbCounts(dbPath) {
  if (!DB || !existsSync(dbPath)) return null
  try {
    const db = new DB(dbPath, { readOnly: true })
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    const out = {}
    for (const n of names) {
      try { out[n] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${n}"`).get().n) } catch { }
    }
    db.close()
    return out
  } catch { return null }
}

// 来源标注表：统一格式「是什么 · 归属」（归属 = 官方 / 插件名）
const ORIGINS = [
  [['sessions'], '对话记录 · 官方'],
  [['storages', 'track.json'], '任务与决策账本 · dsh-track'],
  [['storages', 'workspace.json'], '工作区记录 · 官方'],
  [['storages', 'session_projcache.json'], '会话投影缓存 · 官方'],
  [['storages', 'message_feedback.json'], '消息反馈 · 官方'],
  [['storages', 'data-ledger-actions.log'], '操作日志 · dsh-data-ledger'],
  [['skills', 'fail-log-guide'], '工具失败错题本 · dsh-fail-logger'],
  [['memory'], '旧记忆库 · dsh-mneme（已卸载）'],
  [['dsh-memento'], '审批记忆库 · dsh-memento'],
  [['trash'], '回收站 · dsh-data-ledger'],
  [['profiles'], '插件本体与配置 · 官方+插件'],
]
function originOf(absPath) {
  const home = dshHome()
  for (const [segs, label] of ORIGINS) {
    if (absPath === join(home, ...segs) || absPath.startsWith(join(home, ...segs) + sep)) return label
  }
  return '未知来源 · 待认领'
}

/** 对话组：主/子代理区分 + 隶属关系 + 可删建议 */
const sessionHeaderCache = new Map()
/** 读会话日志头部第一行（含 parentSession / origin），带缓存 */
async function readSessionHeader(dir) {
  const file = join(dir, 'session.jsonl.zstd')
  let st
  try { st = await stat(file) } catch { return null }
  const key = `${file}|${st.size}|${st.mtimeMs}`
  if (sessionHeaderCache.has(key)) return sessionHeaderCache.get(key)
  let out = null
  try {
    const buf = await readFile(file)
    const text = zstdDecompressSync(buf).toString('utf8')
    const first = text.split('\n').find(Boolean)
    if (first) out = JSON.parse(first)
  } catch { out = null }
  sessionHeaderCache.set(key, out)
  return out
}

async function collectSessions(home) {
  const proj = await readJsonSafe(join(home, 'storages', 'session_projcache.json'))
  const projSessions = proj?.tables?.sessions ?? {}
  // 文件系统上的会话目录（sessions/<工作区>/<会话id>）
  const onDisk = new Map()
  try {
    for (const ws of await readdir(join(home, 'sessions'))) {
      const wsDir = join(home, 'sessions', ws)
      try {
        for (const s of await readdir(wsDir)) onDisk.set(s, join(wsDir, s))
      } catch { }
    }
  } catch { }
  const headers = new Map()
  for (const [key, dir] of onDisk) headers.set(key, await readSessionHeader(dir))
  const titleOf = (id) => {
    let t = projSessions[id]?.rows?.title?.val ?? projSessions[id]?.rows?.title
    const isBlank = projSessions[id]?.rows?.sessionListMetadata?.val?.blank === true
    t = typeof t === 'string' && t ? t : (isBlank ? '空白会话' : '(无标题)')
    // 去掉 DSH 自动加的重名后缀，如 "test (1)" → "test"
    return t.replace(/\s*\(\d+\)$/, '')
  }
  const short = (s) => {
    s = String(s ?? '')
    return s.length > 12 ? s.slice(0, 12) + '…' : s
  }
  const DAY = 86400000
  const keys = new Set([...onDisk.keys()])
  const byKey = new Map()
  for (const key of [...keys].sort()) {
    const dir = onDisk.get(key)
    const header = headers.get(key)
    const d = await du(dir)
    const st = await stat(dir).catch(() => null)
    const isSub = header?.origin === 'subagent'
    const isFork = !!header && !isSub && !!header.parentSession
    const isMain = !!header && !isSub && !header.parentSession
    let summary = '', kind = 'unknown', parentTitle = null, parentKey = null
    if (isSub) {
      kind = 'subagent'
      parentKey = header.parentSession
      parentTitle = titleOf(header.parentSession)
      summary = `主对话「${short(parentTitle)}」`
    } else if (isFork) {
      kind = 'fork'
      parentTitle = titleOf(header.parentSession)
      summary = `主对话「${short(parentTitle)}」`
    } else if (isMain) {
      kind = 'main'
      summary = `主对话「${short(titleOf(key))}」`
    }
    byKey.set(key, {
      key,
      name: titleOf(key),
      origin: originOf(dir),
      path: dir,
      type: 'dir',
      size: d.bytes,
      approx: d.truncated,
      mtime: st?.mtimeMs ?? null,
      summary,
      kind,
      parentTitle,
      parentKey,
      depth: 0,
      deletable: true,
    })
  }
  // 树状排序：主对话/分支在前，其子代理缩进跟随；孤儿子代理（主对话已不在）排最后
  const items = []
  const sortedKeys = [...keys].sort()
  const pushChildren = (parentKey) => {
    for (const ck of sortedKeys) {
      const child = byKey.get(ck)
      if (child?.kind === 'subagent' && child.parentKey === parentKey) {
        child.depth = 1
        child.summary = '' // 嵌套已表达归属，去掉重复的「主对话「X」」
        items.push(child)
      }
    }
  }
  for (const key of sortedKeys) {
    const item = byKey.get(key)
    if (item.kind === 'subagent') continue
    items.push(item)
    pushChildren(key)
  }
  for (const key of sortedKeys) {
    const item = byKey.get(key)
    if (item.kind === 'subagent' && item.depth === 0) items.push(item) // 孤儿：保留其「主对话「X」」摘要
  }
  return items
}

/** 账本组：storages 下每个文件 */
async function collectStorages(home) {
  const items = []
  let names = []
  try { names = await readdir(join(home, 'storages')) } catch { }
  for (const n of names.sort()) {
    const p = join(home, 'storages', n)
    const st = await stat(p).catch(() => null)
    if (!st?.isFile()) continue
    let summary = ''
    if (n === 'track.json') {
      const j = await readJsonSafe(p)
      const t = j?.tables ?? {}
      const c = (k) => Object.keys(t[k] ?? {}).length
      summary = `任务 ${c('issues')} · 念头 ${c('captures')} · 决策 ${c('decisions')}`
    } else if (n === 'session_projcache.json') {
      const j = await readJsonSafe(p)
      summary = `${Object.keys(j?.tables?.sessions ?? {}).length} 个会话`
    } else if (n === 'workspace.json') {
      const j = await readJsonSafe(p)
      summary = `${Object.keys(j?.tables?.workspaces ?? {}).length} 个工作区`
    }
    items.push({
      name: n,
      origin: originOf(p),
      path: p,
      type: 'file',
      size: st.size,
      mtime: st.mtimeMs,
      summary,
      deletable: true,
    })
  }
  return items
}

/** 技能组 */
async function collectSkills(home) {
  const items = []
  let dirs = []
  try { dirs = await readdir(join(home, 'skills')) } catch { }
  for (const d of dirs.sort()) {
    const p = join(home, 'skills', d)
    const st = await stat(p).catch(() => null)
    if (!st?.isDirectory()) continue
    const s = await skillSummary(p)
    const sz = await du(p)
    items.push({
      name: s?.name ?? d,
      origin: originOf(p),
      path: p,
      type: 'dir',
      size: sz.bytes,
      approx: sz.truncated,
      mtime: st.mtimeMs,
      summary: s?.description ?? '(无描述)',
      deletable: true,
    })
  }
  return items
}

/** 记忆库组（只列真实存在的文件；不存在的已进回收站或未初始化，不再显示） */
async function collectMemory(home) {
  const items = []
  // 旧 mneme 库（插件已卸载，属可安全删除的遗留数据）
  const oldP = join(home, 'memory', 'memory.db')
  const oldSt = await stat(oldP).catch(() => null)
  if (oldSt) {
    const oldCounts = dbCounts(oldP)
    const oldMemories = oldCounts?.memories
    items.push({
      name: '旧记忆库 memory.db',
      origin: originOf(join(home, 'memory')),
      path: oldP,
      type: 'file',
      size: oldSt.size,
      mtime: oldSt.mtimeMs,
      summary: `${oldMemories !== undefined ? oldMemories + ' 条记忆' : '遗留数据'}（dsh-mneme 已卸载）`,
      deletable: true,
    })
  }
  // 新 memento 库（在用，写入需你审批）
  const newP = join(home, 'dsh-memento', 'memory.db')
  const newSt = await stat(newP).catch(() => null)
  if (newSt) {
    const newCounts = dbCounts(newP)
    const entries = newCounts ? (newCounts.entries ?? newCounts.memories) : undefined
    items.push({
      name: '审批记忆库 memory.db',
      origin: originOf(join(home, 'dsh-memento')),
      path: newP,
      type: 'file',
      size: newSt.size,
      mtime: newSt.mtimeMs,
      summary: `${entries !== undefined ? entries + ' 条记忆' : '库已初始化'}（写入需你审批）`,
      deletable: true,
    })
  }
  return items
}

/** 日志组：dshHome 根目录 *.log */
async function collectLogs(home) {
  const items = []
  let names = []
  try { names = await readdir(home) } catch { }
  for (const n of names.filter(x => x.endsWith('.log')).sort()) {
    const p = join(home, n)
    const st = await stat(p).catch(() => null)
    if (!st?.isFile()) continue
    let lines = null
    try { lines = (await readFile(p, 'utf8')).split('\n').filter(Boolean).length } catch { }
    const known = { 'dsh-win-notify.log': '通知运行日志 · dsh-win-notify' }
    items.push({
      name: n,
      origin: known[n] ?? originOf(p),
      path: p,
      type: 'file',
      size: st.size,
      mtime: st.mtimeMs,
      summary: `日志 ${lines !== null ? lines + ' 行' : ''}`,
      deletable: true,
    })
  }
  return items
}

/** 回收站组 */
async function collectTrash(home, trashDays) {
  const items = []
  const trashDir = join(home, 'trash')
  let dirs = []
  try { dirs = await readdir(trashDir) } catch { }
  for (const d of dirs.sort().reverse()) {
    const p = join(trashDir, d)
    const st = await stat(p).catch(() => null)
    if (!st?.isDirectory()) continue
    const meta = await readJsonSafe(join(p, 'meta.json'))
    const sz = await du(p)
    items.push({
      name: d,
      origin: '回收站 · dsh-data-ledger',
      path: p,
      type: 'dir',
      size: sz.bytes,
      mtime: st.mtimeMs,
      expiresAt: st.mtimeMs + Number(trashDays) * 86400000,
      summary: `原路径: ${meta?.originalPath ?? '(未知)'}${meta?.deletedAt ? ' · 删除于 ' + new Date(meta.deletedAt).toLocaleString('zh-CN') : ''}`,
      deletable: false,
    })
  }
  return items
}

/** 只读参考组（砍到 3 行：插件本体大小 / 依赖缓存大小 / 凭据位置） */
async function collectReadonly(home) {
  const items = []
  const fmt = (b) => {
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'
    return (b / 1073741824).toFixed(2) + ' GB'
  }
  const profilesP = join(home, 'profiles')
  const profilesSt = await stat(profilesP).catch(() => null)
  if (profilesSt) {
    const d = await du(profilesP)
    items.push({
      origin: '插件本体与配置 · 官方+插件',
      path: profilesP,
      size: d.bytes,
      approx: d.truncated,
      mtime: profilesSt.mtimeMs,
      summary: `${fmt(d.bytes)}${d.truncated ? '（近似）' : ''} · 含全部已装插件程序，勿手工删`,
      showPath: false,
      deletable: false,
    })
  }
  // 凭据/身份文件：只显示位置与数量，永不显示内容
  let rootNames = []
  try { rootNames = await readdir(home) } catch { }
  const credFiles = []
  for (const n of rootNames.sort()) {
    if (!n.startsWith('.')) continue
    const p = join(home, n)
    const st = await stat(p).catch(() => null)
    if (st?.isFile()) credFiles.push({ n, p, st })
  }
  if (credFiles.length) {
    items.push({
      origin: '凭据与身份文件 · 官方',
      path: home,
      size: credFiles.reduce((a, f) => a + f.st.size, 0),
      mtime: Math.max(...credFiles.map(f => f.st.mtimeMs)),
      summary: `${credFiles.length} 个（${credFiles.map(f => f.n).join('、')}）· 内容永不显示`,
      showPath: true,
      deletable: false,
    })
  }
  // pnpm 缓存
  const pnpmP = join(process.env.LOCALAPPDATA || '', 'pnpm', 'store')
  const pnpmSt = await stat(pnpmP).catch(() => null)
  if (pnpmSt) {
    const d = await du(pnpmP)
    items.push({
      origin: '依赖缓存 · 官方',
      path: pnpmP,
      size: d.bytes,
      approx: d.truncated,
      mtime: pnpmSt.mtimeMs,
      summary: `${fmt(d.bytes)}${d.truncated ? '（近似）' : ''} · 可安全清理（重装插件会自动补齐）`,
      showPath: false,
      deletable: false,
    })
  }
  return items
}

/** 主入口：全量盘点 */
export async function collectInventory({ home, trashDays = 30 } = {}) {
  const h = home || dshHome()
  const [sessions, storages, skills, memory, logs, trash, readonly] = await Promise.all([
    collectSessions(h),
    collectStorages(h),
    collectSkills(h),
    collectMemory(h),
    collectLogs(h),
    collectTrash(h, trashDays),
    collectReadonly(h),
  ])
  const groups = [
    { id: 'sessions', title: '对话', items: sessions },
    { id: 'storages', title: '数据文件', items: storages },
    { id: 'skills', title: '技能', items: skills },
    { id: 'memory', title: '记忆库', items: memory },
    { id: 'logs', title: '日志', items: logs },
    { id: 'trash', title: '回收站', items: trash },
  ]
  const deletableBytes = groups
    .filter(g => g.id !== 'trash')
    .flatMap(g => g.items)
    .filter(i => i.deletable && i.size !== null)
    .reduce((a, i) => a + i.size, 0)
  return {
    generatedAt: Date.now(),
    dshHome: h,
    trashDays: Number(trashDays),
    totals: {
      deletableBytes,
      deletableSize: fmtSize(deletableBytes),
      groupCounts: Object.fromEntries(groups.map(g => [g.id, g.items.length])),
    },
    groups,
    readonly,
  }
}

export { dshHome }
