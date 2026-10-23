/**
 * The one "may principal P access project X" decision (T-16). Not wired into any
 * procedure yet (T-17/T-18 do that); these pin the rule they will rely on.
 *
 * Run with: npx vitest run --config packages/apps/app/vitest.config.ts \
 *   packages/domains/projects/src/server/project-access.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import { mayAccessProject, mayAccessProjectId } from './project-access'

const alice = { userId: 'user-alice' }
const bob = { userId: 'user-bob' }
const owned = { owner_user_id: alice.userId }
const unowned = { owner_user_id: null }

describe('mayAccessProject', () => {
  it('a hub without login (the desktop app) consults no ownership: everything, as before', () => {
    for (const principal of [null, alice, bob]) {
      expect(mayAccessProject({ authRequired: false, principal }, owned)).toBe(true)
      expect(mayAccessProject({ authRequired: false, principal }, unowned)).toBe(true)
    }
  })

  it('a hub with login: the owner, and nobody else', () => {
    expect(mayAccessProject({ authRequired: true, principal: alice }, owned)).toBe(true)
    expect(mayAccessProject({ authRequired: true, principal: bob }, owned)).toBe(false)
  })

  it('a hub with login: no principal → no access', () => {
    expect(mayAccessProject({ authRequired: true, principal: null }, owned)).toBe(false)
    expect(mayAccessProject({ authRequired: true, principal: null }, unowned)).toBe(false)
  })

  it('a hub with login: an unowned project is refused to everyone, not shown to all', () => {
    expect(mayAccessProject({ authRequired: true, principal: alice }, unowned)).toBe(false)
  })

  it('admin is not a key to content (O-6): role grants nothing', () => {
    const admin = { userId: 'user-admin', role: 'admin' as const }
    expect(mayAccessProject({ authRequired: true, principal: admin }, owned)).toBe(false)
  })

  it('takes a full Project / ctx.principal as-is (structural)', () => {
    const principal = { userId: alice.userId, role: 'user' as const, scopes: ['full'] as const }
    const project = { id: 'p', name: 'P', owner_user_id: alice.userId, sort_order: 0 }
    expect(mayAccessProject({ authRequired: true, principal }, project)).toBe(true)
  })
})

describe('mayAccessProjectId', () => {
  const db = (rows: Record<string, string | null>): SlayzoneDb =>
    ({
      async get(sql: string, params: unknown[] = []) {
        expect(sql).toMatch(/SELECT owner_user_id FROM projects WHERE id = \?/)
        const id = params[0] as string
        return id in rows ? { owner_user_id: rows[id] } : undefined
      }
    }) as unknown as SlayzoneDb

  it('loads the owner and applies the same rule', async () => {
    const d = db({ p1: alice.userId, p2: null })
    expect(await mayAccessProjectId(d, { authRequired: true, principal: alice }, 'p1')).toBe(true)
    expect(await mayAccessProjectId(d, { authRequired: true, principal: bob }, 'p1')).toBe(false)
    expect(await mayAccessProjectId(d, { authRequired: true, principal: alice }, 'p2')).toBe(false)
    expect(await mayAccessProjectId(d, { authRequired: false, principal: null }, 'p2')).toBe(true)
  })

  it('a project that does not exist: false, on any hub', async () => {
    const d = db({})
    expect(await mayAccessProjectId(d, { authRequired: true, principal: alice }, 'nope')).toBe(
      false
    )
    expect(await mayAccessProjectId(d, { authRequired: false, principal: null }, 'nope')).toBe(
      false
    )
  })
})
