import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { spawnFixtureReaper } from './fixture-reaper'

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
