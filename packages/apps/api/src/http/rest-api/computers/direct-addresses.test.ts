/**
 * REST: GET /api/computers/direct-addresses (docs/direct-link.md). The desktop's
 * main process asks its hub which computer addresses the hub actually issued to this
 * caller before its renderer's CSP may name one: the renderer's word is never enough.
 */
import { describe, expect, test } from 'vitest'
import express from 'express'
import { createTestHarness } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { setAuthGate } from '@slayzone/trpc-server'
import { bindRestPrincipal } from '../principal.js'
import type { RestPrincipal } from '../types.js'
import { registerComputersDirectAddressesRoute } from './direct-addresses.js'

const h = await createTestHarness()
const issued: Record<string, string[]> = { 'user-a': ['box.example:7443'], '': ['open.example:1'] }

async function as(
  principal: RestPrincipal | null,
  wired = true
): Promise<{ status: number; body: unknown }> {
  const app = express()
  app.use((req, _res, next) => {
    if (principal) bindRestPrincipal(req, principal)
    next()
  })
  registerComputersDirectAddressesRoute(app, {
    db: h.slayDb,
    notifyRenderer: () => {},
    ...(wired
      ? {
          computers: {
            getHubUrl: () => null,
            directAddresses: (userId) => issued[userId ?? ''] ?? []
          }
        }
      : {})
  })
  const rest = await mountRestApp(app)
  try {
    return await rest.request('GET', '/api/computers/direct-addresses')
  } finally {
    await rest.close()
  }
}
const user = (userId: string): RestPrincipal => ({ userId, role: 'user', scopes: ['full'] })

describe('GET /api/computers/direct-addresses', () => {
  test('a hub with login: exactly the addresses issued to the caller; nothing unauthenticated', async () => {
    setAuthGate(() => true)
    try {
      expect(await as(user('user-a'))).toMatchObject({
        status: 200,
        body: { addresses: ['box.example:7443'] }
      })
      expect(await as(user('user-b'))).toMatchObject({ status: 200, body: { addresses: [] } })
      expect(await as(null)).toMatchObject({ status: 200, body: { addresses: [] } })
    } finally {
      setAuthGate(() => false)
    }
  })

  test('without login: the grants issued with no user', async () => {
    expect(await as(null)).toMatchObject({ status: 200, body: { addresses: ['open.example:1'] } })
  })

  test('a hub that issues no direct links answers none', async () => {
    expect(await as(user('user-a'), false)).toMatchObject({
      status: 200,
      body: { addresses: [] }
    })
  })
})
