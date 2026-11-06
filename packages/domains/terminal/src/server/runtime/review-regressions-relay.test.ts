/**
 * Review regressions, terminal relay: reproductions from the pre-merge reviews of
 * feat/move-to-computer about whose request turns a session's live output on. Part
 * of the ONE review-regression suite (`pnpm test:review-regressions`,
 * packages/shared/test-utils/review-regressions.mjs); the earlier rounds' relay and
 * catch-up cases live in pty.test (M4), catch-up-merge (M7/R8), catch-up-controller
 * (F1) and subscription-security-context (K7).
 *
 * Round 6 (artifact cfbc0854), L2: on a hub with login, user A's unfiltered output
 * subscription watches every session. Since K7 its body runs as A, so the relay
 * request for user B's session went to B's computer AS A and was refused — but the
 * session was already marked relayed, so B's own subscribe sent nothing: B's live
 * output stayed dead while anyone watched. Relaying is hub-shared state: its requests
 * run as the hub, and a failed one leaves the session unrelayed, to be asked again.
 *
 * A fake routed handle per session stands in for the computer; its relay request is
 * judged like the gateway's owner check (a caller may reach only their own computer).
 */
import { afterEach, describe, expect, test } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import { currentSecurityContext, runWithSecurityContext } from '@slayzone/platform/security-log'
import type { PtySessionWindow } from '../pty-host'
import { createPty, killPty, setDatabase, subscribeToPtyData, watchPtyOutput } from './pty-manager'
import { setPtyBackend, type PtyBackend, type PtySpawnSpec } from './pty-backend'
import { ptyEvents } from './pty-events'
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

/** Who owns which computer, as the gateway's owner check sees it. */
const OWNER: Record<string, string> = { 'computer-a': 'user-a', 'computer-b': 'user-b' }

type Computer = {
  /** The relay state the computer holds for the session. */
  relay: boolean
  /** Every relay request: as whom, and how it ended. */
  requests: Array<{ on: boolean; actor: string | null; outcome: string }>
  /** Refuse the next N requests whatever the caller (the computer briefly away). */
  failNext: number
  emit?: (data: string) => void
  /** Report the computer away (false) or back (true). */
  available?: (on: boolean) => void
}
const computers = new Map<string, Computer>()

setPtyBackend({
  spawn: (spec: PtySpawnSpec) => {
    const computerId = spec.computerId ?? 'computer-a'
    const c: Computer = { relay: spec.relay === true, requests: [], failNext: 0 }
    computers.set(spec.sessionId, c)
    return {
      pid: 1,
      process: 'bash',
      detectsOutput: true,
      onData: (cb: (d: string) => void) => {
        c.emit = (d) => {
          if (c.relay) cb(d)
        }
        return { dispose: () => undefined }
      },
      onSignal: () => ({ dispose: () => undefined }),
      onAvailability: (cb: (on: boolean) => void) => {
        c.available = cb
        return { dispose: () => undefined }
      },
      onExit: () => ({ dispose: () => undefined }),
      write: () => undefined,
      kill: () => undefined,
      resize: () => undefined,
      setRelay: async (on: boolean) => {
        const actor = currentSecurityContext()?.actor ?? null
        if (c.failNext > 0) {
          c.failNext--
          c.requests.push({ on, actor, outcome: 'failed' })
          throw new Error('computer away')
        }
        if (actor && OWNER[computerId] !== actor) {
          c.requests.push({ on, actor, outcome: `refused: ${actor} does not own ${computerId}` })
          throw new Error('refused')
        }
        c.requests.push({ on, actor, outcome: 'sent' })
        c.relay = on
      }
    } as never
  }
} as PtyBackend)

const opened: string[] = []
async function open(sessionId: string, computerId: string): Promise<Computer> {
  const res = await createPty({
    win: fakeWin,
    sessionId,
    cwd: '/tmp',
    mode: 'terminal',
    computerId
  } as never)
  expect(res.success, JSON.stringify(res)).toBe(true)
  opened.push(sessionId)
  return computers.get(sessionId)!
}

const as = <T>(actor: string, fn: () => T): T =>
  runWithSecurityContext({ ip: null, route: null, actor }, fn)
const settle = () => new Promise((r) => setTimeout(r, 20))

afterEach(() => {
  for (const id of opened.splice(0)) killPty(id)
  ptyEvents.removeAllListeners()
})

describe("L2: one user's subscription never stops another user's live output", () => {
  test("A watching everything turns B's relay on as the hub, and B's output keeps flowing", async () => {
    const b = await open('rr:b', 'computer-b')
    const stopA = as('user-a', () => watchPtyOutput('all'))
    await settle()
    expect(b.requests).toEqual([{ on: true, actor: null, outcome: 'sent' }])
    expect(b.relay).toBe(true)

    const got: string[] = []
    const stopB = as('user-b', () => subscribeToPtyData('rr:b', (d) => got.push(d)))
    stopA()
    await settle()
    // B still watches: the computer still relays, and B gets the bytes.
    expect(b.relay).toBe(true)
    b.emit?.('hello')
    expect(got.join('')).toContain('hello')
    stopB()
    await settle()
    expect(b.relay).toBe(false)
    expect(b.requests.every((r) => r.actor === null && r.outcome === 'sent')).toBe(true)
  })

  test('a relay request that fails leaves the session unrelayed: the next watcher asks again', async () => {
    const c = await open('rr:c', 'computer-a')
    c.failNext = 1
    const first = as('user-a', () => watchPtyOutput(['rr:c']))
    await settle()
    expect(c.relay).toBe(false)
    const second = as('user-a', () => watchPtyOutput(['rr:c']))
    await settle()
    expect(c.requests.map((r) => r.outcome)).toEqual(['failed', 'sent'])
    expect(c.relay).toBe(true)
    first()
    second()
    await settle()
    expect(c.relay).toBe(false)
  })

  // N7: the routed handle no longer re-asks on reconnect; the runtime does, once.
  test('the computer back after an absence: the relay is asked again, once', async () => {
    const c = await open('rr:back', 'computer-a')
    const stop = as('user-a', () => watchPtyOutput(['rr:back']))
    await settle()
    c.available?.(false)
    c.relay = false // the computer lost its relay state with the connection
    c.available?.(true)
    await settle()
    expect(c.requests.map((r) => r.on)).toEqual([true, true])
    expect(c.relay).toBe(true)
    stop()
  })
})
