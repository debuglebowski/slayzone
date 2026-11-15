/**
 * The hub's registry of terminal sessions a computer still runs from a previous hub
 * run: each is ADOPTED into its tab (the tab's launch resolved from the hub's
 * records, then an attach — nothing is started), and what cannot be adopted is
 * SURFACED with the reason and the user's two actions (attach again / stop).
 * Never a silent kill, never silent abandonment.
 */
import { beforeEach, expect, test, vi } from 'vitest'
import type { PtyBackend, UntrackedPtySession } from './pty-backend'
import type { PtyCreateResult } from './pty-manager'
import {
  createUnattachedSessions,
  type UnattachedLaunch,
  type UnattachedLaunchResolver
} from './unattached-sessions'

const diag = vi.hoisted(() => [] as Array<{ event: string; payload?: Record<string, unknown> }>)
vi.mock('@slayzone/diagnostics/server', async (orig) => ({
  ...(await orig<typeof import('@slayzone/diagnostics/server')>()),
  recordDiagnosticEvent: (e: { event: string; payload?: Record<string, unknown> }) => {
    diag.push(e)
  }
}))
beforeEach(() => {
  diag.length = 0
})

const live = (over: Partial<UntrackedPtySession> = {}): UntrackedPtySession => ({
  computerId: 'pc',
  sessionId: 'task-1:tab-1',
  spawnId: 'run-1',
  pid: 4242,
  seq: 5,
  detection: true,
  mode: 'claude-code',
  startedAt: 1_000,
  conversationId: 'conv-1',
  ...over
})

function harness(initial: UntrackedPtySession[] = [live()]) {
  let listed = initial
  const listeners = new Set<() => void>()
  const killed: Array<[string, string, string]> = []
  const backend = {
    spawn: () => {
      throw new Error('never spawns')
    },
    untrackedSessions: () => listed,
    onUntrackedChange: (cb: () => void) => {
      listeners.add(cb)
      return { dispose: () => listeners.delete(cb) }
    },
    killUntracked: async (computerId: string, sessionId: string, spawnId: string) => {
      killed.push([computerId, sessionId, spawnId])
      listed = listed.filter((s) => s.sessionId !== sessionId)
      for (const cb of [...listeners]) cb()
    }
  } as unknown as PtyBackend
  const created: Array<Record<string, unknown>> = []
  let createAnswer: (opts: Record<string, unknown>) => PtyCreateResult = () => ({ success: true })
  let resolve: UnattachedLaunchResolver = async ({ sessionId, mode }) => ({
    ok: true,
    launch: { sessionId, cwd: '/work', mode: mode ?? 'claude-code' } as UnattachedLaunch
  })
  const registry = createUnattachedSessions({
    backend: () => backend,
    resolve: (target) => resolve(target),
    create: async (opts) => {
      created.push(opts as unknown as Record<string, unknown>)
      const answer = createAnswer(opts as unknown as Record<string, unknown>)
      // An adopted session leaves the untracked set (the backend took it over).
      if (answer.success) {
        listed = listed.filter((s) => s.sessionId !== (opts as { sessionId: string }).sessionId)
        for (const cb of [...listeners]) cb()
      }
      return answer
    }
  })
  return {
    registry,
    created,
    killed,
    set: (next: UntrackedPtySession[]) => {
      listed = next
      for (const cb of [...listeners]) cb()
    },
    answer: (fn: typeof createAnswer) => {
      createAnswer = fn
    },
    resolver: (fn: UnattachedLaunchResolver) => {
      resolve = fn
    }
  }
}

const idle = () => new Promise((r) => setTimeout(r, 0))

test('adopts every listed task-tab session with its tab launch and the attach intent', async () => {
  const h = harness([live(), live({ sessionId: 'task-2:task-2', spawnId: 'run-2' })])
  h.registry.start()
  await vi.waitFor(() => expect(h.created).toHaveLength(2))
  expect(h.created).toEqual([
    {
      sessionId: 'task-1:tab-1',
      cwd: '/work',
      mode: 'claude-code',
      attach: { computerId: 'pc', spawnId: 'run-1' }
    },
    {
      sessionId: 'task-2:task-2',
      cwd: '/work',
      mode: 'claude-code',
      attach: { computerId: 'pc', spawnId: 'run-2' }
    }
  ])
  await idle()
  expect(h.registry.list()).toEqual([])
})

test('a plain shell tab (a `pnpm dev` in a secondary tab) is adopted the same way', async () => {
  const h = harness([live({ mode: 'terminal', conversationId: null })])
  h.registry.start()
  await vi.waitFor(() => expect(h.created).toHaveLength(1))
  expect(h.created[0]).toMatchObject({ mode: 'terminal', attach: { spawnId: 'run-1' } })
})

test('one adoption per session at a time, however often the set is announced', async () => {
  const h = harness()
  let release: () => void = () => undefined
  h.resolver(
    ({ sessionId }) =>
      new Promise((r) => {
        release = () => r({ ok: true, launch: { sessionId, cwd: '/w', mode: 'claude-code' } })
      })
  )
  h.registry.start()
  h.set([live()])
  h.set([live()])
  await idle()
  release()
  await vi.waitFor(() => expect(h.created).toHaveLength(1))
  await idle()
  expect(h.created).toHaveLength(1)
})

test('what cannot be adopted is surfaced with its reason, once in diagnostics', async () => {
  const h = harness([
    live({ sessionId: 'pooled-session-id', spawnId: 'a' }),
    live({ sessionId: 'task-2:tab-2', spawnId: 'b', detection: false }),
    live({ sessionId: 'task-3:tab-3', spawnId: 'c' }),
    live({ sessionId: 'task-4:tab-4', spawnId: 'd', mode: 'codex' }),
    live({ sessionId: 'task-5:tab-5', spawnId: 'e' })
  ])
  h.resolver(async ({ sessionId }) =>
    sessionId === 'task-3:tab-3'
      ? { ok: false, reason: 'task-elsewhere', detail: 'runs on computer other' }
      : { ok: true, launch: { sessionId, cwd: '/w', mode: 'claude-code' } }
  )
  h.answer(() => ({
    success: false,
    code: 'attach-refused',
    attachRefusal: 'not-adoptable',
    error: 'attempt e is not running'
  }))
  h.registry.start()
  await vi.waitFor(() =>
    expect(h.registry.list().every((s) => s.status === 'unattached')).toBe(true)
  )

  expect(Object.fromEntries(h.registry.list().map((s) => [s.sessionId, s.reason]))).toEqual({
    'pooled-session-id': 'unknown-session-id',
    'task-2:tab-2': 'no-detection',
    'task-3:tab-3': 'task-elsewhere',
    'task-4:tab-4': 'mode-mismatch',
    'task-5:tab-5': 'not-adoptable'
  })
  expect(h.registry.list().find((s) => s.sessionId === 'task-3:tab-3')).toMatchObject({
    taskId: 'task-3',
    tabId: 'tab-3',
    pid: 4242,
    mode: 'claude-code',
    detail: 'runs on computer other'
  })
  // Only the mappable, eligible ones were attempted.
  expect(h.created.map((c) => c.sessionId)).toEqual(['task-5:tab-5'])
  h.set([...h.registry.list()].map((s) => live({ ...s })))
  await idle()
  expect(diag.filter((d) => d.event === 'pty.orphan_unattached')).toHaveLength(5)
})

test('attach again: retried on request, adopted once it can be', async () => {
  const h = harness()
  let fail = true
  h.resolver(async ({ sessionId }) =>
    fail
      ? { ok: false, reason: 'launch-unresolved', detail: 'SQLITE_BUSY' }
      : { ok: true, launch: { sessionId, cwd: '/w', mode: 'claude-code' } }
  )
  h.registry.start()
  await vi.waitFor(() =>
    expect(h.registry.list()).toEqual([
      expect.objectContaining({ status: 'unattached', reason: 'launch-unresolved' })
    ])
  )
  fail = false
  await expect(h.registry.attach('task-1:tab-1')).resolves.toEqual({ ok: true })
  expect(h.created).toHaveLength(1)
  expect(h.registry.list()).toEqual([])
  await expect(h.registry.attach('task-1:tab-1')).resolves.toMatchObject({ ok: false })
})

test('stop: ends exactly that attempt, and records who asked', async () => {
  const h = harness()
  h.resolver(async () => ({ ok: false, reason: 'task-elsewhere' }))
  h.registry.start()
  await vi.waitFor(() => expect(h.registry.list()).toHaveLength(1))
  await expect(h.registry.kill('task-1:tab-1')).resolves.toEqual({ ok: true })
  expect(h.killed).toEqual([['pc', 'task-1:tab-1', 'run-1']])
  expect(h.registry.list()).toEqual([])
  expect(diag.find((d) => d.event === 'pty.orphan_killed')).toMatchObject({
    payload: { computerId: 'pc', sessionId: 'task-1:tab-1', spawnId: 'run-1' }
  })
  await expect(h.registry.kill('task-1:tab-1')).resolves.toMatchObject({ ok: false })
})

test('a session the computer no longer lists leaves the registry', async () => {
  const h = harness()
  h.resolver(async () => ({ ok: false, reason: 'task-elsewhere' }))
  h.registry.start()
  await vi.waitFor(() => expect(h.registry.list()).toHaveLength(1))
  const changes = vi.fn()
  h.registry.onChange(changes)
  h.set([])
  expect(h.registry.list()).toEqual([])
  expect(changes).toHaveBeenCalled()
})
