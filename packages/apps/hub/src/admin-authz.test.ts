/**
 * T-15, the hub side of "open opens nothing new": the REST routes `REST_ADMIN_POLICY`
 * calls `open` are exactly the ones this hub's bearer gate lets through with no
 * session, and every route the gate lets through unverified is either `open` or an
 * admin route that verifies its caller (and the role) itself. The tRPC and MCP sides,
 * and the refusals themselves, are `api/src/admin-policy.test.ts`.
 */
import { describe, expect, test } from 'vitest'
import { REST_ADMIN_POLICY } from '@slayzone/api'
import { restAuthAction } from './rest-auth'

/** A concrete url for a route key (`GET /api/tasks/:id` → `/api/tasks/x`). */
const urlOf = (key: string): string => key.split(' ')[1]!.replace(/:[A-Za-z]+/g, 'x')

describe('REST open routes vs the bearer gate, on a hub that requires login', () => {
  const keys = Object.keys(REST_ADMIN_POLICY)
  const unverified = keys.filter(
    (k) => restAuthAction({ hubAuthRequired: true, url: urlOf(k) }) === 'allow'
  )

  test('every open route is reachable with no session', () => {
    for (const k of keys.filter((k) => REST_ADMIN_POLICY[k] === 'open')) {
      expect(unverified, k).toContain(k)
    }
  })

  test('nothing else is, except admin routes that verify their caller themselves', () => {
    const others = unverified.filter((k) => REST_ADMIN_POLICY[k] !== 'open')
    expect(others.sort()).toEqual([
      'DELETE /api/hub/users',
      'GET /api/hub/users',
      'PATCH /api/hub/users',
      'POST /api/computers/join-token',
      'POST /api/hub/users'
    ])
    for (const k of others) expect(REST_ADMIN_POLICY[k], k).toBe('admin')
  })

  test('/mcp needs a verified session', () => {
    expect(restAuthAction({ hubAuthRequired: true, url: '/mcp' })).toBe('verify')
  })
})
