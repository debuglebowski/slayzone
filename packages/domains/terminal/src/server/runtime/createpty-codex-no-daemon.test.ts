/**
 * createPty launches Codex with `--no-daemon` when the COMPUTER it starts on runs
 * a Codex that has the flag (0.156+), and without it otherwise.
 *
 * Regression (QA 2026-11-06, task 5decc957): Codex ≥0.157 runs turns in a shared
 * background daemon whose environment is not the PTY's, so the hooks it runs never
 * carry SLAYZONE_AGENT_HOOK_URL / _CONTEXT — notify.sh exits silently. Spinner stuck
 * on Idle, no unread dot, conversation id never captured, no resume. The flag is
 * version-gated per computer: an older Codex rejects it as an unknown argument and
 * exits, which would be worse than the bug. Cold spawn through a capturing backend;
 * no real shell spawns.
 */
import { afterEach, expect, test } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import type { PtySessionWindow } from '../pty-host'
import { createPty, killPty, setDatabase } from './pty-manager'
import { setPtyBackend, type PtyBackend, type PtySpawnSpec } from './pty-backend'
import { createFakeTaskSessionStore } from './fake-task-session-store'

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => undefined }
} as unknown as PtySessionWindow
setDatabase(
  {
    get: async () => ({ project_id: 'proj-1' }),
    all: async () => [],
    run: async () => ({ changes: 0, lastInsertRowid: 0 }),
    batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
  } as unknown as SlayzoneDb,
  createFakeTaskSessionStore()
)

interface Captured {
  specs: PtySpawnSpec[]
  written: string[]
  asked: Array<{ computerId: string; binary: string }>
}
function captureBackend(version: (() => Promise<string | null>) | undefined): Captured {
  const cap: Captured = { specs: [], written: [], asked: [] }
  setPtyBackend({
    spawn: async (spec: PtySpawnSpec) => {
      cap.specs.push(spec)
      return {
        pid: 4242,
        process: 'zsh',
        onData: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
        write: (s: string) => cap.written.push(s),
        kill: () => undefined,
        resize: () => undefined
      } as never
    },
    ...(version
      ? {
          cliVersion: (computerId: string, binary: string) => {
            cap.asked.push({ computerId, binary })
            return version()
          }
        }
      : {})
  } as unknown as PtyBackend)
  return cap
}
const commandOf = (cap: Captured): string => JSON.stringify(cap.specs) + cap.written.join('')
/** The one shell line that execs the agent (wherever the backend carried it). */
const launchLineOf = (cap: Captured): string => {
  const line = commandOf(cap).match(/exec 'codex'[^"\r]*/)
  if (!line) throw new Error(`no codex launch in ${commandOf(cap)}`)
  return line[0]
}

let n = 0
async function spawnCodex(
  version: (() => Promise<string | null>) | undefined,
  over: Record<string, unknown> = {}
): Promise<Captured> {
  const cap = captureBackend(version)
  const sid = `codexNd${++n}:codexNd${n}`
  await createPty({
    win: fakeWin,
    sessionId: sid,
    computerId: `pc-${n}`,
    projectId: 'proj-1',
    cwd: '/work/repo',
    mode: 'codex',
    type: 'codex',
    initialCommand: 'codex {flags}',
    resumeCommand: 'codex {flags} resume {id}',
    defaultFlags: '--sandbox workspace-write',
    ...over
  } as never)
  killPty(sid)
  return cap
}

afterEach(() => setPtyBackend(null))

test('codex 0.167 on the computer: launched with --no-daemon, asked of THAT computer', async () => {
  const cap = await spawnCodex(async () => '0.167.0')
  expect(commandOf(cap)).toContain(`'codex' '--no-daemon' '--sandbox' 'workspace-write'`)
  expect(cap.asked).toEqual([{ computerId: `pc-${n}`, binary: 'codex' }])
})

test('resume keeps the flag ahead of the subcommand', async () => {
  const id = '01a1b277-b4d0-7052-a200-eb63b10c21d2'
  const cap = await spawnCodex(async () => '0.167.0', { existingConversationId: id })
  expect(commandOf(cap)).toContain(
    `'codex' '--no-daemon' '--sandbox' 'workspace-write' 'resume' '${id}'`
  )
})

test('codex 0.155 on the computer: no --no-daemon (it would exit on an unknown flag)', async () => {
  const cap = await spawnCodex(async () => '0.155.0')
  const cmd = commandOf(cap)
  expect(cmd).toContain(`'codex' '--sandbox' 'workspace-write'`)
  expect(cmd).not.toContain('--no-daemon')
})

test('version unknown (no codex, old computer, lost link): launched as before', async () => {
  for (const version of [
    async () => null,
    async () => {
      throw new Error('link lost')
    },
    undefined
  ]) {
    const cap = await spawnCodex(version)
    const cmd = commandOf(cap)
    expect(cmd).toContain(`'codex' '--sandbox' 'workspace-write'`)
    expect(cmd).not.toContain('--no-daemon')
  }
})

test('the user already passes --no-daemon: not doubled', async () => {
  const cap = await spawnCodex(async () => '0.167.0', {
    providerArgs: ['--no-daemon', '--sandbox', 'workspace-write']
  })
  expect(launchLineOf(cap).match(/--no-daemon/g)).toHaveLength(1)
})

test('a custom command that is not the codex binary: left alone, not probed', async () => {
  const cap = await spawnCodex(async () => '0.167.0', {
    initialCommand: 'my-codex-wrapper {flags}'
  })
  expect(commandOf(cap)).not.toContain('--no-daemon')
  expect(cap.asked).toEqual([])
})

test('claude: never probed', async () => {
  const cap = captureBackend(async () => '0.167.0')
  const sid = `claudeNd${++n}:claudeNd${n}`
  await createPty({
    win: fakeWin,
    sessionId: sid,
    computerId: 'pc',
    projectId: 'proj-1',
    cwd: '/work/repo',
    mode: 'claude-code',
    type: 'claude-code',
    initialCommand: 'claude --session-id {id} {flags}',
    resumeCommand: 'claude --resume {id} {flags}',
    defaultFlags: ''
  } as never)
  killPty(sid)
  expect(cap.asked).toEqual([])
  expect(commandOf(cap)).not.toContain('--no-daemon')
})
