/**
 * createChildReaper — how the app's supervisors (local hub, local computer) kill
 * their child processes, so that a caller who awaits the kill knows the process is
 * GONE: an app quit awaits it, and must not exit under a live hub or computer.
 *
 * Against real child processes: what is pinned is the OS-level outcome.
 *
 * Run with: npx tsx packages/apps/app/src/main/child-reaper.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { expect, test } from '../../../../shared/test-utils/ipc-harness.js'
import { createChildReaper } from './child-reaper'

console.log('\ncreateChildReaper')

/** A long-lived child; with `ignoreSigterm`, only SIGKILL ends it. */
function spawnChild(opts: { ignoreSigterm?: boolean } = {}): Promise<ChildProcess> {
  const script =
    (opts.ignoreSigterm ? "process.on('SIGTERM', () => {});" : '') +
    "process.stdout.write('up\\n'); setInterval(() => {}, 1 << 30)"
  const proc = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
  // Resolved once its handlers are installed, so a SIGTERM cannot beat them.
  return new Promise((resolve) => proc.stdout!.once('data', () => resolve(proc)))
}

function gone(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

test('kill: SIGTERM, then SIGKILL after the grace; resolves only once the process is gone', async () => {
  const reaper = createChildReaper()
  const proc = await spawnChild({ ignoreSigterm: true })
  reaper.track(proc)
  const started = Date.now()
  await reaper.kill(proc, 200)
  expect(gone(proc)).toBe(true)
  expect(proc.signalCode).toBe('SIGKILL')
  expect(Date.now() - started >= 150).toBe(true)
})

test('kill: a process that exits on SIGTERM is not waited on for the grace', async () => {
  const reaper = createChildReaper()
  const proc = await spawnChild()
  reaper.track(proc)
  const started = Date.now()
  await reaper.kill(proc, 5_000)
  expect(proc.signalCode).toBe('SIGTERM')
  expect(Date.now() - started < 2_000).toBe(true)
})

test('kill: a second caller joins the kill under way instead of resolving early', async () => {
  const reaper = createChildReaper()
  const proc = await spawnChild({ ignoreSigterm: true })
  reaper.track(proc)
  const first = reaper.kill(proc, 200)
  const second = reaper.kill(proc, 200)
  expect(second).toBe(first)
  await second
  expect(gone(proc)).toBe(true)
})

test('kill: a second caller with another grace joins the first kill, whose grace stands', async () => {
  // A quit's stop() landing while a restart is killing: one SIGTERM, one SIGKILL
  // timer — the restart's — never a second escalation or a restarted grace.
  const reaper = createChildReaper()
  const proc = await spawnChild({ ignoreSigterm: true })
  reaper.track(proc)
  const started = Date.now()
  const first = reaper.kill(proc, 200)
  expect(reaper.kill(proc, 60_000)).toBe(first)
  await first
  expect(proc.signalCode).toBe('SIGKILL')
  expect(Date.now() - started < 5_000).toBe(true)
})

test('kill: an already-exited process resolves at once', async () => {
  const reaper = createChildReaper()
  const proc = await spawnChild()
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve())
    proc.kill('SIGKILL')
  })
  const started = Date.now()
  await reaper.kill(proc, 5_000)
  expect(Date.now() - started < 500).toBe(true)
})

test('kill: a process that never started (failed spawn) cannot hang the caller', async () => {
  // A failed spawn emits `error`, never `exit`: waiting for one would hang a quit.
  const reaper = createChildReaper()
  const proc = spawn('/nonexistent/slayzone-child-reaper-test', [], { stdio: 'pipe' })
  proc.on('error', () => {})
  reaper.track(proc)
  const started = Date.now()
  await reaper.kill(proc, 5_000)
  expect(Date.now() - started < 500).toBe(true)
})

test('killAll: reaps every tracked process still alive, including ones already being killed', async () => {
  const reaper = createChildReaper()
  const a = await spawnChild({ ignoreSigterm: true })
  const b = await spawnChild()
  reaper.track(a)
  reaper.track(b)
  // `a` is mid-kill (a restart replacing it), `b` is the current child.
  void reaper.kill(a, 200)
  await reaper.killAll(200)
  expect(gone(a)).toBe(true)
  expect(gone(b)).toBe(true)
})

test('killAll: a process that exited on its own is no longer tracked', async () => {
  const reaper = createChildReaper()
  const proc = await spawnChild()
  reaper.track(proc)
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve())
    proc.kill('SIGKILL')
  })
  const started = Date.now()
  await reaper.killAll(5_000)
  expect(Date.now() - started < 500).toBe(true)
})

test('killAll: with nothing tracked, resolves at once', async () => {
  const reaper = createChildReaper()
  await reaper.killAll(5_000)
})
