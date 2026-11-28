/**
 * push router contract tests: a phone registers with a hub, picks what it wants to be
 * told, and unregisters. Each user sees and changes only their own phones. Exercised
 * via tRPC `createCaller` against the in-memory harness DB.
 */
import { afterEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { adoptLegacyPushDevices, pushRecipients } from './device-store.js'
import { pushRouter } from './router.js'

const h = await createTestHarness()
const principal = (userId: string) => ({ userId, role: 'user' as const, scopes: ['full' as const] })
const anon = pushRouter.createCaller({ db: h.slayDb, dataRoot: '' })
const userA = pushRouter.createCaller({ db: h.slayDb, dataRoot: '', principal: principal('a') })
const userB = pushRouter.createCaller({ db: h.slayDb, dataRoot: '', principal: principal('b') })

const token = (n: string) => `ExponentPushToken[${n}]`

afterEach(() => {
  h.db.prepare('DELETE FROM push_devices').run()
  delete process.env.SLAYZONE_HUB_ENABLE_PUSH
})

test('push: register, read prefs, change them, unregister', async () => {
  expect(await userA.status({ deviceId: 'phone' })).toEqual({ enabled: true, device: null })
  await userA.register({ deviceId: 'phone', token: token('1'), hubRef: 'hub-1' })
  expect(await userA.status({ deviceId: 'phone' })).toEqual({
    enabled: true,
    device: { ready: true, errors: true }
  })
  await userA.setPrefs({ deviceId: 'phone', errors: false })
  expect((await userA.status({ deviceId: 'phone' })).device).toEqual({ ready: true, errors: false })
  await userA.unregister({ deviceId: 'phone' })
  expect((await userA.status({ deviceId: 'phone' })).device).toBeNull()
})

test('push: registering again keeps the prefs and takes the new token', async () => {
  await userA.register({ deviceId: 'phone', token: token('1'), hubRef: 'hub-1' })
  await userA.setPrefs({ deviceId: 'phone', ready: false })
  await userA.register({ deviceId: 'phone', token: token('2'), hubRef: 'hub-1' })
  expect((await userA.status({ deviceId: 'phone' })).device).toEqual({ ready: false, errors: true })
  expect(await pushRecipients(h.slayDb, ['a'], 'error')).toEqual([
    { token: token('2'), hubRef: 'hub-1' }
  ])
})

test('push: a token signed in as someone else moves to them', async () => {
  await userA.register({ deviceId: 'phone', token: token('1'), hubRef: 'hub-1' })
  await userB.register({ deviceId: 'phone', token: token('1'), hubRef: 'hub-1' })
  expect((await userA.status({ deviceId: 'phone' })).device).toBeNull()
  expect(await pushRecipients(h.slayDb, ['a'], 'ready')).toEqual([])
  expect(await pushRecipients(h.slayDb, ['b'], 'ready')).toHaveLength(1)
})

test("push: a user cannot read or change another user's phone", async () => {
  await userA.register({ deviceId: 'phone', token: token('1'), hubRef: 'hub-1' })
  expect((await userB.status({ deviceId: 'phone' })).device).toBeNull()
  await userB.setPrefs({ deviceId: 'phone', ready: false })
  await userB.unregister({ deviceId: 'phone' })
  expect((await userA.status({ deviceId: 'phone' })).device).toEqual({ ready: true, errors: true })
})

test('push: recipients honour each kind', async () => {
  await userA.register({ deviceId: 'p1', token: token('1'), hubRef: 'h' })
  await userA.register({ deviceId: 'p2', token: token('2'), hubRef: 'h' })
  await userA.setPrefs({ deviceId: 'p2', ready: false })
  expect((await pushRecipients(h.slayDb, ['a'], 'ready')).map((r) => r.token)).toEqual([token('1')])
  expect((await pushRecipients(h.slayDb, ['a'], 'error')).map((r) => r.token).sort()).toEqual([
    token('1'),
    token('2')
  ])
})

test('push: a malformed token is refused', async () => {
  await expect(
    userA.register({ deviceId: 'phone', token: 'not-a-token', hubRef: 'h' })
  ).rejects.toThrow()
})

test('push: with the switch off, status says so and registering is refused', async () => {
  process.env.SLAYZONE_HUB_ENABLE_PUSH = '0'
  expect(await userA.status({ deviceId: 'phone' })).toEqual({ enabled: false, device: null })
  await expect(
    userA.register({ deviceId: 'phone', token: token('1'), hubRef: 'h' })
  ).rejects.toThrow(/SLAYZONE_HUB_ENABLE_PUSH=0/)
})

test('push: phones registered before login go to the first admin', async () => {
  await anon.register({ deviceId: 'phone', token: token('1'), hubRef: 'h' })
  expect(await adoptLegacyPushDevices(h.slayDb, 'admin')).toBe(1)
  expect(await pushRecipients(h.slayDb, ['admin'], 'ready')).toHaveLength(1)
  expect(await pushRecipients(h.slayDb, [''], 'ready')).toHaveLength(0)
})
