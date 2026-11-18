/**
 * Tests for scripts/ci-lock.mjs — the machine-wide CI lock shared with madacademy ci/lock.sh:
 * file formats, FIFO order, dead-ticket / stale-lock cleanup, and release on exit, failure
 * and signals. Every test uses its own temp queue + lock dirs, never the real /tmp ones.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  enqueue,
  isAlive,
  readLock,
  release,
  skipReason,
  sortTickets,
  tryAcquire
} from './ci-lock.mjs'

let dir, paths
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-lock-'))
  paths = { lockDir: join(dir, 'ci-local.lock'), queueDir: join(dir, 'ci-local.queue') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A pid that certainly belongs to no process: one that just exited. */
function deadPid() {
  const pid = spawnSync(process.execPath, ['-e', ''], { env: process.env }).pid
  expect(isAlive(pid)).toBe(false)
  return pid
}

const ME = process.pid
const OTHER = process.ppid // alive for the whole test, and not us

test('ticket and lock files have the formats madacademy ci/lock.sh reads and writes', () => {
  const ticket = enqueue({
    queueDir: paths.queueDir,
    who: 'test:e2e:slayzone',
    now: 1_700_000_000_500
  })
  expect(ticket).toBe(join(paths.queueDir, `1700000000-${ME}`))
  expect(readFileSync(ticket, 'utf8')).toBe('test:e2e:slayzone\n')
  expect(tryAcquire({ ...paths, ticket, who: 'test:e2e:slayzone' })).toEqual({ acquired: true })
  expect(readFileSync(join(paths.lockDir, 'pid'), 'utf8')).toBe(`${ME}\n`)
  expect(readFileSync(join(paths.lockDir, 'who'), 'utf8')).toBe('test:e2e:slayzone\n')
})

test('a multi-line who (another repo writer) reads as one line', () => {
  mkdirSync(paths.lockDir)
  writeFileSync(join(paths.lockDir, 'pid'), `${OTHER}\n`)
  writeFileSync(join(paths.lockDir, 'who'), 'madacademy-ci-eras\n/Users/x/madacademy-ci-eras\n')
  expect(readLock(paths.lockDir)).toEqual({
    pid: OTHER,
    who: 'madacademy-ci-eras /Users/x/madacademy-ci-eras'
  })
})

test('tickets order by epoch, then pid, numerically', () => {
  expect(sortTickets(['20-1', '3-9', '3-10', '100-2'])).toEqual(['3-9', '3-10', '20-1', '100-2'])
})

test('first come first served: a later ticket waits until the earlier holder releases', () => {
  const first = enqueue({ queueDir: paths.queueDir, who: 'madacademy', pid: OTHER, now: 1_000_000 })
  const second = enqueue({ queueDir: paths.queueDir, who: 'test:e2e:slayzone', now: 2_000_000 })

  // The earlier ticket is the head, so the later one cannot take the free lock.
  expect(tryAcquire({ ...paths, ticket: second, who: 'test:e2e:slayzone' })).toEqual({
    acquired: false,
    holder: null,
    queued: 2
  })
  expect(existsSync(paths.lockDir)).toBe(false)

  expect(tryAcquire({ ...paths, ticket: first, who: 'madacademy', pid: OTHER })).toEqual({
    acquired: true
  })
  expect(tryAcquire({ ...paths, ticket: second, who: 'test:e2e:slayzone' })).toEqual({
    acquired: false,
    holder: 'madacademy',
    queued: 2
  })

  release({ lockDir: paths.lockDir, ticket: first, pid: OTHER })
  expect(tryAcquire({ ...paths, ticket: second, who: 'test:e2e:slayzone' })).toEqual({
    acquired: true
  })
  expect(readLock(paths.lockDir)).toEqual({ pid: ME, who: 'test:e2e:slayzone' })
})

test('a dead waiter ticket is dropped and no longer holds its place', () => {
  const dead = enqueue({ queueDir: paths.queueDir, who: 'crashed', pid: deadPid(), now: 1_000_000 })
  const mine = enqueue({ queueDir: paths.queueDir, who: 'me', now: 2_000_000 })
  expect(tryAcquire({ ...paths, ticket: mine, who: 'me' })).toEqual({ acquired: true })
  expect(existsSync(dead)).toBe(false)
})

test('a lock held by a dead pid (kill -9) is cleared by the queue head, which takes it', () => {
  const holder = deadPid()
  mkdirSync(paths.lockDir)
  writeFileSync(join(paths.lockDir, 'pid'), `${holder}\n`)
  writeFileSync(join(paths.lockDir, 'who'), 'killed\n')
  const head = enqueue({ queueDir: paths.queueDir, who: 'head', pid: OTHER, now: 1_000_000 })
  const later = enqueue({ queueDir: paths.queueDir, who: 'later', now: 2_000_000 })

  // Not the head: leaves the stale lock to the head (no remove-vs-take race between waiters).
  expect(tryAcquire({ ...paths, ticket: later, who: 'later' })).toEqual({
    acquired: false,
    holder: 'killed',
    queued: 2
  })
  expect(tryAcquire({ ...paths, ticket: head, who: 'head', pid: OTHER })).toEqual({
    acquired: true
  })
  expect(readLock(paths.lockDir)).toEqual({ pid: OTHER, who: 'head' })
})

test('a lock dir without a pid file is a take in progress, stale only after the grace period', () => {
  mkdirSync(paths.lockDir)
  const ticket = enqueue({ queueDir: paths.queueDir, who: 'me' })
  expect(tryAcquire({ ...paths, ticket, who: 'me' }).acquired).toBe(false)
  const old = new Date(Date.now() - 60_000)
  utimesSync(paths.lockDir, old, old)
  expect(tryAcquire({ ...paths, ticket, who: 'me' })).toEqual({ acquired: true })
})

test('release removes only a lock this pid holds, and is safe to repeat', () => {
  const ticket = enqueue({ queueDir: paths.queueDir, who: 'other', pid: OTHER })
  tryAcquire({ ...paths, ticket, who: 'other', pid: OTHER })
  release({ lockDir: paths.lockDir, ticket: null })
  expect(readLock(paths.lockDir)).toEqual({ pid: OTHER, who: 'other' })
  release({ lockDir: paths.lockDir, ticket, pid: OTHER })
  release({ lockDir: paths.lockDir, ticket, pid: OTHER })
  expect(existsSync(paths.lockDir)).toBe(false)
  expect(readdirSync(paths.queueDir)).toEqual([])
})

test('skipped on CI, with the opt-out, and under an ancestor that already decided', () => {
  expect(skipReason({})).toBe(null)
  expect(skipReason({ CI: 'true' })).toBe('CI')
  expect(skipReason({ CI: 'false' })).toBe(null)
  expect(skipReason({ SLZ_NO_CI_LOCK: '1' })).toBe('SLZ_NO_CI_LOCK=1')
  expect(skipReason({ SLZ_CI_LOCK_HELD: '1', CI: 'true' })).toBe('held')
})

// --- the wrapper process end to end -------------------------------------------------------

const MODULE = pathToFileURL(join(import.meta.dirname, 'ci-lock.mjs')).href

/** Starts `runLocked` in its own process (it exits like its command), on this test's dirs. */
function startWrapper(cmd) {
  const driver = join(dir, 'driver.mjs')
  writeFileSync(
    driver,
    `const m = await import(${JSON.stringify(MODULE)})\n` +
      `await m.runLocked({ label: 'test', cmd: ${JSON.stringify(cmd)}, paths: ${JSON.stringify(paths)}, pollMs: 50 })\n`
  )
  const env = { ...process.env }
  delete env.CI
  delete env.SLZ_NO_CI_LOCK
  delete env.SLZ_CI_LOCK_HELD
  const proc = spawn(process.execPath, [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  proc.stdout.on('data', (d) => (out += d))
  proc.stderr.on('data', (d) => (out += d))
  const exited = new Promise((resolve) =>
    proc.on('exit', (code, signal) => resolve({ code, signal, out }))
  )
  return { proc, exited, output: () => out }
}

async function until(cond, what) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Holds the lock as `madacademy` (this test process), with the oldest ticket. */
function holdLock() {
  const ticket = enqueue({ queueDir: paths.queueDir, who: 'madacademy', now: 1_000_000 })
  expect(tryAcquire({ ...paths, ticket, who: 'madacademy' })).toEqual({ acquired: true })
  return ticket
}

const node = (code) => [process.execPath, '-e', code]

test('runs the command with SLZ_CI_LOCK_HELD=1, exits with its code, and releases', async () => {
  const w = startWrapper(
    node(`
    const fs = require('node:fs')
    if (process.env.SLZ_CI_LOCK_HELD !== '1') process.exit(9)
    if (!fs.readFileSync(${JSON.stringify(join(paths.lockDir, 'pid'))}, 'utf8').trim()) process.exit(8)
    process.exit(3)`)
  )
  expect(await w.exited).toMatchObject({ code: 3 })
  expect(existsSync(paths.lockDir)).toBe(false)
  expect(readdirSync(paths.queueDir)).toEqual([])
})

test('waits while another run holds the lock, says who and the queue length, then runs', async () => {
  const held = holdLock()
  const w = startWrapper(node('process.exit(0)'))
  await until(() => w.output().includes('waiting'), 'the waiting message')
  expect(w.output()).toContain('held by madacademy; 2 in queue')

  release({ lockDir: paths.lockDir, ticket: held })
  expect(await w.exited).toMatchObject({ code: 0 })
  expect(w.output()).toContain('has the lock')
  expect(existsSync(paths.lockDir)).toBe(false)
})

test('a signal while waiting drops the ticket and leaves the holder alone', async () => {
  holdLock()
  const w = startWrapper(node('process.exit(0)'))
  await until(() => readdirSync(paths.queueDir).length === 2, 'the wrapper ticket')
  w.proc.kill('SIGTERM')
  expect(await w.exited).toMatchObject({ code: 143 })
  expect(readdirSync(paths.queueDir)).toHaveLength(1)
  expect(readLock(paths.lockDir)).toEqual({ pid: ME, who: 'madacademy' })
})

test('a signal while running stops the command and releases the lock', async () => {
  const w = startWrapper(node('setInterval(() => {}, 1000)'))
  await until(() => existsSync(join(paths.lockDir, 'who')), 'the lock')
  w.proc.kill('SIGTERM')
  expect(await w.exited).toMatchObject({ signal: 'SIGTERM' })
  expect(existsSync(paths.lockDir)).toBe(false)
  expect(readdirSync(paths.queueDir)).toEqual([])
})

test('a command that cannot start fails the run and still releases', async () => {
  const w = startWrapper(['/nonexistent/ci-lock-test-command'])
  expect(await w.exited).toMatchObject({ code: 127 })
  expect(existsSync(paths.lockDir)).toBe(false)
  expect(readdirSync(paths.queueDir)).toEqual([])
})
