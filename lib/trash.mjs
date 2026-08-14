// 数据台账 · 回收站模块（零 DSH 依赖，可独立测试）
// 删除 = 移动进回收站（~/.dsh/trash/<时间戳>-<原名>/），30 天可恢复。
import { mkdir, readFile, rename, rm, appendFile, stat, realpath } from 'node:fs/promises'
import { join, resolve, sep, basename, extname } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/** 可删除的数据根（除根目录 *.log 外，其余只允许这些根之内） */
function dataRoots(home) {
  return [
    join(home, 'sessions'),
    join(home, 'storages'),
    join(home, 'skills'),
    join(home, 'memory'),
    join(home, 'dsh-memento'),
    join(home, 'trash'),
  ]
}

/** 路径校验：只允许白名单内的真实路径；恢复场景传 { allowMissing: true }（校验父目录） */
export async function validateDeletable(home, p, opts = {}) {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, error: '路径为空' }
  if (p.includes('\0')) return { ok: false, error: '非法路径' }
  const abs = resolve(p)
  if (abs === home) return { ok: false, error: '不允许删除 DSH 主目录本身' }
  // 根目录日志文件例外（仅 *.log 且直接位于 home 下）
  const isRootLog = abs.startsWith(home + sep) && !abs.slice(home.length + 1).includes(sep) && extname(abs) === '.log'
  if (!isRootLog) {
    let inside = false
    for (const root of dataRoots(home)) {
      if (abs === root) return { ok: false, error: '不允许删除整个数据区根目录' }
      if (abs.startsWith(root + sep)) { inside = true; break }
    }
    if (!inside) return { ok: false, error: `不在允许删除的范围内: ${abs}` }
  }
  // 真实路径复核（防符号链接逃逸）
  const rh = await realpath(home)
  const insideRealRoots = async (rp) => {
    if (!(rp === rh || rp.startsWith(rh + sep))) return false
    if (isRootLog) return true
    for (const root of dataRoots(home)) {
      let rr
      try { rr = await realpath(root) } catch { continue }
      if (rp === rr || rp.startsWith(rr + sep)) return true
    }
    return false
  }
  let rp
  try { rp = await realpath(abs) } catch { rp = null }
  if (!rp) {
    if (!opts.allowMissing) return { ok: false, error: '路径不存在' }
    try { rp = await realpath(dirname(abs)) } catch { return { ok: false, error: '路径不存在' } }
  }
  if (!(await insideRealRoots(rp))) return { ok: false, error: '真实路径越出白名单，已拒绝' }
  return { ok: true, abs, rp }
}
const dirname = (p) => p.slice(0, p.lastIndexOf(sep)) || sep

/** 写入操作日志（JSONL） */
export async function appendAction(home, action) {
  try {
    const dir = join(home, 'storages')
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, 'data-ledger-actions.log'), JSON.stringify({ ts: Date.now(), ...action }) + '\n')
  } catch { /* 日志失败不影响主操作 */ }
}

/** 移入回收站 */
export async function moveToTrash(home, p) {
  const v = await validateDeletable(home, p)
  if (!v.ok) return { ok: false, error: v.error }
  const trashDir = join(home, 'trash')
  await mkdir(trashDir, { recursive: true })
  const base = basename(v.abs)
  let entryDir = join(trashDir, `${Date.now()}-${base}`)
  let i = 1
  while (existsSync(entryDir)) entryDir = join(trashDir, `${Date.now()}-${base}-${i++}`)
  await mkdir(entryDir)
  await rename(v.abs, join(entryDir, base))
  await appendFile(join(entryDir, 'meta.json'), JSON.stringify({ originalPath: v.abs, deletedAt: Date.now() }))
  await appendAction(home, { action: 'delete', from: v.abs, to: entryDir })
  return { ok: true, trashPath: entryDir }
}

/** 从回收站恢复 */
export async function restoreFromTrash(home, trashPath) {
  const abs = resolve(trashPath)
  const trashDir = join(home, 'trash')
  if (!abs.startsWith(trashDir + sep) || abs.slice(trashDir.length + 1).includes(sep))
    return { ok: false, error: '只能恢复回收站顶层条目' }
  let meta
  try { meta = JSON.parse(await readFile(join(abs, 'meta.json'), 'utf8')) } catch { return { ok: false, error: '找不到 meta.json，无法恢复' } }
  const orig = meta.originalPath
  const v = await validateDeletable(home, orig, { allowMissing: true })
  if (!v.ok) return { ok: false, error: '原位置已不在白名单: ' + v.error }
  const base = basename(orig)
  let target = orig
  if (existsSync(target)) target = join(dirnameOf(orig), `${Date.now()}-${base}`)
  await rename(join(abs, base), target)
  await rm(abs, { recursive: true, force: true })
  await appendAction(home, { action: 'restore', from: abs, to: target })
  return { ok: true, restoredPath: target }
}
const dirnameOf = (p) => p.slice(0, p.lastIndexOf(sep)) || sep

/** 彻底删除回收站条目（真删，需用户双重确认后才会被调用） */
export async function purgeTrash(home, trashPath) {
  const abs = resolve(trashPath)
  const trashDir = join(home, 'trash')
  if (!abs.startsWith(trashDir + sep) || abs.slice(trashDir.length + 1).includes(sep))
    return { ok: false, error: '只能清空回收站顶层条目' }
  await rm(abs, { recursive: true, force: true })
  await appendAction(home, { action: 'purge', path: abs })
  return { ok: true }
}

/** 打开资源管理器定位（仅 Windows；允许 home 子树与 pnpm 缓存） */
export async function openInExplorer(home, p) {
  if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows' }
  const abs = resolve(p)
  let allowed = false
  try {
    const rp = await realpath(abs)
    const rh = await realpath(home)
    if (rp === rh || rp.startsWith(rh + sep)) allowed = true
    else {
      const pnpm = join(process.env.LOCALAPPDATA || '', 'pnpm', 'store')
      const rpn = await realpath(pnpm)
      if (rp === rpn || rp.startsWith(rpn + sep)) allowed = true
    }
  } catch { return { ok: false, error: '路径不存在' } }
  if (!allowed) return { ok: false, error: '只允许定位 DSH 数据目录内的路径' }
  const { spawn } = await import('node:child_process')
  const child = spawn('explorer.exe', [`/select,${abs}`], { detached: true, stdio: 'ignore' })
  child.unref()
  return { ok: true }
}
