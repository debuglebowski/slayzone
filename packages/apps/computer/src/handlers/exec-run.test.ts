/**
 * `exec.run`: a one-shot shell command the hub asks for (an automation action),
 * run HERE in a jailed cwd — a project's own folder on this computer when the hub
 * names the project — answering its output; a timeout kills the whole tree.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

// A program the hub names by argv (the conflict analysis's agent CLI) is resolved
// and run HERE with no shell: no hub-side POSIX quoting or `$HOME`, which broke on a
// Windows computer. A bare name is looked up on this computer's PATH, then under its
// home (`homeFallbacks`).
describe('exec.run with argv', () => {
  it.skipIf(process.platform === 'win32')(
    'runs the program unsplit, no shell — args with spaces and quotes stay one each',
    async () => {
      const res = (await run({
        argv: { file: 'printf', args: ['%s|', "it's a $(prompt)", 'two words'] },
        cwd: dir,
        timeoutMs: 5000
      })) as { stdout: string; status: number }
      expect(res.status).toBe(0)
      expect(res.stdout).toBe("it's a $(prompt)|two words|")
    }
  )

  it.skipIf(process.platform === 'win32')('a home fallback when not on PATH', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'computer-home-')))
    const savedHome = process.env.HOME
    try {
      mkdirSync(join(home, 'bin-x'), { recursive: true })
      const tool = join(home, 'bin-x', 'my-agent-cli')
      writeFileSync(tool, '#!/bin/sh\necho from-home "$1"\n')
      chmodSync(tool, 0o755)
      process.env.HOME = home
      const res = (await run({
        argv: { file: 'my-agent-cli', args: ['ok'], homeFallbacks: ['bin-x/my-agent-cli'] },
        cwd: dir,
        timeoutMs: 5000
      })) as { stdout: string; status: number }
      expect(res.stdout.trim()).toBe('from-home ok')
    } finally {
      process.env.HOME = savedHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  // A multi-line prompt cannot ride a Windows cmd line (it ends at the first
  // newline): it goes to the program's stdin, intact.
  it.skipIf(process.platform === 'win32')('stdin reaches the program intact', async () => {
    const res = (await run({
      argv: { file: 'cat', args: [], stdin: 'line one\nline "two"\n' },
      cwd: dir,
      timeoutMs: 5000
    })) as { stdout: string; status: number }
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('line one\nline "two"\n')
  })

  it('a program found nowhere: status 127, naming it', async () => {
    const res = (await run({
      argv: { file: 'no-such-agent-cli-x', args: [] },
      cwd: dir,
      timeoutMs: 5000
    })) as { stderr: string; status: number }
    expect(res.status).toBe(127)
    expect(res.stderr).toMatch(/no-such-agent-cli-x/)
  })
})

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
