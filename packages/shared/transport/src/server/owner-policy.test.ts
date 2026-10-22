/**
 * The owner-check classification (T-17), against the LIVE router:
 *
 *   - exhaustiveness: every `user` and `admin` procedure (T-15's `admin-policy.ts`;
 *     `admin` ones since T-106) is marked id-checked, list-filtered or no-owned-input,
 *     nothing else is, and nothing marked is gone — an unmarked new procedure fails
 *     here by name;
 *   - each mark carries what the gate needs (ids / an output or event filter / a
 *     reason), and an id named in a `z.object` input exists in that schema, so a typo
 *     cannot silently check nothing;
 *   - at runtime an unmarked procedure is refused on a hub with login (fail closed),
 *     an admin is decided like anyone else, and a hub without login (the desktop
 *     app's) reads no rule at all.
 *
 * The decisions themselves run against a real database in `access.test.ts`, and the
 * two-user contract on a real hub in `apps/hub/src/owner-checks.test.ts`.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { z } from 'zod'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { TRPCError } from '@trpc/server'
import { appRouter } from './router'
import { setAuthGate } from './app-deps'
import { TRPC_ADMIN_POLICY } from './admin-policy'
import { checkOwnership } from './owner-gate'
import {
  TRPC_OWNER_POLICY,
  isCustomRef,
  isOwnerQuestion,
  valuesAt,
  type OwnerRule
} from './owner-policy'
import type { TrpcContext } from './context'

type ProcDef = { type: 'query' | 'mutation' | 'subscription'; inputs: z.ZodType[] }
const PROCS = appRouter._def.procedures as unknown as Record<string, { _def: ProcDef }>
/** The owner questions: every `user` and `admin` procedure (T-106), never `open`. */
const LIVE_USER = Object.keys(PROCS)
  .filter((p) => isOwnerQuestion(TRPC_ADMIN_POLICY[p]))
  .sort()

/** Live owner questions with no mark — the exhaustiveness check, as a function so
 *  it can itself be shown to catch one. */
const unmarked = (live: string[], policy: Record<string, OwnerRule>): string[] =>
  live.filter((p) => !(p in policy))

const NO_DB = new Proxy(
  {},
  {
    get() {
      throw new Error('no database in this test')
    }
  }
) as TrpcContext['db']

afterEach(() => {
  setAuthGate(() => false)
  setSecurityLogSink()
})

describe('exhaustiveness', () => {
  test('every live user and admin procedure is marked', () => {
    const missing = unmarked(LIVE_USER, TRPC_OWNER_POLICY)
    expect(missing, `unmarked (add to owner-policy.ts): ${missing.join(', ')}`).toEqual([])
  })

  test('nothing but live user and admin procedures is marked', () => {
    const extra = Object.keys(TRPC_OWNER_POLICY).filter((p) => !LIVE_USER.includes(p))
    expect(extra, `not a live user/admin procedure: ${extra.join(', ')}`).toEqual([])
  })

  test('every admin procedure is among them (T-106)', () => {
    const admin = Object.keys(PROCS).filter((p) => TRPC_ADMIN_POLICY[p] === 'admin')
    expect(admin.length).toBeGreaterThan(30)
    for (const p of admin) expect(TRPC_OWNER_POLICY[p], p).toBeDefined()
  })

  test('the check names an unmarked procedure', () => {
    expect(unmarked([...LIVE_USER, 'brandNew.procedure'], TRPC_OWNER_POLICY)).toEqual([
      'brandNew.procedure'
    ])
  })

  test('the surface is the size the policy was written against', () => {
    // A floor, not a pin: the router above is the real one.
    expect(LIVE_USER.length).toBeGreaterThan(600)
    const marks = Object.values(TRPC_OWNER_POLICY).map((r) => r.mark)
    for (const m of ['id-checked', 'list-filtered', 'no-owned-input'] as const) {
      expect(marks.filter((x) => x === m).length, m).toBeGreaterThan(20)
    }
  })
})

describe('each mark carries what the gate needs', () => {
  for (const path of LIVE_USER) {
    const rule = TRPC_OWNER_POLICY[path]
    if (!rule) continue
    const type = PROCS[path]!._def.type
    test(`${path} (${rule.mark})`, () => {
      if (rule.mark === 'id-checked') expect(rule.ids?.length ?? 0).toBeGreaterThan(0)
      if (rule.mark === 'no-owned-input') {
        expect(rule.why).toBeTruthy()
        expect(rule.ids ?? []).toEqual([])
        expect(rule.output ?? rule.events).toBeUndefined()
      }
      if (rule.mark === 'list-filtered') {
        // A list cuts its result; a subscription its events — never the other way.
        if (type === 'subscription') expect(rule.events, 'event filter').toBeTypeOf('function')
        else expect(rule.output, 'output filter').toBeTypeOf('function')
      }
      if (type !== 'subscription') expect(rule.events).toBeUndefined()
      if (type === 'subscription') expect(rule.output).toBeUndefined()
      for (const at of rule.needsOne ?? []) {
        expect(
          rule.ids?.some((r) => !isCustomRef(r) && r.at === at),
          `needsOne ${at}`
        ).toBe(true)
      }
    })
  }
})

/** The object schema behind an input, through `.optional()` / `.nullable()`. */
function objectShape(schema: z.ZodType | undefined): Record<string, unknown> | null {
  let s: unknown = schema
  for (let i = 0; i < 4 && s; i++) {
    if (s instanceof z.ZodObject) return s.shape as Record<string, unknown>
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) {
      s = (s as z.ZodOptional<z.ZodType>).unwrap()
      continue
    }
    return null
  }
  return null
}

describe('every id named in an object input exists in its schema', () => {
  for (const path of LIVE_USER) {
    const rule = TRPC_OWNER_POLICY[path]
    const inputs = PROCS[path]!._def.inputs
    const shape = objectShape(inputs[inputs.length - 1])
    if (!rule?.ids || !shape) continue
    test(path, () => {
      for (const r of rule.ids ?? []) {
        if (isCustomRef(r)) continue
        const head = r.at.split('.')[0]!.replace(/(\[\]|\{\})$/, '')
        expect(Object.keys(shape), `${r.at} in ${path}`).toContain(head)
      }
    })
  }
})

describe('reading ids out of an input', () => {
  test('dotted paths, arrays, record keys and the input itself', () => {
    expect(valuesAt({ taskId: 't1' }, 'taskId')).toEqual(['t1'])
    expect(valuesAt({ ids: ['a', 'b', 3] }, 'ids[]')).toEqual(['a', 'b'])
    expect(valuesAt([{ projectId: 'p1' }, { projectId: 'p2' }], '[].projectId')).toEqual([
      'p1',
      'p2'
    ])
    expect(valuesAt({ counts: { p1: 2, p2: 0 } }, 'counts{}')).toEqual(['p1', 'p2'])
    expect(valuesAt({ updates: { projectId: 'p9' } }, 'updates.projectId')).toEqual(['p9'])
    expect(valuesAt(['x', 'y'], '[]')).toEqual(['x', 'y'])
    expect(valuesAt('whole', '')).toEqual(['whole'])
  })

  test('absent, null and non-string ids are skipped (the handler decides if one is required)', () => {
    expect(valuesAt({}, 'taskId')).toEqual([])
    expect(valuesAt({ taskId: null }, 'taskId')).toEqual([])
    expect(valuesAt({ taskId: 7 }, 'taskId')).toEqual([])
    expect(valuesAt(undefined, 'taskId')).toEqual([])
    expect(valuesAt({ ids: 'not-an-array' }, 'ids[]')).toEqual([])
  })
})

describe('runtime', () => {
  const ctx = (userId: string | null): TrpcContext => ({
    db: NO_DB,
    dataRoot: '',
    principal: userId ? { userId, role: 'user', scopes: ['full'] } : null
  })
  const noInput = async (): Promise<unknown> => undefined

  test('a hub without login (the desktop app) reads no rule: every procedure passes untouched', async () => {
    setAuthGate(() => false)
    for (const path of [...LIVE_USER, 'brandNew.procedure']) {
      const check = await checkOwnership({
        ctx: ctx(null),
        path,
        type: PROCS[path]?._def.type ?? 'query',
        getRawInput: noInput
      })
      expect(check, path).toBeNull()
    }
  })

  test('on a hub with login an unmarked procedure is refused — fail closed, one audit line', async () => {
    setAuthGate(() => true)
    const lines: string[] = []
    setSecurityLogSink((l) => lines.push(l))
    TRPC_ADMIN_POLICY['brandNew.procedure'] = 'user'
    try {
      const err = await checkOwnership({
        ctx: ctx('u-a'),
        path: 'brandNew.procedure',
        type: 'query',
        getRawInput: noInput
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TRPCError)
      expect((err as TRPCError).code).toBe('FORBIDDEN')
      expect(lines).toHaveLength(1)
      const line = JSON.parse(lines[0]!) as { event: string; detail: { reason: string } }
      expect(line.event).toBe('authz.denied')
      expect(line.detail.reason).toBe('owner_unclassified')
    } finally {
      delete TRPC_ADMIN_POLICY['brandNew.procedure']
    }
  })

  test('open procedures are not owner questions', async () => {
    setAuthGate(() => true)
    for (const path of Object.keys(PROCS).filter((p) => TRPC_ADMIN_POLICY[p] === 'open')) {
      const check = await checkOwnership({
        ctx: ctx('u-a'),
        path,
        type: PROCS[path]!._def.type,
        getRawInput: noInput
      })
      expect(check, path).toBeNull()
    }
  })

  test('an admin is decided like anyone: NOT_FOUND on another user’s automation (T-106)', async () => {
    setAuthGate(() => true)
    const lines: string[] = []
    setSecurityLogSink((l) => lines.push(l))
    // The automation's project belongs to u-a; the caller is the hub's admin.
    const db = {
      get: async () => ({ owner_user_id: 'u-a' }),
      all: async () => []
    } as unknown as TrpcContext['db']
    for (const [path, input] of [
      ['automations.get', { id: 'au-1' }],
      ['automations.getByProject', { projectId: 'p-a' }],
      ['automations.runManual', { id: 'au-1' }]
    ] as const) {
      const err = await checkOwnership({
        ctx: {
          db,
          dataRoot: '',
          principal: { userId: 'u-admin', role: 'admin', scopes: ['full'] }
        },
        path,
        type: PROCS[path]!._def.type,
        getRawInput: async () => input
      }).catch((e: unknown) => e)
      expect((err as TRPCError).code, path).toBe('NOT_FOUND')
    }
    expect(lines.map((l) => JSON.parse(l).detail.reason)).toEqual([
      'not_owner',
      'not_owner',
      'not_owner'
    ])
    // The owner passes the same check.
    const own = await checkOwnership({
      ctx: { db, dataRoot: '', principal: { userId: 'u-a', role: 'user', scopes: ['full'] } },
      path: 'automations.get',
      type: 'query',
      getRawInput: async () => ({ id: 'au-1' })
    })
    expect(own).not.toBeNull()
  })

  test('needsOne: a call that would create an ownerless row is refused', async () => {
    setAuthGate(() => true)
    const lines: string[] = []
    setSecurityLogSink((l) => lines.push(l))
    const err = await checkOwnership({
      ctx: ctx('u-a'),
      path: 'processes.create',
      type: 'mutation',
      getRawInput: async () => ({ projectId: null, taskId: null, cwd: '/x', label: 'l' })
    }).catch((e: unknown) => e)
    expect((err as TRPCError).code).toBe('NOT_FOUND')
    expect(JSON.parse(lines[0]!).detail.reason).toBe('ownerless')
  })
})
