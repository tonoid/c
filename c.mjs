#!/usr/bin/env node
// c: one command to pick a Claude Code account, with usage at a glance.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const HOME = os.homedir()
// The name this is installed as (~/.local/bin/c). Every user-facing message
// reads from it, so renaming the symlink is a one-line change here.
const CMD = 'c'

const CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config')
export const DB = path.join(CONFIG_HOME, CMD, 'db.json')
const TTL = 60_000 // usage cache lifetime
// The usage endpoint allows about 5 calls per token per minute, and a running
// claude spends them on its own status line. After a 429, wait instead of
// asking again on the next `c`.
const BACKOFF = 5 * 60_000
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m', cya: '\x1b[36m', off: '\x1b[0m' }
  : new Proxy({}, { get: () => '' })

export const readJson = (f, fb = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return fb } }
const parse = (s, fb = null) => { try { return JSON.parse(s) } catch { return fb } }
const MAC = process.platform === 'darwin'

// ---------- credentials ----------
// Linux and WSL keep the OAuth token in <dir>/.credentials.json. macOS keeps it
// in the login keychain, so a Mac account is a config dir with no token file.
export const accountId = dir => path.basename(dir).replace(/^\.claude-?/, '') || 'main'

const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.status === 0 ? r.stdout : null }

// Listing attributes unlocks nothing, so this stays prompt-free and is worth
// doing once. Reading a secret below is what may raise the keychain dialog.
let cachedServices
export const keychainServices = (dump = () => sh('security', ['dump-keychain']) || '') =>
  (cachedServices ??= [...dump().matchAll(/"svce"<blob>="([^"]*)"/g)].map(m => m[1]).filter(s => /claude/i.test(s)))

// Only the item name says which account it belongs to, and Claude Code names it
// after the config dir rather than the account: "Claude Code-credentials" for a
// default ~/.claude, and that name with the first 8 hex of sha256(dir) appended
// for every other CLAUDE_CONFIG_DIR. The hash is authoritative, so it is tried
// first; the id-in-the-name match behind it keeps working for a build that
// spells the item out, and the lone-item guess covers a renamed default.
export const keychainSuffix = dir => createHash('sha256').update(dir).digest('hex').slice(0, 8)

// The item names that name THIS dir: the hash, or the id spelled into the name
// by a build that does that. Nothing here is a guess, which is what `remove`
// needs before it deletes anything.
export function ownKeychainService (dir, names = keychainServices()) {
  const id = accountId(dir)
  // The hash first: a login that was handed CLAUDE_CONFIG_DIR writes that name
  // even for ~/.claude, whose unsuffixed name is otherwise its own.
  const own = [`Claude Code-credentials-${keychainSuffix(dir)}`, ...(id === 'main' ? ['Claude Code-credentials'] : [])]
  return own.find(n => names.includes(n)) ||
    names.find(n => new RegExp(`(^|[^a-z0-9])${id.replace(/[^\w.-]/g, '')}([^a-z0-9]|$)`, 'i').test(n)) ||
    null
}

export function keychainService (dir, names = keychainServices()) {
  const own = ownKeychainService(dir, names)
  if (own || accountId(dir) !== 'main') return own
  // Reading tolerates a guess the default dir cannot spell out for itself.
  return names.find(n => /^claude code-credentials$/i.test(n)) || (names.length === 1 ? names[0] : null)
}

export function readCreds (dir) {
  const file = readJson(path.join(dir, '.credentials.json'))
  if (file || !MAC) return file
  const svc = keychainService(dir)
  const raw = svc && sh('security', ['find-generic-password', '-s', svc, '-w'])
  return raw ? parse(raw.trim()) : null
}

// Deleting a login is the one destructive thing here, so it takes an account
// discover() produced and refuses anything that is not a ~/.claude-<id> dir.
// A keychain item is only deleted when it names this dir: the read-side guess
// could belong to another account, and logging that one out is not recoverable.
export function removeAccount (acc, db, { file = DB, keychain = MAC } = {}) {
  if (!path.basename(acc.dir).startsWith('.claude-')) throw new Error(`refusing to remove ${acc.dir}`)
  const svc = keychain ? ownKeychainService(acc.dir) : null
  fs.rmSync(acc.dir, { recursive: true, force: true })
  if (svc) sh('security', ['delete-generic-password', '-s', svc])
  db.order = db.order.filter(id => id !== acc.id)
  delete db.usage[acc.id]
  saveDb(db, file)
  return svc
}

// ---------- db ----------
// Remembered claude flags. Each key is both the db field and the subcommand
// that toggles it, so adding another default is one line here.
export const FLAGS = {
  yolo: '--dangerously-skip-permissions',
  worktree: '--worktree'
}

export function loadDb (file = DB) {
  const db = readJson(file, {}) || {}
  db.order ??= []      // account ids, most recently used first
  db.yolo ??= true     // as the old cy/cys/cy2 aliases did
  db.worktree ??= false // a worktree per session is opt-in, as cw/cws/cw2 were
  db.usage ??= {}      // id -> { at, five, week, error }
  return db
}

// Flags the db turns on, minus any the caller already typed, so an explicit
// `--worktree` never sends the flag twice.
export const defaultFlags = (db, args = []) =>
  Object.entries(FLAGS).filter(([k]) => db[k]).map(([, f]) => f).filter(f => !args.includes(f))

function saveDb (db, file = DB) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(db, null, 2))
}

// ---------- accounts ----------
// Any ~/.claude* directory holding an account is one. Nothing to register: log
// in with CLAUDE_CONFIG_DIR pointed at a new one and it appears.
//
// The default config dir splits its account fields between ~/.claude/.claude.json
// and the legacy ~/.claude.json.
const oauthAccount = (dir, home) => ({
  ...(dir === path.join(home, '.claude') ? readJson(path.join(home, '.claude.json'), {})?.oauthAccount : null),
  ...readJson(path.join(dir, '.claude.json'), {})?.oauthAccount
})

// A token file proves an account without being required. On macOS the token
// sits in the keychain, so the profile of whoever logged in stands in for it.
export function loggedIn (dir, home = HOME) {
  if (fs.existsSync(path.join(dir, '.credentials.json'))) return true
  const acc = oauthAccount(dir, home)
  if (acc.accountUuid || acc.emailAddress) return true
  return MAC && !!keychainService(dir)
}

export function discover (home = HOME, order = []) {
  const accounts = fs.readdirSync(home, { withFileTypes: true })
    .filter(e => (e.isDirectory() || e.isSymbolicLink()) && (e.name === '.claude' || e.name.startsWith('.claude-')))
    .map(e => path.join(home, e.name))
    .filter(dir => loggedIn(dir, home))
    .map(dir => {
      const acc = oauthAccount(dir, home)
      return {
        id: accountId(dir),
        dir,
        name: acc.displayName || acc.emailAddress || path.basename(dir),
        email: acc.emailAddress || '',
        plan: planLabel(acc.organizationRateLimitTier)
      }
    })
  return sortByRecent(accounts, order)
}

export const planLabel = tier => (tier || '').replace(/^default_claude_/, '').replace(/_/g, ' ')

export function sortByRecent (accounts, order) {
  const rank = id => { const i = order.indexOf(id); return i === -1 ? Infinity : i }
  return [...accounts].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
}

// ---------- usage ----------
// One reading per account, shared with anything else that polls this endpoint
// for the same account (agent-loop, for one). It lives in the account's own
// config dir beside the credentials it was read with, so it is thrown away
// with the account and never outlives it. What we store is the endpoint's
// answer verbatim: readers want different parts of it (`five_hour` here,
// `limits[]` in agent-loop) and a raw body costs nobody a negotiation.
export const cachePath = dir => path.join(dir, 'cache', 'usage.json')

export function readCache (dir, now = Date.now()) {
  const c = readJson(cachePath(dir))
  if (!c?.at) return null
  return now - c.at < (c.status === 429 ? BACKOFF : TTL) ? c : null
}

export function writeCache (dir, entry) {
  const p = cachePath(dir)
  // Unique per writer: two processes reading the same account in the same
  // second must not rename over each other's half-written file.
  const tmp = `${p}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 })
    fs.renameSync(tmp, p)
  } catch {
    // A cache we cannot write is a slow day, not a failure.
    try { fs.unlinkSync(tmp) } catch {}
  }
}

// A 429 here is the metering endpoint's own burst budget (about 5 calls per
// token per minute), not the account being out of quota. Quota exhaustion
// arrives as a 200 with the windows at 100%.
export function usageFrom ({ at, status, body }) {
  if (status === 401) return { at, error: 'logged out' }
  if (status === 429) return { at, error: 'rate limited' }
  if (status !== 200) return { at, error: `http ${status}` }
  const slice = w => w ? { pct: Math.round(w.utilization ?? 0), resets: w.resets_at } : null
  return { at, five: slice(body?.five_hour), week: slice(body?.seven_day) }
}

export async function fetchUsage (dir, now = Date.now()) {
  const token = readCreds(dir)?.claudeAiOauth?.accessToken
  if (!token) return { at: now, error: 'no token' }

  const hit = readCache(dir, now)
  if (hit) return usageFrom(hit)

  let entry
  try {
    const r = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(8000)
    })
    entry = { at: now, status: r.status, body: r.status === 200 ? await r.json() : null }
  } catch (e) {
    // Nothing to share: a timeout is this box's problem, not the endpoint's.
    return { at: now, error: e.name === 'TimeoutError' ? 'timeout' : 'offline' }
  }
  // Never cache a 401: it is a fact about this access token, not about the
  // account, and agent-loop refreshes and retries the moment it sees one.
  if (entry.status !== 401) writeCache(dir, entry)
  return usageFrom(entry)
}

// A failed refresh keeps the last numbers we did get, flagged stale, so one 429
// does not blank a row that was fine a minute ago.
export function mergeUsage (prev, next) {
  if (!next.error || !prev || prev.error) return next
  return { ...prev, at: next.at, stale: next.error }
}

const expired = u => Date.now() - u.at > (u.error === 'rate limited' || u.stale === 'rate limited' ? BACKOFF : TTL)

async function refresh (accounts, db, force = false) {
  const stale = accounts.filter(a => force || !db.usage[a.id] || expired(db.usage[a.id]))
  if (!stale.length) return
  const got = await Promise.all(stale.map(a => fetchUsage(a.dir)))
  stale.forEach((a, i) => { db.usage[a.id] = mergeUsage(db.usage[a.id], got[i]) })
  saveDb(db)
}

// ---------- rendering ----------
export function until (iso, now = Date.now()) {
  if (!iso) return '-'
  const ms = new Date(iso) - now
  if (Number.isNaN(ms)) return '-'
  if (ms <= 0) return 'now'
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24)
  if (d) return `${d}d ${h % 24}h`
  if (h) return `${h}h ${m % 60}m`
  return `${m}m`
}

const pct = w => {
  if (!w) return `${C.dim}   -${C.off}`
  const s = String(w.pct).padStart(3) + '%'
  return `${w.pct >= 80 ? C.red : w.pct >= 50 ? C.yel : C.grn}${s}${C.off}`
}

// Each window prints its own reset, padded to the widest value `until` makes
// ("2h 27m"), so the week column lines up under its header.
const resets = w => `${C.dim}${until(w?.resets).padEnd(6)}${C.off}`

export function table (accounts, usage = {}, { selectable = false, cursor = 0 } = {}) {
  const w = Math.max(7, ...accounts.map(a => a.name.length))
  const p = Math.max(4, ...accounts.map(a => (a.plan || '?').length))
  const rows = [`   ${C.dim}${'account'.padEnd(w)}  ${'plan'.padEnd(p)}    5h  resets   week  resets${C.off}`]
  accounts.forEach((a, i) => {
    const u = usage[a.id] || {}
    const mark = i === cursor ? `${C.cya}→${C.off}` : ' '
    const num = selectable ? `${C.dim}${i + 1}${C.off}` : ' '
    const right = u.error
      ? `${C.red}${u.error}${C.off}`
      : `${pct(u.five)}  ${resets(u.five)}   ${pct(u.week)}  ${resets(u.week)}${u.stale ? ` ${C.dim}~${C.off}` : ''}`
    rows.push(`${mark}${num} ${C.bold}${a.name.padEnd(w)}${C.off}  ${C.dim}${(a.plan || '?').padEnd(p)}${C.off}  ${right}`.trimEnd())
  })
  return rows.join('\n')
}

// ---------- launching claude ----------
const claudeBin = () => {
  const local = path.join(HOME, '.local/bin/claude')
  return fs.existsSync(local) ? local : 'claude'
}

const run = (dir, args) =>
  spawn(claudeBin(), args, { stdio: 'inherit', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } })
    .on('error', e => { console.error(`${CMD}: cannot run claude (${e.code || e.message})`); process.exit(127) })
    .on('exit', code => process.exit(code ?? 0))

function launch (acc, args, db) {
  db.order = [acc.id, ...db.order.filter(id => id !== acc.id)]
  saveDb(db)
  run(acc.dir, [...defaultFlags(db, args), ...args])
}

// ---------- menu ----------
function menu (accounts, db) {
  return new Promise(resolve => {
    const tty = process.stdout.isTTY
    let cursor = 0
    let drawn = 0 // lines the last draw left above the terminal cursor
    // Redraw in place: step back over the block we drew last and clear from
    // there, so a keystroke updates the menu instead of scrolling a new copy.
    // ponytail: assumes the footer fits one terminal line; a window narrow
    // enough to wrap it leaves a stale line behind. Shorten the hints then.
    const draw = (note = '') => {
      if (drawn && tty) process.stdout.write(`\x1b[${drawn}A\r\x1b[J`)
      const flag = (k, label) => `${C.dim}${label} ${db[k] ? `${C.grn}on` : `${C.red}off`}${C.off}`
      const foot = note
        ? `${C.dim}${note}${C.off}`
        : `${flag('yolo', 'yolo')} ${C.dim}·${C.off} ${flag('worktree', 'worktree')}${C.dim}  ·  [enter] ${accounts[cursor].name}   ↑↓ move   1-${accounts.length} pick   y yolo   w worktree   r refresh   q quit${C.off} `
      process.stdout.write('\n' + table(accounts, db.usage, { selectable: true, cursor }) + '\n\n  ' + foot)
      drawn = accounts.length + 3
    }
    if (tty) process.stdout.write('\x1b[?25l')
    draw()
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    const done = v => {
      process.stdin.setRawMode?.(false)
      process.stdin.pause()
      process.stdout.write(tty ? '\x1b[?25h\n' : '\n')
      resolve(v)
    }
    process.stdin.on('data', async key => {
      // Arrows arrive as a whole escape sequence, so a bare \x1b is still quit.
      if (key === '\x1b[A' || key === '\x1b[B') {
        cursor = (cursor + (key === '\x1b[A' ? accounts.length - 1 : 1)) % accounts.length
        return draw()
      }
      if (key === '\r' || key === '\n') return done(accounts[cursor])
      if (key === 'q' || key === '\x03' || key === '\x1b') return done(null)
      if (key === 'y' || key === 'w') {
        const k = key === 'y' ? 'yolo' : 'worktree'
        db[k] = !db[k]
        saveDb(db)
        return draw()
      }
      if (key === 'r') { draw('refreshing...'); await refresh(accounts, db, true); return draw() }
      const n = Number(key)
      if (n >= 1 && n <= accounts.length) return done(accounts[n - 1])
    })
  })
}

// ---------- prompting ----------
// One keypress, no readline: raw mode is already how the menu reads stdin, so
// this keeps the file dependency-free. Raw mode does not echo, hence the write.
// Trimmed, because the keypress is not always the bare letter: a pty forwarding
// a piped answer appends CR, and comparing the raw chunk reads that as a no.
export const isYes = key => String(key).trim().toLowerCase() === 'y'

const confirm = question => new Promise(resolve => {
  process.stdout.write(question)
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  process.stdin.once('data', key => {
    process.stdin.setRawMode?.(false)
    process.stdin.pause()
    process.stdout.write(`${key.trim()}\n`)
    resolve(isYes(key))
  })
})

const findAccount = (accounts, want) => {
  const w = String(want ?? '').toLowerCase()
  return accounts.find(a => a.id.toLowerCase() === w || a.name.toLowerCase() === w) || null
}

// ---------- cli ----------
const pad = s => s.padEnd(20 + CMD.length)
const HELP = `${CMD}: one command for several Claude Code accounts

  ${pad(CMD)}pick an account (usage table, enter = last used)
  ${pad(CMD + ' <args...>')}launch the last-used account, args go to claude
  ${pad(CMD + ' -a <id> [args]')}launch a specific account
  ${pad(CMD + ' status')}show the usage table and exit
  ${pad(CMD + ' add <id>')}log in to a new account in ~/.claude-<id>
  ${pad(CMD + ' remove <id>')}delete ~/.claude-<id> and the keychain item it owns
  ${pad(CMD + ' yolo [on|off]')}toggle the --dangerously-skip-permissions default
  ${pad(CMD + ' worktree [on|off]')}toggle the --worktree default (a git worktree per session)
  ${CMD} version
  ${CMD} help

A prompt that collides with a subcommand goes through -a, e.g. ${CMD} -a main status.
State lives in ${DB.replace(HOME, '~')}`

async function main (argv) {
  const db = loadDb()

  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP)
    return
  }

  if (argv[0] === 'version') {
    console.log(readJson(fileURLToPath(new URL('./package.json', import.meta.url)), {}).version || 'dev')
    return
  }

  if (argv[0] === 'add') {
    const id = argv[1]
    if (!id || !/^[\w.-]+$/.test(id)) { console.error(`usage: ${CMD} add <id>   e.g. ${CMD} add work`); process.exit(1) }
    const dir = path.join(HOME, id === 'main' ? '.claude' : `.claude-${id}`)
    if (loggedIn(dir)) {
      console.error(`${CMD}: ${dir.replace(HOME, '~')} is already logged in (${CMD} -a ${id})`)
      process.exit(1)
    }
    fs.mkdirSync(dir, { recursive: true })
    console.log(`Logging in to ${dir.replace(HOME, '~')}. It joins the list once done.\n`)
    run(dir, ['auth', 'login'])
    return new Promise(() => {}) // run() exits this process once claude is done
  }

  const accounts = discover(HOME, db.order)
  if (!accounts.length) {
    console.error(`${CMD}: no logged-in ~/.claude* config dirs found, run \`${CMD} add <id>\``)
    process.exit(1)
  }

  if (argv[0] === 'status' || argv[0] === 'ls') {
    await refresh(accounts, db)
    console.log('\n' + table(accounts, db.usage) + `\n\n  ${C.dim}yolo ${db.yolo ? 'on' : 'off'}  ·  worktree ${db.worktree ? 'on' : 'off'}  ·  default ${accounts[0].name}${C.off}\n`)
  } else if (Object.hasOwn(FLAGS, argv[0] ?? '')) {
    const k = argv[0]
    db[k] = argv[1] ? argv[1] === 'on' : !db[k]
    saveDb(db)
    console.log(`${k} ${db[k] ? `on (${FLAGS[k]})` : 'off'}`)
  } else if (argv[0] === 'remove' || argv[0] === 'rm') {
    const yes = argv.includes('--yes') || argv.includes('-y')
    const id = argv.slice(1).find(a => a !== '--yes' && a !== '-y')
    if (!id) { console.error(`usage: ${CMD} remove <id>   e.g. ${CMD} remove work`); process.exit(1) }
    const acc = findAccount(accounts, id)
    if (!acc) { console.error(`${CMD}: no account "${id}" (have: ${accounts.map(a => a.id).join(', ')})`); process.exit(1) }
    // ~/.claude is not just a login: settings, projects and history live there.
    if (acc.id === 'main') {
      console.error(`${CMD}: won't delete ${acc.dir.replace(HOME, '~')}, it holds your settings, projects and history and not only a login. Log out from inside claude instead.`)
      process.exit(1)
    }
    const svc = MAC ? ownKeychainService(acc.dir) : null
    console.log(`\n  ${C.bold}${acc.name}${C.off} ${C.dim}(${acc.id})${C.off}\n  ${acc.dir.replace(HOME, '~')}`)
    console.log(svc ? `  keychain item ${svc}` : MAC ? `  ${C.yel}no keychain item names this dir, anything it left stays${C.off}` : '')
    if (!yes) {
      if (!process.stdin.isTTY) { console.error(`${CMD}: not a terminal, pass --yes to remove ${acc.id}`); process.exit(1) }
      if (!await confirm(`  delete it? [y/N] `)) { console.log('nothing removed'); return }
    }
    removeAccount(acc, db)
    console.log(`removed ${acc.id}`)
  } else if (argv[0] === '-a' || argv[0] === '--account') {
    const acc = findAccount(accounts, argv[1])
    if (!acc) { console.error(`${CMD}: no account "${argv[1]}" (have: ${accounts.map(a => a.id).join(', ')})`); process.exit(1) }
    launch(acc, argv.slice(2), db)
  } else if (argv.length) {
    launch(accounts[0], argv, db)
  } else {
    await refresh(accounts, db)
    const picked = await menu(accounts, db)
    if (picked) launch(picked, [], db)
  }
}

// Compare real paths: argv[1] keeps the symlink it was invoked through
// (~/.local/bin/c) while import.meta.url is already resolved, and a
// plain string compare would silently skip main() on every installed run.
const invokedAs = () => { try { return fs.realpathSync(process.argv[1] ?? '') } catch { return '' } }
if (invokedAs() === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
