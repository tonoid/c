// Zero-dependency test suite: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { until, planLabel, sortByRecent, discover, table, loadDb, fetchUsage, mergeUsage, usageFrom, readCache, writeCache, cachePath, defaultFlags, keychainService, keychainSuffix, ownKeychainService, removeAccount, isYes } from '../c.mjs'

const CLI = fileURLToPath(new URL('../c.mjs', import.meta.url))
const NOW = Date.parse('2026-08-19T12:00:00Z')

// Run the CLI and capture stdout/stderr/status without throwing.
function cli (args, env = {}, entry = CLI) {
  try {
    return { status: 0, out: execFileSync(process.execPath, [entry, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }) }
  } catch (e) {
    return { status: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }
  }
}

// A throwaway HOME with fake config dirs, so discovery is tested against
// a known layout rather than whatever accounts the developer happens to have.
function fakeHome (accounts) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c-test-'))
  for (const [dirName, oauth] of Object.entries(accounts)) {
    const dir = path.join(home, dirName)
    fs.mkdirSync(dir, { recursive: true })
    if (oauth !== null) fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }))
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: oauth ?? {} }))
  }
  return home
}

test('until formats the gap in the largest two units', () => {
  assert.equal(until('2026-08-19T12:41:00Z', NOW), '41m')
  assert.equal(until('2026-08-19T14:27:00Z', NOW), '2h 27m')
  assert.equal(until('2026-08-26T15:00:00Z', NOW), '7d 3h')
  assert.equal(until('2026-08-19T13:00:00Z', NOW), '1h 0m')
})

test('until degrades instead of printing NaN', () => {
  assert.equal(until(null, NOW), '-')
  assert.equal(until('not a date', NOW), '-')
  assert.equal(until('2026-08-19T11:00:00Z', NOW), 'now', 'a window already past reads as now, never negative')
})

test('planLabel strips the internal tier prefix', () => {
  assert.equal(planLabel('default_claude_max_20x'), 'max 20x')
  assert.equal(planLabel('default_claude_pro'), 'pro')
  assert.equal(planLabel(undefined), '')
})

test('sortByRecent puts the last-used account first, unknowns alphabetically last', () => {
  const accounts = [{ id: 'work' }, { id: 'main' }, { id: 'team' }]
  assert.deepEqual(sortByRecent(accounts, ['team', 'main']).map(a => a.id), ['team', 'main', 'work'])
  assert.deepEqual(sortByRecent(accounts, []).map(a => a.id), ['main', 'team', 'work'])
})

test('sortByRecent does not mutate its input', () => {
  const accounts = [{ id: 'b' }, { id: 'a' }]
  sortByRecent(accounts, ['a'])
  assert.deepEqual(accounts.map(a => a.id), ['b', 'a'])
})

test('discover finds credentialed dirs only, and never the default-dir sibling caches', () => {
  const home = fakeHome({
    '.claude': { displayName: 'personal' },
    '.claude-work': { displayName: 'Work', organizationRateLimitTier: 'default_claude_max_5x' },
    '.claude-mem': null // a plugin cache dir: no credentials, not an account
  })
  const found = discover(home, [])
  assert.deepEqual(found.map(a => a.id), ['main', 'work'])
  assert.equal(found[1].plan, 'max 5x')
})

test('discover falls back to the legacy ~/.claude.json for the default dir', () => {
  const home = fakeHome({ '.claude': { displayName: 'personal' } })
  // The tier lives only in the legacy file for the default config dir.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationRateLimitTier: 'default_claude_max_20x' } }))
  const [acc] = discover(home, [])
  assert.equal(acc.name, 'personal', 'the per-dir file still wins for fields it has')
  assert.equal(acc.plan, 'max 20x', 'and the legacy file fills in the ones it does not')
})

test('discover keeps an account whose token lives outside the config dir', () => {
  // macOS: the token is in the login keychain, so there is no .credentials.json.
  const home = fakeHome({ '.claude-mac': null })
  fs.writeFileSync(path.join(home, '.claude-mac', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }))
  assert.deepEqual(discover(home, []).map(a => a.id), ['mac'])
})

test('keychainService matches an item to the config dir it belongs to', () => {
  const names = ['Claude Code-credentials', 'Claude Code-credentials-work']
  assert.equal(keychainService('/home/u/.claude-work', names), 'Claude Code-credentials-work')
  assert.equal(keychainService('/home/u/.claude', names), 'Claude Code-credentials', 'the unnamed item is the default dir')
  assert.equal(keychainService('/home/u/.claude-team', names), null, 'no guessing for an account with no item')
  assert.equal(keychainService('/home/u/.claude', ['Claude Code']), 'Claude Code', 'a lone claude item is the default dir whatever it is called')
})

test('keychainService prefers the hash of the config dir over the account id', () => {
  // What Claude Code actually writes: the item is named for the dir it was told
  // to use, so the id never appears and only the hash finds it.
  const dir = '/home/u/.claude-work'
  const hashed = `Claude Code-credentials-${keychainSuffix(dir)}`
  assert.equal(keychainSuffix(dir).length, 8)
  assert.equal(keychainService(dir, [hashed]), hashed, 'an id-less item still resolves')
  assert.equal(
    keychainService(dir, ['Claude Code-credentials-work', hashed]),
    hashed,
    'the hash wins over a same-named item belonging to another dir'
  )
  assert.notEqual(keychainSuffix(dir), keychainSuffix('/other/.claude-work'), 'the same id under a different home hashes apart')
})

test('ownKeychainService never falls back to an item that names another dir', () => {
  // keychainService may guess for the default dir, because reading the wrong
  // token only misreports usage. remove deletes, so it gets the strict one.
  const dir = '/home/u/.claude'
  assert.equal(keychainService(dir, ['Claude Code']), 'Claude Code', 'reading takes the lone item')
  assert.equal(ownKeychainService(dir, ['Claude Code']), null, 'deleting does not')
  assert.equal(ownKeychainService(dir, ['Claude Code-credentials']), 'Claude Code-credentials', 'the default name is still its own')
})

test('isYes reads a keypress that carries a line ending', () => {
  for (const yes of ['y', 'Y', 'y\r', 'y\n', ' y ']) assert.equal(isYes(yes), true, JSON.stringify(yes))
  for (const no of ['n', '\r', '', 'yes please', 'q']) assert.equal(isYes(no), false, JSON.stringify(no))
})

test('removeAccount deletes the dir and forgets the account', () => {
  const home = fakeHome({ '.claude-work': { displayName: 'Work' }, '.claude-keep': { displayName: 'Keep' } })
  const file = path.join(home, 'db.json')
  const db = { order: ['work', 'keep'], usage: { work: { at: 1 }, keep: { at: 2 } } }
  const [work] = discover(home, []).filter(a => a.id === 'work')

  removeAccount(work, db, { file, keychain: false })

  assert.equal(fs.existsSync(work.dir), false, 'the config dir is gone')
  assert.deepEqual(discover(home, []).map(a => a.id), ['keep'], 'and it stops being discovered')
  assert.deepEqual(db.order, ['keep'], 'the recency list drops it')
  assert.deepEqual(Object.keys(db.usage), ['keep'], 'so does the usage cache')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).order, ['keep'], 'and the db on disk is written')
})

test('removeAccount refuses a directory that is not an account', () => {
  const home = fakeHome({ '.claude-work': { displayName: 'Work' } })
  const notAnAccount = { id: 'x', dir: path.join(home, '.ssh') }
  fs.mkdirSync(notAnAccount.dir, { recursive: true })
  assert.throws(() => removeAccount(notAnAccount, loadDb(path.join(home, 'db.json')), { file: path.join(home, 'db.json'), keychain: false }), /refusing to remove/)
  assert.equal(fs.existsSync(notAnAccount.dir), true, 'and leaves it alone')
})

test('remove will not delete the default ~/.claude', () => {
  const home = fakeHome({ '.claude': { displayName: 'Main' } })
  const r = cli(['remove', 'main'], { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') })
  assert.equal(r.status, 1)
  assert.match(r.out, /settings, projects and history/)
  assert.equal(fs.existsSync(path.join(home, '.claude')), true)
})

test('remove needs a terminal or an explicit --yes', () => {
  const home = fakeHome({ '.claude-work': { displayName: 'Work' } })
  const r = cli(['remove', 'work'], { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') })
  assert.equal(r.status, 1, 'a piped run must not delete on its own')
  assert.match(r.out, /pass --yes/)
  assert.equal(fs.existsSync(path.join(home, '.claude-work')), true, 'the account survives the refusal')
})

test('remove --yes deletes without asking', () => {
  const home = fakeHome({ '.claude-work': { displayName: 'Work' }, '.claude-keep': { displayName: 'Keep' } })
  const r = cli(['remove', 'work', '--yes'], { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') })
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /removed work/)
  assert.equal(fs.existsSync(path.join(home, '.claude-work')), false)
  assert.equal(fs.existsSync(path.join(home, '.claude-keep')), true, 'only the named account goes')
})

test('discover labels an account with no profile yet', () => {
  const home = fakeHome({ '.claude-fresh': {} })
  assert.deepEqual(discover(home, []).map(a => a.name), ['.claude-fresh'])
})

test('table aligns every column, including a row whose usage failed', () => {
  const accounts = [{ id: 'a', name: 'personal', plan: 'max 20x' }, { id: 'b', name: 'work', plan: 'max 5x' }]
  const usage = {
    a: { five: { pct: 9, resets: '2026-08-19T14:00:00Z' }, week: { pct: 91, resets: '2026-08-26T15:00:00Z' } },
    b: { error: 'logged out' }
  }
  const lines = table(accounts, usage).split('\n')
  assert.equal(lines.length, 3)
  assert.equal(lines[0].indexOf('5h') + 1, lines[1].indexOf('9%') + 1, 'the 5h header sits over the 5h number')
  assert.equal(lines[0].indexOf('week') + 3, lines[1].indexOf('91%') + 2, 'the week header sits over the week number')
  assert.match(lines[2], /logged out/)
})

test('table shows a reset per window, not just the 5h one', () => {
  const accounts = [{ id: 'a', name: 'personal', plan: 'max 20x' }]
  // table() reads the real clock, so the fixture has to stay in the future or
  // both windows render as "now" and the two columns stop being tellable apart.
  const ahead = ms => new Date(Date.now() + ms).toISOString()
  const usage = { a: { five: { pct: 9, resets: ahead(2 * 3600e3) }, week: { pct: 91, resets: ahead(5 * 86400e3) } } }
  const [head, row] = table(accounts, usage).split('\n')
  assert.equal(head.match(/resets/g).length, 2, 'one resets header per window')
  // Both reset headers sit at or left of their value, and in window order.
  const fiveAt = row.indexOf(until(usage.a.five.resets))
  const weekAt = row.indexOf(until(usage.a.week.resets))
  assert.ok(fiveAt > row.indexOf('9%') && fiveAt < row.indexOf('91%'), '5h reset sits between the two percentages')
  assert.ok(weekAt > row.indexOf('91%'), 'week reset sits after the week percentage')
})

test('table points the arrow at the cursor row, not always the first', () => {
  const accounts = [{ id: 'a', name: 'personal' }, { id: 'b', name: 'work' }, { id: 'c', name: 'team' }]
  const rowFor = cursor => table(accounts, {}, { cursor }).split('\n').findIndex(l => l.includes('\u2192'))
  assert.equal(rowFor(0), 1, 'row 1 is the first account, row 0 is the header')
  assert.equal(rowFor(2), 3)
  assert.equal(table(accounts, {}).split('\n').findIndex(l => l.includes('\u2192')), 1, 'no cursor given still marks the most-recent account')
})

test('table survives an account it has no cached usage for', () => {
  const out = table([{ id: 'a', name: 'personal', plan: 'pro' }], {})
  assert.match(out, /personal/)
  assert.doesNotMatch(out, /undefined|NaN/)
})

test('loadDb defaults to yolo on, worktree off, and an empty history', () => {
  const db = loadDb(path.join(os.tmpdir(), 'c-does-not-exist.json'))
  assert.equal(db.yolo, true)
  assert.equal(db.worktree, false)
  assert.deepEqual(db.order, [])
  assert.deepEqual(db.usage, {})
})

test('defaultFlags turns db toggles into claude flags', () => {
  assert.deepEqual(defaultFlags({ yolo: false, worktree: false }), [])
  assert.deepEqual(defaultFlags({ yolo: true, worktree: false }), ['--dangerously-skip-permissions'])
  assert.deepEqual(defaultFlags({ yolo: true, worktree: true }), ['--dangerously-skip-permissions', '--worktree'])
})

test('defaultFlags never doubles a flag the caller already typed', () => {
  const db = { yolo: true, worktree: true }
  assert.deepEqual(defaultFlags(db, ['--worktree']), ['--dangerously-skip-permissions'])
  assert.deepEqual(defaultFlags(db, ['--worktree', '--dangerously-skip-permissions']), [])
})

test('fetchUsage reports a missing token rather than throwing', async () => {
  const res = await fetchUsage(fs.mkdtempSync(path.join(os.tmpdir(), 'c-empty-')), NOW)
  assert.equal(res.error, 'no token')
})

test('help and version exit clean', () => {
  const help = cli(['help'])
  assert.equal(help.status, 0)
  assert.match(help.out, /Claude Code accounts/)
  assert.match(help.out, /c add <id>/)

  const version = cli(['version'])
  assert.equal(version.status, 0)
  assert.match(version.out.trim(), /^\d+\.\d+\.\d+/)
})

test('runs through a symlink, the way an installed c is invoked', () => {
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c-bin-')), 'c')
  fs.symlinkSync(CLI, bin)
  const r = cli(['help'], {}, bin)
  assert.equal(r.status, 0)
  assert.match(r.out, /Claude Code accounts/, 'a symlinked entry point must still reach main()')
})

test('add refuses a name that is not a safe directory segment', () => {
  for (const bad of ['', 'x y', '../escape', 'a/b']) {
    const r = cli(['add', bad])
    assert.equal(r.status, 1, `"${bad}" must be rejected`)
    assert.match(r.out, /usage: c add/)
  }
})

test('add refuses an account that is already logged in', () => {
  const home = fakeHome({ '.claude-work': { displayName: 'Work' } })
  const r = cli(['add', 'work'], { HOME: home })
  assert.equal(r.status, 1)
  assert.match(r.out, /already logged in/)
})

test('-a rejects an unknown account and lists the real ones', () => {
  const home = fakeHome({ '.claude-work': { displayName: 'Work' } })
  const r = cli(['-a', 'nope'], { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') })
  assert.equal(r.status, 1)
  assert.match(r.out, /no account "nope"/)
  assert.match(r.out, /have: work/)
})

test('a home with no logged-in dirs points at the fix instead of crashing', () => {
  const home = fakeHome({ '.claude-mem': null })
  const r = cli(['status'], { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') })
  assert.equal(r.status, 1)
  assert.match(r.out, /c add <id>/)
})

test('a failed refresh keeps the last good numbers, flagged stale', () => {
  const good = { at: 1, five: { pct: 9, resets: 'x' }, week: { pct: 30, resets: 'y' } }
  const limited = { at: 2, error: 'rate limited' }

  assert.deepEqual(mergeUsage(good, limited), { ...good, at: 2, stale: 'rate limited' })
  assert.deepEqual(mergeUsage(undefined, limited), limited)        // nothing to keep
  assert.deepEqual(mergeUsage({ at: 1, error: 'logged out' }, limited), limited)
  assert.deepEqual(mergeUsage(good, { at: 3, five: null }), { at: 3, five: null })
})

test('usage is read from whatever the endpoint said, not a shape we invented', () => {
  const body = { five_hour: { utilization: 3.4, resets_at: 'a' }, seven_day: { utilization: 39, resets_at: 'b' } }
  assert.deepEqual(usageFrom({ at: 7, status: 200, body }), {
    at: 7, five: { pct: 3, resets: 'a' }, week: { pct: 39, resets: 'b' }
  })
  assert.equal(usageFrom({ at: 7, status: 429 }).error, 'rate limited')
  assert.equal(usageFrom({ at: 7, status: 401 }).error, 'logged out')
  assert.equal(usageFrom({ at: 7, status: 500 }).error, 'http 500')
  // A window that has never started is absent, not zero.
  assert.deepEqual(usageFrom({ at: 7, status: 200, body: {} }), { at: 7, five: null, week: null })
})

test('the usage cache lives in the account dir and expires, 429s for longer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-cache-'))
  const at = Date.now()

  assert.equal(readCache(dir, at), null, 'no cache yet')

  writeCache(dir, { at, status: 200, body: { five_hour: { utilization: 3 } } })
  assert.equal(cachePath(dir), path.join(dir, 'cache', 'usage.json'), 'beside the credentials it was read with')
  assert.equal(readCache(dir, at + 30_000)?.status, 200, 'fresh enough to reuse')
  assert.equal(readCache(dir, at + 90_000), null, 'a minute old, ask again')

  writeCache(dir, { at, status: 429 })
  assert.equal(readCache(dir, at + 90_000)?.status, 429, 'a 429 holds us off past the normal TTL')
  assert.equal(readCache(dir, at + 6 * 60_000), null, 'but not forever')

  fs.writeFileSync(cachePath(dir), '{ torn')
  assert.equal(readCache(dir, at), null, 'a half-written cache is a miss, not a crash')

  fs.rmSync(dir, { recursive: true, force: true })
})
