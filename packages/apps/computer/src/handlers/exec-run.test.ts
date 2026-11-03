/**
 * `exec.run`: a one-shot shell command the hub asks for (an automation action),
 * run HERE in a jailed cwd — a project's own folder on this computer when the hub
 * names the project — answering its output; a timeout kills the whole tree.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { createExecRunHandlers } from './exec-run'

let dir: string
let run: (params: unknown) => Promise<unknown>

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-exec-run-')))
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [realpathSync(tmpdir())],
    capabilities: []
  }
  const handlers = createExecRunHandlers(
    { dialer: { notify: () => true }, config, log: () => {} },
    () => ({ get: (id: string) => (id === 'p1' ? { path: dir } : null) })
  )
  run = (params) =>
    Promise.resolve((handlers[HubToComputerMethods.execRun] as (p: unknown) => unknown)(params))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('exec.run', () => {
  it('runs the command through the shell in the given folder', async () => {
    expect(await run({ command: 'echo "$((1+2))" && pwd', cwd: dir, timeoutMs: 10_000 })).toEqual({
      stdout: `3\n${dir}\n`,
      stderr: '',
      status: 0,
      timedOut: false
    })
  })

  it("a project id: the project's folder on this computer", async () => {
    const out = (await run({ command: 'pwd', projectId: 'p1', timeoutMs: 10_000 })) as {
      stdout: string
    }
    expect(out.stdout.trim()).toBe(dir)
  })

  it('answers a failing command with its status and stderr', async () => {
    expect(await run({ command: 'echo no >&2; exit 3', cwd: dir, timeoutMs: 10_000 })).toEqual({
      stdout: '',
      stderr: 'no\n',
      status: 3,
      timedOut: false
    })
  })

  it('a timeout ends the whole tree and says so', async () => {
    const started = Date.now()
    const out = (await run({ command: 'sleep 30 & sleep 30', cwd: dir, timeoutMs: 300 })) as {
      timedOut: boolean
    }
    expect(out.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(8000)
  })

  it('refuses a folder outside its roots', async () => {
    await expect(run({ command: 'pwd', cwd: '/etc', timeoutMs: 1000 })).rejects.toThrow(/outside/)
  })
})
