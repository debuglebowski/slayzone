/**
 * Review L2: unattached terminal sessions (a previous hub run's, still running on a
 * computer) carry their task and conversation. The computer's owner manages them —
 * and, when the session belongs to a task, only one who may access that task too.
 * Two principals: A owns computer `pc-a` and task `t-a`; B owns task `t-b`, which runs
 * on A's computer.
 */
import { describe, expect, test } from 'vitest'
import type { AccessScope, OwnedResource } from './access'
import { TRPC_OWNER_POLICY, isCustomRef, type OwnerRule } from './owner-policy'
import { REST_OWNER_POLICY } from './http-owner-policy'
import { firstDeniedRef } from './http/owner-scope'
import type { SlayzoneDb } from '@slayzone/platform'

const scopeOf = (allowed: string[]): AccessScope => {
  const ok = (r: OwnedResource) => allowed.includes(`${r.kind}:${r.id}`)
  return {
    enforcing: true,
    allows: ok,
    allowsAll: async (rs) => rs.every(ok),
    filter: async (rows, to) =>
      rows.filter((row) => {
        const r = to(row)
        return r !== null && ok(r)
      }),
    accessibleProjectIds: async () => null
  }
}
// A: its computer and its own task's session. Not B's task.
const A = scopeOf(['computer:pc-a', 'session:t-a:t-a'])

const rows = [
  { computerId: 'pc-a', sessionId: 't-a:t-a' },
  { computerId: 'pc-a', sessionId: 't-b:t-b' },
  { computerId: 'pc-a', sessionId: 'pooled-no-task' },
  { computerId: 'pc-b', sessionId: 't-a:t-a' }
]
const idsOf = (rule: OwnerRule, input: unknown): string[] =>
  (rule.ids ?? []).flatMap((r) =>
    isCustomRef(r) ? r.pick(input).map((x) => `${x.kind}:${x.id}`) : []
  )

describe('unattached sessions: computer AND (when it has one) task', () => {
  test("tRPC list: only rows on the caller's computer whose task (if any) is theirs", async () => {
    const out = await TRPC_OWNER_POLICY['pty.unattachedList']!.output!(rows, A)
    expect(out).toEqual([
      { computerId: 'pc-a', sessionId: 't-a:t-a' },
      { computerId: 'pc-a', sessionId: 'pooled-no-task' }
    ])
  })

  test('tRPC attach / stop name the computer, plus the session when it maps to a task', () => {
    for (const path of ['pty.unattachedAttach', 'pty.unattachedKill']) {
      const rule = TRPC_OWNER_POLICY[path]!
      expect(idsOf(rule, { computerId: 'pc-a', sessionId: 't-b:t-b' })).toEqual([
        'computer:pc-a',
        'session:t-b:t-b'
      ])
      expect(idsOf(rule, { computerId: 'pc-a', sessionId: 'pooled-no-task' })).toEqual([
        'computer:pc-a'
      ])
    }
  })

  test('REST list is cut the same way; attach / stop check the session too', async () => {
    const out = await REST_OWNER_POLICY['GET /api/pty/unattached']!.output!(rows, A)
    expect(out).toEqual([
      { computerId: 'pc-a', sessionId: 't-a:t-a' },
      { computerId: 'pc-a', sessionId: 'pooled-no-task' }
    ])
    for (const route of [
      'POST /api/pty/unattached/:computerId/:sessionId/attach',
      'DELETE /api/pty/unattached/:computerId/:sessionId'
    ]) {
      expect(REST_OWNER_POLICY[route]!.ids?.map((r) => `${r.kind}@${r.at}`)).toEqual([
        'computer@params.computerId',
        'session@params.sessionId'
      ])
    }
  })

  test('REST attach / stop admit pooled ids on the owned computer, but enforce both owners for task ids', async () => {
    for (const route of [
      'POST /api/pty/unattached/:computerId/:sessionId/attach',
      'DELETE /api/pty/unattached/:computerId/:sessionId'
    ]) {
      const refs = REST_OWNER_POLICY[route]!.ids!
      for (const row of rows) {
        const denied = await firstDeniedRef({} as SlayzoneDb, A, refs, { params: row })
        expect(denied === null, `${route}: ${row.computerId}/${row.sessionId}`).toBe(
          row.computerId === 'pc-a' && row.sessionId !== 't-b:t-b'
        )
      }
    }
  })
})
