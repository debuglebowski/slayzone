/**
 * Routed CHAT agent contract: hub `ChatBackend` ⇄ REAL runner proc handler.
 *
 * The point of the whole hub/runner chat work is that an agent's PROCESS runs on
 * the runner while all protocol state stays on the hub. This drives that: a fake
 * "agent" (a shell loop reading stdin and answering NDJSON on stdout) is spawned
 * through `createRoutingChatBackend` against the real runner handler, and the
 * test asserts the hub can hold a full request/response exchange with it.
 *
 * That exchange is what a real provider driver does — write a line, read a line —
 * so if this passes, the transport's driver has a working duplex channel to a
 * process on another machine.
 *
 * @module runner/server/chat-roundtrip.test
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TypedEventEmitter } from '../shared/events'
import { RunnerNotificationMethods } from '../shared/frames'
import {
  createRoutingChatBackend,
  NoRunnerAvailableError,
  type RoutingGateway
} from './exec-proxies'
import type { RunnerGatewayEvents } from './hub-gateway'

const RUNNER_ID = 'runner-1'

type ProcHandlerTable = Record<string, (params: unknown) => Promise<unknown> | unknown>

let dir: string
let cleanup: Array<() => void>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-roundtrip-'))
  cleanup = []
})
afterEach(() => {
  for (const fn of cleanup.reverse()) fn()
  rmSync(dir, { recursive: true, force: true })
})

async function loadRunner(): Promise<{
  gateway: RoutingGateway
  disposeAll: () => void
} | null> {
  let mod: {
    createProcHandlers: (ctx: unknown) => { handlers: ProcHandlerTable; disposeAll: () => void }
  }
  try {
    mod = await import('../../../../apps/runner/src/handlers/proc')
  } catch {
    return null
  }
  const events = new TypedEventEmitter<RunnerGatewayEvents>()
  const created = mod.createProcHandlers({
    dialer: {
      notify: (method: string, params?: unknown) => {
        const p = (params ?? {}) as Record<string, unknown>
        if (method === RunnerNotificationMethods.procData) {
          events.emit('proc.data', { runnerId: RUNNER_ID, ...p } as never)
        } else if (method === RunnerNotificationMethods.procExit) {
          events.emit('proc.exit', { runnerId: RUNNER_ID, ...p } as never)
        }
        return true
      }
    },
    config: {
      hubUrl: 'ws://127.0.0.1:0/runners',
      name: 'chat-roundtrip',
      allowedRoots: [realpathSync(tmpdir())],
      capabilities: ['proc']
    },
    log: () => {}
  })
  return {
    gateway: {
      request: async (_runnerId: string, method: string, params?: unknown) => {
        const handler = created.handlers[method]
        if (!handler) throw new Error(`runner has no handler for ${method}`)
        return await handler(params)
      },
      events
    },
    disposeAll: created.disposeAll
  }
}

describe('routed chat agent', () => {
  it('holds an NDJSON request/response exchange with a process on the runner', async () => {
    const runner = await loadRunner()
    if (!runner) return
    cleanup.push(() => runner.disposeAll())

    const backend = createRoutingChatBackend({
      gateway: runner.gateway,
      resolveRunnerId: (spec) => spec.runnerId
    })

    // Stand-in agent: read a line, echo back a JSON envelope naming it. Written to
    // a file rather than passed via `sh -c` so no quoting survives two hops
    // (test → wire → execve) to be re-interpreted.
    const agentPath = join(dir, 'fake-agent.sh')
    writeFileSync(
      agentPath,
      [
        '#!/bin/sh',
        'while IFS= read -r line; do',
        '  printf \'{"type":"reply","echo":"%s"}\\n\' "$line"',
        'done'
      ].join('\n'),
      { mode: 0o755 }
    )

    const handle = await backend.spawn({
      sessionId: 'task-1:tab-1',
      taskId: 'task-1',
      runnerId: RUNNER_ID,
      binaryName: 'sh',
      args: [agentPath],
      cwd: dir,
      env: {}
    })

    // Assemble lines exactly as the transport does, to prove the hub — not the
    // runner — can frame this stream.
    const lines: string[] = []
    let buf = ''
    handle.onStdout((chunk) => {
      buf += chunk
      let i = buf.indexOf('\n')
      while (i !== -1) {
        lines.push(buf.slice(0, i))
        buf = buf.slice(i + 1)
        i = buf.indexOf('\n')
      }
    })

    const spawned = new Promise<void>((resolve) => handle.onSpawn(() => resolve()))
    await spawned

    handle.write('hello\n')
    const start = Date.now()
    while (lines.length < 1 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(lines.length).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(lines[0])).toEqual({ type: 'reply', echo: 'hello' })

    // A second exchange proves the channel stays open (a real session is many
    // turns, not one).
    handle.write('again\n')
    const start2 = Date.now()
    while (lines.length < 2 && Date.now() - start2 < 5000) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(JSON.parse(lines[1])).toEqual({ type: 'reply', echo: 'again' })

    const exited = new Promise<{ code: number | null }>((resolve) => handle.onExit(resolve))
    handle.kill()
    await exited
  })

  it('throws NoRunnerAvailableError when no runner resolves (no hub-local spawn)', async () => {
    const runner = await loadRunner()
    if (!runner) return
    cleanup.push(() => runner.disposeAll())

    const backend = createRoutingChatBackend({
      gateway: runner.gateway,
      resolveRunnerId: (spec) => spec.runnerId
    })

    // Chat used to be the ONE agent kind that always ran in the hub's own process.
    // An unresolved runner is now a visible error, which is what keeps a chat agent
    // and its worktree on the same machine.
    await expect(
      backend.spawn({
        sessionId: 'task-2:tab-1',
        taskId: 'task-2',
        runnerId: null,
        binaryName: 'sh',
        args: ['-c', 'true'],
        cwd: dir,
        env: {}
      })
    ).rejects.toThrow(NoRunnerAvailableError)
  })
})
