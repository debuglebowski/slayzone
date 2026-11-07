/**
 * Ending a run's tree must not depend on `pgrep` being installed: a minimal Linux
 * computer without procps read every group as already empty — no wait, no SIGKILL,
 * a "clean" stop, and the restarted server hit EADDRINUSE (the original H1). The
 * group is probed with signal 0 instead, with no child process per poll.
 */
import { spawn } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { terminateTree } from './terminate-tree'

const savedPath = process.env.PATH
afterEach(() => {
  process.env.PATH = savedPath
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

it.skipIf(process.platform === 'win32')(
  'a child that ignores SIGTERM is SIGKILLed with no pgrep on PATH',
  async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{});console.log('up');setInterval(()=>{},1000)"],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ELECTRON_RUN_AS_NODE: '1' } }
    )
    await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()))
    const pid = child.pid!
    process.env.PATH = '/nonexistent'
    const clean = await terminateTree(pid, { graceMs: 300 })
    process.env.PATH = savedPath
    expect(clean, 'reported gone').toBe(true)
    expect(alive(pid), 'and actually gone').toBe(false)
  },
  15_000
)
