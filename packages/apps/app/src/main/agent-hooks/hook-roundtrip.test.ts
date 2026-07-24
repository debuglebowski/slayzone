import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { processAgentHook } from '@slayzone/transport/server'
import { formatHookCommand } from './hook-paths'
import { installNotifyScript } from './notify-script-installer'

/**
 * STITCHED round-trip: the REAL benign notify.sh (run via bash, exactly as an
 * agent CLI invokes it) → its POSTed envelope → the REAL `processAgentHook`
 * authority → the PTY state-machine bridge. Every per-hop test proves one side
 * of a contract; THIS proves the two halves actually fit — i.e. the opaque
 * `{ctx,raw,arg}` bytes the shell emits are exactly what the server's
 * `resolveHookIdentity` can decode back into a task + event. It is the guard
 * against the halves drifting apart (the failure mode that started this whole
 * fix: shell said one shape, server expected another).
 *
 * We capture the shell's real POST body with a throwaway loopback server, then
 * feed those exact bytes into `processAgentHook` — the SAME function both the
 * local HTTP route and the hub ws-relay consumer call. No re-encoding in between.
 */

// The route reaches the task + diagnostics domains; mock them (as the
// transport's own agent-hook.test.ts does) so this stays hermetic — we assert
// the SHELL→SERVER→BRIDGE wiring, not the DB.
vi.mock('@slayzone/terminal/server', () => ({
  isHookDrivenMode: (mode: string) => ['claude-code', 'codex', 'antigravity'].includes(mode)
}))
vi.mock('@slayzone/diagnostics/server', () => ({ recordDiagnosticEvent: () => {} }))
vi.mock('@slayzone/task/server', () => ({
  recordConversation: vi.fn(),
  findPendingSpawn: vi.fn(async () => ({ expectedSessionId: null, usedResume: false })),
  confirmSessionConversation: vi.fn(),
  getBoundTaskId: vi.fn(async () => null)
}))

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

interface Captured {
  transitions: Array<{ sessionId: string; state: string; event: string }>
  lifecycle: unknown[]
}

/** Bridge + deps that record what the server did, so the round-trip can assert
 *  on the state-machine side effects. */
function makeSink(): {
  cap: Captured
  deps: Parameters<typeof processAgentHook>[1]
  bridge: Parameters<typeof processAgentHook>[2]
} {
  const cap: Captured = { transitions: [], lifecycle: [] }
  const deps = {
    db: {} as never,
    notifyRenderer: () => {},
    agentLifecycle: {
      emit: (_c: string, e: unknown) => {
        cap.lifecycle.push(e)
        return true
      }
    } as never
  } as unknown as Parameters<typeof processAgentHook>[1]
  const bridge = {
    findSession: (taskId: string, mode: string) => `${taskId}:${mode}`,
    transition: (sessionId: string, state: string, event: string) => {
      cap.transitions.push({ sessionId, state, event })
      return true
    },
    markActive: () => true
  } as unknown as Parameters<typeof processAgentHook>[2]
  return { cap, deps, bridge }
}

/** Throwaway loopback server that captures the FIRST POST body verbatim, then
 *  resolves. This is the exact byte stream the real notify.sh emits. */
function captureOnePost(): {
  url: string
  ready: Promise<void>
  body: Promise<string>
  close: () => Promise<void>
  server: http.Server
} {
  let resolveBody!: (b: string) => void
  const body = new Promise<string>((r) => (resolveBody = r))
  const server = http.createServer((req, res) => {
    let buf = ''
    req.on('data', (c) => (buf += c))
    req.on('end', () => {
      res.writeHead(200).end('{}')
      resolveBody(buf)
    })
  })
  let resolveReady!: () => void
  const ready = new Promise<void>((r) => (resolveReady = r))
  let port = 0
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
    resolveReady()
  })
  return {
    get url() {
      return `http://127.0.0.1:${port}/api/agent-hook`
    },
    ready,
    body,
    close: () => new Promise<void>((r) => server.close(() => r())),
    server
  }
}

/** Run the installed notify.sh the way an agent does: `bash -c <command>`, with
 *  the given stdin + env, plus optional argv appended (Antigravity style). */
function runHook(opts: {
  scriptCmd: string
  argv?: string
  stdin: string
  env: Record<string, string>
}): void {
  const command = opts.argv ? `${opts.scriptCmd} ${opts.argv}` : opts.scriptCmd
  execFileSync('bash', ['-c', command], { input: opts.stdin, env: { ...process.env, ...opts.env } })
}

async function withInstalledScript(
  fn: (scriptCmd: string) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-rt-'))
  tmpDirs.push(root)
  const { path: installedAt } = await installNotifyScript({
    targetPath: path.join(root, 'hooks', 'notify.sh')
  })
  await fn(formatHookCommand(installedAt))
}

/** Run the real notify.sh, capture the bytes it POSTs, and drive them through
 *  the real processAgentHook. Returns the recorded side effects. */
async function roundTrip(
  scriptCmd: string,
  opts: { stdin: string; argv?: string; env: Record<string, string> }
): Promise<Captured> {
  const collector = captureOnePost()
  await collector.ready
  try {
    runHook({
      scriptCmd,
      argv: opts.argv,
      stdin: opts.stdin,
      env: { SLAYZONE_AGENT_HOOK_URL: collector.url, ...opts.env }
    })
    const raw = await collector.body
    const { cap, deps, bridge } = makeSink()
    const result = await processAgentHook(JSON.parse(raw), deps, bridge)
    expect(result).toBe('ok')
    return cap
  } finally {
    await collector.close()
  }
}

describe('notify.sh → processAgentHook round-trip (real bash bytes)', () => {
  test('claude-code UserPromptSubmit (ctx blob + stdin) → running transition', async () => {
    await withInstalledScript(async (scriptCmd) => {
      const cap = await roundTrip(scriptCmd, {
        stdin: '{"hook_event_name":"UserPromptSubmit"}',
        env: {
          SLAYZONE_AGENT_ID: 'claude-code',
          SLAYZONE_HOOK_CONTEXT:
            '{"v":1,"taskId":"task-rt","agentId":"claude-code","channel":"dev"}'
        }
      })
      expect(cap.transitions[0]).toEqual({
        sessionId: 'task-rt:claude-code',
        state: 'running',
        event: 'UserPromptSubmit'
      })
    })
  }, 20_000)

  test('antigravity event via argv $1 (stdin omits it) → running transition', async () => {
    await withInstalledScript(async (scriptCmd) => {
      const cap = await roundTrip(scriptCmd, {
        argv: 'PreInvocation',
        stdin: '{"conversationId":"c1"}',
        env: {
          SLAYZONE_AGENT_ID: 'antigravity',
          SLAYZONE_HOOK_CONTEXT: '{"v":1,"taskId":"ag-rt","agentId":"antigravity"}'
        }
      })
      expect(cap.transitions[0]).toEqual({
        sessionId: 'ag-rt:antigravity',
        state: 'running',
        event: 'PreInvocation'
      })
    })
  }, 20_000)

  test('Stop → idle transition (turn-boundary round-trip)', async () => {
    await withInstalledScript(async (scriptCmd) => {
      const cap = await roundTrip(scriptCmd, {
        stdin: '{"hook_event_name":"Stop"}',
        env: {
          SLAYZONE_AGENT_ID: 'claude-code',
          SLAYZONE_HOOK_CONTEXT: '{"v":1,"taskId":"task-stop","agentId":"claude-code"}'
        }
      })
      expect(cap.transitions[0]).toMatchObject({ state: 'idle', event: 'Stop' })
    })
  }, 20_000)
})
