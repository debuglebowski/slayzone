/**
 * The hook rule's branches (T-18) — whose an agent hook event is on a hub with login —
 * with the access decision stubbed to "the reporter owns project pA / task tA". A warm
 * agent the pool still holds names a task that may not exist yet; it is decided by
 * where it was warmed (`unadoptedWarmAgent`), which a hub test cannot produce without
 * spawning a real agent. The rest runs on a real hub in
 * `apps/hub/src/owner-checks-http.test.ts`.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { setSecurityLogSink } from '@slayzone/platform/security-log'

/** Unadopted warm agents, by the task id they booted with. */
const placements = new Map<string, { projectId: string; computerId: string }>()
vi.mock('@slayzone/terminal/server', () => ({
  unadoptedWarmAgent: (taskId: string) => {
    const p = placements.get(taskId)
    return p ? { sessionId: `pool-of-${taskId}`, ...p } : null
  }
}))

const OWNED = new Set(['project:pA', 'task:tA'])
// The real module, with only the decision stubbed: everything else it exports
// (`hubStateRoots`, used by owner-scope.ts) stays real.
vi.mock('../../access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../access')>()),
  createAccessScope: () => ({
    allows: (r: { kind: string; id: string }) => OWNED.has(`${r.kind}:${r.id}`)
  })
}))

const { hookReporterMayTouch } = await import('./agent-hook-owner')

const db = {} as never
const A = { userId: 'u-a', computerId: 'comp-a' }
const lines: { event: string; detail: { reason: string } }[] = []

afterEach(() => {
  placements.clear()
  lines.length = 0
  setSecurityLogSink()
})

const may = (
  reporter: { userId: string | null; computerId: string | null } | undefined,
  targets: object
) => {
  setSecurityLogSink((l) => lines.push(JSON.parse(l)))
  return hookReporterMayTouch(db, reporter, targets, 'UserPromptSubmit')
}

describe('whose a hook event is', () => {
  test('the reporter’s own task: processed, nothing audited', async () => {
    expect(await may(A, { taskId: 'tA' })).toBe(true)
    expect(lines).toHaveLength(0)
  })

  test('someone else’s task: dropped with one audit line', async () => {
    expect(await may(A, { taskId: 'tB' })).toBe(false)
    expect(lines.filter((l) => l.event === 'authz.denied')).toHaveLength(1)
    expect(lines[0]!.detail.reason).toBe('not_owner')
  })

  test('no reporter (an unowned computer) or nothing named: dropped', async () => {
    expect(await may({ userId: null, computerId: 'comp-x' }, { taskId: 'tA' })).toBe(false)
    expect(lines[0]!.detail.reason).toBe('no_reporter')
    lines.length = 0
    expect(await may(undefined, { taskId: 'tA' })).toBe(false)
    lines.length = 0
    expect(await may(A, {})).toBe(false)
    expect(lines[0]!.detail.reason).toBe('ownerless')
  })

  test('a warm agent not adopted yet: its warm project decides, and only the computer holding it reports', async () => {
    placements.set('reserved-1', { projectId: 'pA', computerId: 'comp-a' })
    placements.set('reserved-2', { projectId: 'pB', computerId: 'comp-a' })
    expect(await may(A, { taskId: 'reserved-1' })).toBe(true)
    // The same owner's other computer did not warm it.
    expect(await may({ userId: 'u-a', computerId: 'comp-a2' }, { taskId: 'reserved-1' })).toBe(
      false
    )
    expect(lines[0]!.detail.reason).toBe('not_this_computer')
    lines.length = 0
    // Warmed for someone else's project.
    expect(await may(A, { taskId: 'reserved-2' })).toBe(false)
    expect(lines[0]!.detail.reason).toBe('not_owner')
    // Over REST (no computer) the project alone decides.
    expect(await may({ userId: 'u-a', computerId: null }, { taskId: 'reserved-1' })).toBe(true)
  })

  test('a task id no task and no warm agent has: dropped', async () => {
    expect(await may(A, { taskId: 'nobody-has-this' })).toBe(false)
    expect(lines[0]!.detail.reason).toBe('not_owner')
  })
})
