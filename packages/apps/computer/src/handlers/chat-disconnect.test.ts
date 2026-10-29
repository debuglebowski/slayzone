/**
 * Audit #6: a chat message written while the computer is unreachable vanishes,
 * yet the chat shows it as sent. Hub `ChatBackend` ⇄ REAL computer proc handler,
 * like chat-roundtrip.test.ts, over a link this test can drop.
 *
 * Two holes, both closed by plan item 1.5 (the computer confirms every write):
 *   - the computer acks a write to a session it does not know with `{ok:true}`
 *     (handlers/proc.ts procWrite);
 *   - the hub fires the write and swallows its rejection
 *     (`gateway.request(...).catch(noop)` in exec-proxies.ts), and the chat
 *     handle's `onError` subscribers are never called.
 *
 * Both holes are closed: the computer refuses (never acks) an undeliverable
 * write, and the hub's chat handle rejects a write it could not deliver.
 *
 * @module computer/handlers/chat-disconnect.test
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ComputerNotificationMethods,
  ComputerTransportErrorCodes,
  procDataParamsSchema,
  procExitParamsSchema,
  RpcError,
  TypedEventEmitter
} from '@slayzone/computer-transport/shared'
import {
  createRoutingChatBackend,
  type ComputerGatewayEvents,
  type RoutingGateway
} from '@slayzone/computer-transport/server'
import { createProcHandlers, ProcMethods } from './proc'

const COMPUTER_ID = 'computer-1'

let dir: string
let cleanup: Array<() => void>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-disconnect-'))
  cleanup = []
})
afterEach(() => {
  for (const fn of cleanup.reverse()) fn()
  rmSync(dir, { recursive: true, force: true })
})

/** The real proc handlers behind a gateway whose link can go down, as the real one does. */
function loadComputer() {
  const events = new TypedEventEmitter<ComputerGatewayEvents>()
  const logs: Array<{ msg: string; data?: unknown }> = []
  const created = createProcHandlers({
    dialer: {
      notify: (method: string, params?: unknown) => {
        if (method === ComputerNotificationMethods.procData) {
          events.emit('proc.data', {
            computerId: COMPUTER_ID,
            ...procDataParamsSchema.parse(params)
          })
        } else if (method === ComputerNotificationMethods.procExit) {
          events.emit('proc.exit', {
            computerId: COMPUTER_ID,
            ...procExitParamsSchema.parse(params)
          })
        }
        return true
      }
    },
    config: {
      hubUrl: 'ws://127.0.0.1:0/computers',
      name: 'chat-disconnect',
      allowedRoots: [realpathSync(tmpdir())],
      capabilities: ['proc']
    },
    log: (msg: string, data?: unknown) => logs.push({ msg, data })
  })
  let connected = true
  const gateway: RoutingGateway = {
    request: async <T = unknown>(computerId: string, method: string, params?: unknown) => {
      // What hub-gateway.ts does for a computer with no live socket.
      if (!connected) {
        throw new RpcError(
          ComputerTransportErrorCodes.unknownComputer,
          `computer '${computerId}' is not connected`
        )
      }
      const handler = created.handlers[method]
      if (!handler) throw new Error(`computer has no handler for ${method}`)
      return (await handler(params)) as T
    },
    events,
    listComputers: () => []
  }
  return {
    gateway,
    handlers: created.handlers,
    logs,
    disconnect: () => {
      connected = false
      events.emit('computer-disconnected', {
        computerId: COMPUTER_ID,
        reason: 'test: link dropped'
      })
    },
    disposeAll: created.disposeAll
  }
}

/** A stand-in agent that echoes each stdin line as one JSON line. */
function writeEchoAgent(): string {
  const agentPath = join(dir, 'echo-agent.sh')
  writeFileSync(
    agentPath,
    [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      '  printf \'{"echo":"%s"}\\n\' "$line"',
      'done'
    ].join('\n'),
    { mode: 0o755 }
  )
  return agentPath
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 20))
  }
  return true
}

async function spawnAgent(computer: ReturnType<typeof loadComputer>) {
  const backend = createRoutingChatBackend({
    gateway: computer.gateway,
    resolveComputerId: (spec) => spec.computerId
  })
  const handle = await backend.spawn({
    sessionId: 'task-1:tab-1',
    taskId: 'task-1',
    computerId: COMPUTER_ID,
    binaryName: 'sh',
    args: [writeEchoAgent()],
    cwd: dir,
    env: {}
  })
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
  await new Promise<void>((resolve) => handle.onSpawn(() => resolve()))
  return { handle, lines }
}

describe('chat writes and an unreachable computer (audit #6)', () => {
  it('control: a write while connected reaches the agent', async () => {
    const computer = loadComputer()
    cleanup.push(() => computer.disposeAll())
    const { handle, lines } = await spawnAgent(computer)
    handle.write('hello\n')
    expect(await waitUntil(() => lines.length > 0, 5000)).toBe(true)
    expect(JSON.parse(lines[0] ?? '')).toEqual({ echo: 'hello' })
  })

  it('a write to a session the computer does not know is refused, not acked', async () => {
    const computer = loadComputer()
    cleanup.push(() => computer.disposeAll())
    const write = () =>
      Promise.resolve(
        computer.handlers[ProcMethods.procWrite]?.({ sessionId: 'no-such-session', data: 'lost\n' })
      )
    const err = await write().then(
      () => null,
      (e: unknown) => e
    )
    expect(computer.logs.some((l) => l.msg === 'proc write on unknown session')).toBe(true)
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(ComputerTransportErrorCodes.refusedByComputer)
  })

  it('a write while the computer is disconnected is reported, not silently dropped', async () => {
    const computer = loadComputer()
    cleanup.push(() => computer.disposeAll())
    const { handle, lines } = await spawnAgent(computer)

    computer.disconnect()
    const ret = handle.write('sent while offline\n')
    const err = await ret.then(
      () => null,
      (e: unknown) => e
    )
    expect(lines).toEqual([])
    // Rejected as link-down: the line was not written, and the caller may retry it.
    expect(err).toMatchObject({ code: 'link-down' })
  })
})
