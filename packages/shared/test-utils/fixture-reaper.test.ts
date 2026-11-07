import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import {
  fixtureMarkerArgs,
  fixtureProcesses,
  killFixtureProcesses,
  spawnFixtureReaper
} from './fixture-reaper'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const spawned: ChildProcess[] = []
const idle = (...args: string[]): ChildProcess => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  spawned.push(child)
  return child
}

afterEach(() => {
  for (const child of spawned.splice(0)) if (child.pid && alive(child.pid)) child.kill('SIGKILL')
})

test('owner killed without cleanup: reaper kills every process naming the dir, removes the dir', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'fixture-reaper-'))
  writeFileSync(join(dir, 'marker'), '')
  const owner = idle()
  // Detached + reparented to init, like a fixture's supervisor outliving its test.
  const leaked = idle(join(dir, 'leaked.cjs'))
  const bystander = idle(`${dir}x/not-this-fixture.cjs`)
  const reaper = spawnFixtureReaper(dir, owner.pid!)
  owner.kill('SIGKILL')
  await vi.waitFor(
    () => {
      expect(alive(leaked.pid!)).toBe(false)
      expect(existsSync(dir)).toBe(false)
      expect(alive(reaper.pid!)).toBe(false)
    },
    { timeout: 10_000, interval: 100 }
  )
  expect(alive(bystander.pid!)).toBe(true)
})

test('normal cleanup removes the dir: reaper exits and kills nothing', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'fixture-reaper-'))
  const owner = idle()
  const reaper = spawnFixtureReaper(dir, owner.pid!)
  rmSync(dir, { recursive: true, force: true })
  await vi.waitFor(() => expect(alive(reaper.pid!)).toBe(false), { timeout: 10_000, interval: 100 })
  expect(alive(owner.pid!)).toBe(true)
})

/** A detached idle process that starts its own idle child, which names nothing. */
const idleWithChild = (...args: string[]): { parent: ChildProcess; childPid: () => number } => {
  const script = `
    const { spawn } = require('node:child_process')
    const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    process.stdout.write(String(c.pid))
    setInterval(()=>{},1000)`
  const parent = spawn(process.execPath, ['-e', script, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  parent.unref()
  spawned.push(parent)
  let out = ''
  parent.stdout?.on('data', (d) => (out += d))
  return { parent, childPid: () => Number(out) }
}

const killPid = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* gone */
  }
}

test('owner killed: reaper also kills the descendants of a process naming the dir', async () => {
  // A computer's supervisor is `dist/bin.cjs --supervisor`: its own command line names
  // no fixture dir, only its parent's launcher does.
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'fixture-reaper-'))
  const owner = idle()
  const tree = idleWithChild(join(dir, 'launch.cjs'))
  await vi.waitFor(() => expect(tree.childPid()).toBeGreaterThan(0), { timeout: 10_000 })
  const child = tree.childPid()
  try {
    spawnFixtureReaper(dir, owner.pid!)
    owner.kill('SIGKILL')
    await vi.waitFor(
      () => {
        expect(alive(tree.parent.pid!), 'the process naming the dir').toBe(false)
        expect(alive(child), 'its child, which names nothing').toBe(false)
      },
      { timeout: 10_000, interval: 100 }
    )
  } finally {
    killPid(child)
  }
})

test('killFixtureProcesses: kills the dir-named processes and their descendants, nothing else', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'fixture-reaper-'))
  const tree = idleWithChild(join(dir, 'launch.cjs'))
  const bystander = idle(`${dir}x/not-this-fixture.cjs`)
  await vi.waitFor(() => expect(tree.childPid()).toBeGreaterThan(0), { timeout: 10_000 })
  const child = tree.childPid()
  try {
    const killed = killFixtureProcesses(dir)
    expect(killed.map((p) => p.pid).sort()).toEqual([tree.parent.pid!, child].sort())
    // Our own child lingers as a zombie until this loop reaps it.
    await vi.waitFor(
      () => {
        expect(alive(tree.parent.pid!)).toBe(false)
        expect(alive(child)).toBe(false)
      },
      { timeout: 5_000, interval: 50 }
    )
    expect(alive(bystander.pid!)).toBe(true)
    expect(fixtureProcesses(dir)).toEqual([])
  } finally {
    killPid(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fixtureMarkerArgs: a process whose real command names no dir is still found by it', async () => {
  // The hub fixture runs `electron <repo>/dist/bin.cjs`: nothing in that names its root.
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'fixture-reaper-'))
  try {
    const proc = spawn(
      process.execPath,
      [...fixtureMarkerArgs(dir), '-e', 'setInterval(()=>{},1000)'],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore' }
    )
    proc.unref()
    spawned.push(proc)
    await vi.waitFor(() => expect(fixtureProcesses(dir).map((p) => p.pid)).toEqual([proc.pid]), {
      timeout: 10_000
    })
  } finally {
    killFixtureProcesses(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})
