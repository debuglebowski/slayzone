/**
 * Ending an account's access also ends its direct-link capabilities
 * (docs/direct-link.md): disabled in the hub, or refused by SSO.
 */
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { createTrpcConnectionRegistry } from './trpc-connections.js'
import { createUserAccessRevoker } from './user-access.js'

const harness = await createTestHarness()

function revoker() {
  const revoked: string[] = []
  const registry = createTrpcConnectionRegistry()
  const access = createUserAccessRevoker({
    db: harness.slayDb,
    getGateway: () => null,
    connections: registry,
    revokeDirectGrants: async (userId) => {
      revoked.push(userId)
    },
    log: () => {}
  })
  return { access, revoked, stop: () => registry.stop() }
}

test('disabling an account revokes its direct-link grants', async () => {
  const { access, revoked, stop } = revoker()
  await access.revokeUser('u-disabled')
  expect(revoked).toEqual(['u-disabled'])
  stop()
})

test('an SSO refusal (sessions only, computers kept) revokes its direct-link grants too', async () => {
  const { access, revoked, stop } = revoker()
  await access.endSessions('u-refused')
  expect(revoked).toEqual(['u-refused'])
  stop()
})
