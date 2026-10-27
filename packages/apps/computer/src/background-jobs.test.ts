/**
 * Background-job liveness: which of claude's background jobs (`Bash`
 * run_in_background, `Monitor`) still have a live process under a pty session.
 *
 * Claude fires no hook when a job exits on its own, so the hub asks the computer,
 * which owns the process tree. Fixtures are the real shapes from claude 2.1.311
 * on macOS (`ps -A -ww -o pid=,ppid=,args=` and the job shells' fd 1).
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeEvalArg,
  descendantsOf,
  matchLiveJobs,
  parsePsRows,
  probeBackgroundJobs
} from './background-jobs'

const SNAP = `/bin/zsh -c source /Users/k/.claude/shell-snapshots/snapshot-zsh-1-x.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB 2>/dev/null || true`
const shellArgs = (cmd: string): string =>
  `${SNAP} && eval ${claudeEvalArg(cmd)} < /dev/null && pwd -P >| /tmp/claude-6854-cwd`

const PS = [
  `  1     0 /sbin/launchd`,
  `100     1 /bin/sh -c ulimit -n 65535; exec claude --session-id s`,
  `200   100 ${shellArgs('sleep 300')}`,
  `201   200 sleep 300`,
  `300   100 ${shellArgs(`echo "it's" 'q'; sleep 25`)}`,
  `400   100 ${shellArgs('tail -f log')}`,
  `500     1 ${shellArgs('tail -f log')}`, // same command, NOT under this session
  `600   100 /Applications/Pen.app/mcp-server --agent claudeCodeCLI`
].join('\n')

describe('claudeEvalArg', () => {
  it('reproduces claude single-quote escaping', () => {
    // Observed: eval 'echo "it'"'"'s" '"'"'q'"'"'; sleep 25'
    expect(claudeEvalArg(`echo "it's" 'q'; sleep 25`)).toBe(
      `'echo "it'"'"'s" '"'"'q'"'"'; sleep 25'`
    )
  })
})

describe('descendantsOf', () => {
  it('walks the whole subtree, not just direct children, and excludes the root', () => {
    const rows = parsePsRows(PS)
    expect(descendantsOf(100, rows).map((r) => r.pid)).toEqual([200, 300, 400, 600, 201])
  })

  it('returns nothing for an unknown root', () => {
    expect(descendantsOf(999, parsePsRows(PS))).toEqual([])
  })
})

describe('matchLiveJobs', () => {
  const desc = descendantsOf(100, parsePsRows(PS))

  it('a shell job is alive when a descendant writes to tasks/<id>.output', () => {
    const stdout = new Map([[200, '/private/tmp/claude-501/p/s/tasks/bg7siv1aw.output']])
    const jobs = [
      { id: 'bg7siv1aw', kind: 'shell' as const, command: null },
      { id: 'gone12345', kind: 'shell' as const, command: null }
    ]
    expect(matchLiveJobs(jobs, desc, stdout)).toEqual(['bg7siv1aw'])
  })

  it('a monitor job (stdout is a pipe) is alive by its eval command line', () => {
    const jobs = [{ id: 'b9pbuzi0i', kind: 'monitor' as const, command: 'tail -f log' }]
    expect(matchLiveJobs(jobs, desc, new Map())).toEqual(['b9pbuzi0i'])
  })

  it('a command containing quotes still matches', () => {
    const jobs = [
      {
        id: 'm2',
        kind: 'monitor' as const,
        command: `echo "it's" 'q'; sleep 25`
      }
    ]
    expect(matchLiveJobs(jobs, desc, new Map())).toEqual(['m2'])
  })

  it('a same-command process outside the session does not count', () => {
    const outside = descendantsOf(100, parsePsRows(PS)).filter((r) => r.pid !== 400)
    const jobs = [{ id: 'm3', kind: 'monitor' as const, command: 'tail -f log' }]
    expect(matchLiveJobs(jobs, outside, new Map())).toEqual([])
  })

  it('a shell job whose stdout is unreadable falls back to its command line', () => {
    const jobs = [{ id: 'bx', kind: 'shell' as const, command: 'sleep 300' }]
    expect(matchLiveJobs(jobs, desc, new Map())).toEqual(['bx'])
  })
})

describe.skipIf(process.platform === 'win32')('probeBackgroundJobs (real processes)', () => {
  it('finds a live job by command line, then drops it once it exits', async () => {
    const cmd = 'sleep 30'
    // Shaped like a claude job shell: `sh -c "… eval '<cmd>' …"` under this process.
    const child = spawn('/bin/sh', ['-c', `true && eval ${claudeEvalArg(cmd)} < /dev/null`], {
      stdio: 'ignore'
    })
    try {
      await new Promise((r) => setTimeout(r, 200))
      const jobs = [{ id: 'j1', kind: 'monitor' as const, command: cmd }]
      expect(await probeBackgroundJobs(process.pid, jobs)).toEqual(['j1'])
      child.kill('SIGKILL')
      await new Promise((r) => child.once('exit', r))
      expect(await probeBackgroundJobs(process.pid, jobs)).toEqual([])
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('finds a live shell job by its stdout file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgjobs-'))
    // Real layout is `<…>/tasks/<id>.output`.
    mkdirSync(join(dir, 'tasks'))
    const out = openSync(join(dir, 'tasks', 'zzjob1.output'), 'w')
    const child = spawn('/bin/sh', ['-c', 'sleep 30'], {
      stdio: ['ignore', out, out]
    })
    try {
      await new Promise((r) => setTimeout(r, 200))
      const jobs = [{ id: 'zzjob1', kind: 'shell' as const, command: null }]
      expect(await probeBackgroundJobs(process.pid, jobs)).toEqual(['zzjob1'])
    } finally {
      child.kill('SIGKILL')
      closeSync(out)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
