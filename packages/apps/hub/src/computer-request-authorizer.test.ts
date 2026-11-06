/**
 * G2: ONE owner check for every hub→computer request. The real placement (login on)
 * over the real gateway and a real computer dialer: for EVERY method in the frame
 * contract — so a new route cannot slip through — user B is refused on user A's
 * computer before anything is sent; A is not; and the hub's own work (no caller)
 * still reaches it (R7).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { createMemoryCredentialStore, HubDialer } from '@slayzone/computer-transport/client'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import { runWithSecurityContext } from '@slayzone/platform/security-log'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { startLoopbackHub } from '../../../domains/computer-transport/src/testing/loopback'
import { createComputerPlacement } from './computer-placement'
import { createComputerRequestAuthorizer } from './computer-request-authorizer'

const h = await createTestHarness()
h.db
  .prepare(
    `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at, owner_user_id)
     VALUES ('computer-1', 'a', 'darwin', '1', '[]', 1, 'userA')`
  )
  .run()

const placement = createComputerPlacement({ db: h.slayDb, requireLogin: true, usable: () => [] })
const hub = await startLoopbackHub({
  authorizeRequest: createComputerRequestAuthorizer(placement.gate)
})
const commands = vi.fn(async () => ({ ok: true }))
const dialer = new HubDialer({
  url: hub.url,
  identity: { name: 'a', platform: 'darwin', version: '0.0.0', capabilities: [] },
  credentialStore: createMemoryCredentialStore(),
  joinToken: 'jt-valid',
  heartbeatIntervalMs: 0,
  onHubRequest: commands
})
dialer.start()
await dialer.events.once('connected')
afterAll(async () => {
  await dialer.stop()
  await hub.close()
})

const as = <T>(actor: string | null, fn: () => Promise<T>) =>
  actor ? runWithSecurityContext({ actor, ip: null, route: null }, fn) : fn()

describe("every hub→computer method on A's computer", () => {
  const methods = Object.values(HubToComputerMethods)

  test('user B: refused, nothing sent', async () => {
    commands.mockClear()
    for (const method of methods) {
      await expect(
        as('userB', () => hub.gateway.request('computer-1', method, {})),
        method
      ).rejects.toThrow()
    }
    expect(commands).not.toHaveBeenCalled()
  })

  test('user A, and the hub itself (no caller): sent', async () => {
    commands.mockClear()
    for (const method of methods) {
      await as('userA', () => hub.gateway.request('computer-1', method, {}))
      await as(null, () => hub.gateway.request('computer-1', method, {}))
    }
    // Every request above resolved (a refusal would have thrown); the few the
    // dialer answers itself (ping) never reach the handler.
    expect(commands.mock.calls.length).toBeGreaterThan(methods.length)
  })
})

test('the composed hub builds its gateway with this authorizer', () => {
  const src = readFileSync(join(import.meta.dirname, 'composition.ts'), 'utf-8')
  expect(src).toMatch(/authorizeRequest: createComputerRequestAuthorizer\(placement\.gate\)/)
})
