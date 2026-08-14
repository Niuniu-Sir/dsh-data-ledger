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

// 来源标注表：路径 → 来源说明
const ORIGINS = [
  [['sessions'], '官方 · 对话记录'],
  [['storages', 'track.json'], '插件 dsh-track · 任务/决策账本'],
  [['storages', 'workspace.json'], '官方 · 工作区记录'],
  [['storages', 'session_projcache.json'], '官方 · 会话投影缓存'],
  [['storages', 'message_feedback.json'], '官方 · 消息反馈'],
  [['storages', 'data-ledger-actions.log'], '插件 dsh-data-ledger · 本插件操作日志'],
  [['skills', 'fail-log-guide'], '插件 dsh-fail-logger · 工具失败错题本'],
  [['memory'], '插件 dsh-mneme（已卸载）· 旧记忆库'],
  [['dsh-memento'], '插件 dsh-memento · 审批记忆库'],
  [['trash'], '插件 dsh-data-ledger · 回收站'],
  [['profiles'], '官方 + 已装插件 · 程序本体与配置'],
]
function originOf(absPath) {
  const home = dshHome()
  for (const [segs, label] of ORIGINS) {
    if (absPath === join(home, ...segs) || absPath.startsWith(join(home, ...segs) + sep)) return label
  }
  return '未知来源（待认领）'
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
  const items = []
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
    const t = projSessions[id]?.rows?.title?.val ?? projSessions[id]?.rows?.title
    return typeof t === 'string' && t ? t : '(无标题)'
  }
  const keys = new Set([...Object.keys(projSessions), ...onDisk.keys()])
  for (const key of [...keys].sort()) {
    const dir = onDisk.get(key)
    const entry = projSessions[key]
    const header = headers.get(key)
    if (dir) {
      const d = await du(dir)
      const st = await stat(dir).catch(() => null)
      const isSub = !!header?.parentSession
      const isMain = !!header && !header.parentSession
      let summary, kind = 'unknown', parentTitle = null, suggestDelete = false
      if (isSub) {
        kind = 'subagent'
        parentTitle = titleOf(header.parentSession)
        suggestDelete = !onDisk.has(header.parentSession)
        summary = `由主对话「${parentTitle}」在讨论中自动发起（AI 子代理，非你主动开启）${suggestDelete ? ' · 主对话已归档，可安全删除' : ''}`
      } else if (isMain) {
        kind = 'main'
        summary = `你发起的主对话 · 工作区 ${entry?.identity?.cwd ?? header?.cwd ?? '(未知)'}`
      } else {
        summary = `工作区 ${entry?.identity?.cwd ?? '(未知)'}`
      }
      items.push({
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
        suggestDelete,
        deletable: true,
      })
    } else {
      items.push({
        name: `${titleOf(key)}（文件已不在）`,
        origin: '官方 · 对话记录',
        path: null,
        type: 'missing',
        size: null,
        mtime: entry?.identity?.createdAt ?? null,
        summary: '投影缓存中有记录，但磁盘上已无对应目录',
        kind: 'missing',
        deletable: false,
      })
    }
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
    let summary = '数据文件'
    if (n === 'track.json') {
      const j = await readJsonSafe(p)
      const t = j?.tables ?? {}
      const c = (k) => Object.keys(t[k] ?? {}).length
      summary = `任务 ${c('issues')} · 念头 ${c('captures')} · 决策 ${c('decisions')} · 审计 ${c('audit')}`
    } else if (n === 'session_projcache.json') {
      const j = await readJsonSafe(p)
      summary = `会话投影缓存 · ${Object.keys(j?.tables?.sessions ?? {}).length} 个会话`
    } else if (n === 'workspace.json') {
      const j = await readJsonSafe(p)
      summary = `工作区记录 · ${Object.keys(j?.tables?.workspaces ?? {}).length} 个`
    } else if (n === 'data-ledger-actions.log') {
      const lines = (await readFile(p, 'utf8').catch(() => '')).split('\n').filter(Boolean).length
      summary = `操作日志 · ${lines} 条记录`
    } else if (n.endsWith('.json')) {
      const j = await readJsonSafe(p)
      if (j && typeof j === 'object') {
        const t = j.tables
        const keys = t ? Object.keys(t) : Object.keys(j)
        summary = `结构: ${keys.slice(0, 4).join(' / ') || '(空)'}${keys.length > 4 ? ' …' : ''}`
      }
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

/** 记忆库组 */
async function collectMemory(home) {
  const items = []
  // 旧 mneme 库
  const oldP = join(home, 'memory', 'memory.db')
  const oldSt = await stat(oldP).catch(() => null)
  const oldCounts = oldSt ? dbCounts(oldP) : null
  const oldMemories = oldCounts?.memories
  items.push({
    name: '旧记忆库 memory.db',
    origin: originOf(join(home, 'memory')),
    path: oldP,
    type: 'file',
    size: oldSt?.size ?? null,
    mtime: oldSt?.mtimeMs ?? null,
    summary: oldMemories !== undefined ? `${oldMemories} 条记忆（dsh-mneme 已卸载，可删）` : '旧记忆库（dsh-mneme 已卸载，可删）',
    deletable: !!oldSt,
  })
  // 新 memento 库
  const newP = join(home, 'dsh-memento', 'memory.db')
  const newSt = await stat(newP).catch(() => null)
  const newCounts = newSt ? dbCounts(newP) : null
  const entries = newCounts ? (newCounts.entries ?? newCounts.memories) : undefined
  items.push({
    name: '审批记忆库 memory.db',
    origin: originOf(join(home, 'dsh-memento')),
    path: newP,
    type: 'file',
    size: newSt?.size ?? null,
    mtime: newSt?.mtimeMs ?? null,
    summary: newSt
      ? `${entries !== undefined ? entries + ' 条记忆' : '库已初始化'}（dsh-memento · 写入需你审批）`
      : '尚未初始化（重启 dsh 后生效）',
    deletable: !!newSt,
  })
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
    const known = { 'dsh-win-notify.log': '插件 dsh-win-notify · 通知运行日志' }
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
      origin: '插件 dsh-data-ledger · 回收站',
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

/** 只读参考组（只显示，不可删） */
async function collectReadonly(home) {
  const items = []
  const profilesP = join(home, 'profiles')
  const profilesSt = await stat(profilesP).catch(() => null)
  if (profilesSt) {
    const d = await du(profilesP)
    items.push({
      name: 'profiles（插件本体与配置）',
      origin: '官方 + 已装插件',
      path: profilesP,
      type: 'dir',
      size: d.bytes,
      approx: d.truncated,
      mtime: profilesSt.mtimeMs,
      summary: '程序文件，卸载插件走「dsh plugin remove」，勿手工删',
      deletable: false,
    })
  }
  // 凭据/身份文件：只显示名字与大小，永不显示内容
  let rootNames = []
  try { rootNames = await readdir(home) } catch { }
  for (const n of rootNames.sort()) {
    if (!n.startsWith('.')) continue
    const p = join(home, n)
    const st = await stat(p).catch(() => null)
    if (!st?.isFile()) continue
    items.push({
      name: n,
      origin: '官方 · 凭据/身份文件',
      path: p,
      type: 'file',
      size: st.size,
      mtime: st.mtimeMs,
      summary: '内容永不显示（防泄密），只展示位置与大小',
      deletable: false,
    })
  }
  // pnpm 缓存
  const pnpmP = join(process.env.LOCALAPPDATA || '', 'pnpm', 'store')
  const pnpmSt = await stat(pnpmP).catch(() => null)
  if (pnpmSt) {
    const d = await du(pnpmP)
    items.push({
      name: 'pnpm 依赖缓存',
      origin: '官方 · 包管理缓存',
      path: pnpmP,
      type: 'dir',
      size: d.bytes,
      approx: d.truncated,
      mtime: pnpmSt.mtimeMs,
      summary: '插件依赖下载缓存，可安全清理（重装插件会自动补齐）',
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
    { id: 'storages', title: '账本数据', items: storages },
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
