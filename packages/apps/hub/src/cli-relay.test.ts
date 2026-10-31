import { afterEach, expect, test } from 'vitest'
import { createHubCliRelay } from './cli-relay'
import { createComputerCliRelay } from '../../computer/src/cli-relay'
import { restPrincipalOf, restComputerOf } from '@slayzone/api'
import { withRestAuth } from './rest-auth'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

test('ownerless local computer works without login; revocation still denies it', async () => {
  let revoked = false
  const hub = createHubCliRelay({
    computer: async () => ({ owner_user_id: null, revoked_at: revoked ? 'now' : null }),
    account: async () => null,
    dispatch: (req, res) => gate(req, res)
  })
  const gate = withRestAuth({
    getHubAuthRequired: () => false,
    getHubAuth: () => null,
    getDb: () => null,
    resolveInternalPrincipal: hub.principalOf,
    next: (_req, res) => res.end('{}')
  })
  cleanup.push(() => hub.close())
  const relay = await createComputerCliRelay({ request: (m, p) => hub.request('local', m, p) })
  cleanup.push(() => relay.close())
  const capability = relay.issue()
  const headers = { authorization: `Bearer ${capability.token}` }
  expect((await fetch(`${relay.url}/api/tasks`, { headers })).status).toBe(200)
  revoked = true
  expect((await fetch(`${relay.url}/api/tasks`, { headers })).status).toBe(401)
})

test('relay binds current computer owner internally; forbids administrative and forged-auth paths', async () => {
  let enabled = true
  let revoked = false
  let owner: string | null = 'alice'
  const hub = createHubCliRelay({
    computer: async (id) =>
      id === 'c' ? { owner_user_id: owner, revoked_at: revoked ? 'now' : null } : null,
    account: async (id) => ({ userId: id, role: 'user', disabled: !enabled }),
    dispatch: (req, res) => gate(req, res)
  })
  const gate = withRestAuth({
    getHubAuthRequired: () => true,
    getHubAuth: () => null,
    getDb: () => null,
    resolveInternalPrincipal: hub.principalOf,
    next: (req, res) =>
      res.end(JSON.stringify({ user: restPrincipalOf(req)?.userId, computer: restComputerOf(req) }))
  })
  cleanup.push(() => hub.close())
  const relay = await createComputerCliRelay({ request: (m, p) => hub.request('c', m, p) })
  cleanup.push(() => relay.close())
  const capability = relay.issue()
  const request = (path: string) =>
    fetch(`${relay.url}${path}`, {
      headers: {
        authorization: `Bearer ${capability.token}`,
        'x-user-id': 'mallory',
        cookie: 'secret'
      }
    })
  expect(await (await request('/api/tasks')).json()).toEqual({ user: 'alice', computer: 'c' })
  owner = 'bob'
  expect(await (await request('/api/tasks')).json()).toEqual({ user: 'bob', computer: 'c' })
  for (const path of [
    '/api/auth/get-session',
    '/api/hub/users',
    '/api/computers/join-token',
    '/mcp',
    '/trpc'
  ]) {
    expect((await request(path)).status, path).toBe(403)
  }
  enabled = false
  expect((await request('/api/tasks')).status).toBe(401)
  enabled = true
  revoked = true
  expect((await request('/api/tasks')).status).toBe(401)
  revoked = false
  owner = null
  expect((await request('/api/tasks')).status).toBe(401)
})
