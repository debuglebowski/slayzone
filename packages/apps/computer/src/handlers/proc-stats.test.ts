/**
 * A background process runs on THIS computer, so its pid-level care lives here too:
 * cpu/memory + process title for the hub's processes panel (`proc.stats`), and
 * sweeping a leader's group when it exits on its own (`reapGroupOnExit`) — a
 * `pnpm dev` can leave its real server running under a dead shell.
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { ComputerConfig } from '../config'
import { createProcHandlers, ProcNotifications } from './proc'
import type { ComputerDialer } from './types'

function setup() {
  const notifies: Array<{ method: string; params: Record<string, unknown> }> = []
  const dialer: ComputerDialer = {
    notify: (method, params) => {
      notifies.push({ method, params: (params ?? {}) as Record<string, unknown> })
      return true
    }
  }
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [realpathSync(tmpdir())],
    capabilities: ['proc']
  }
  return { notifies, procs: createProcHandlers({ dialer, config, log: () => {} }) }
}

async function until(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const groupAlive = (pgid: number): boolean => {
  try {
    execFileSync('pgrep', ['-g', String(pgid)])
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform === 'win32')('background process care on the computer', () => {
  it('proc.stats: cpu, memory and title for the asked sessions', async () => {
    const { procs } = setup()
    await procs.handlers['proc.spawn']({
      sessionId: 'p1',
      command: 'sleep 30',
      shell: true,
      cwd: realpathSync(tmpdir())
    })
    const res = (await procs.handlers['proc.stats']({ sessionIds: ['p1', 'gone'] })) as {
      stats: Record<string, { cpu: number; rss: number; title: string | null }>
    }
    expect(Object.keys(res.stats)).toEqual(['p1'])
    expect(typeof res.stats.p1.cpu).toBe('number')
    expect(res.stats.p1.rss).toBeGreaterThan(0)
    expect(typeof res.stats.p1.title).toBe('string')
    procs.disposeAll()
  })

  it('reapGroupOnExit: a leader exiting on its own takes its group with it', async () => {
    const { notifies, procs } = setup()
    const { pid } = (await procs.handlers['proc.spawn']({
      sessionId: 'p2',
      command: 'sleep 30 & echo started; exit 3',
      shell: true,
      reapGroupOnExit: true,
      cwd: realpathSync(tmpdir())
    })) as { pid: number }
    await until(() =>
      notifies.some((n) => n.method === ProcNotifications.procExit && n.params.sessionId === 'p2')
    )
    await until(() => !groupAlive(pid))
    procs.disposeAll()
  })

  it('without it (an agent process) the group is left alone, as before', async () => {
    const { procs } = setup()
    const { pid } = (await procs.handlers['proc.spawn']({
      sessionId: 'p3',
      command: 'sleep 30 & exit 0',
      shell: true,
      cwd: realpathSync(tmpdir())
    })) as { pid: number }
    await new Promise((r) => setTimeout(r, 600))
    expect(groupAlive(pid)).toBe(true)
    // The syscall, not the `kill` binary: procps-ng 4 (Ubuntu 24.04) signals the group
    // yet exits 1 for `kill -TERM -<pgid>`.
    process.kill(-pid, 'SIGTERM')
    procs.disposeAll()
  })
})
