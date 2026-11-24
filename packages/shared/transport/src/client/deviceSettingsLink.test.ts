import { describe, expect, it } from 'vitest'
import { createTRPCClient, type TRPCLink } from '@trpc/client'
import type { AnyTRPCRouter } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { deviceSettingsLink } from './deviceSettingsLink'

/** A hub: a settings map, recording every operation that reaches it. */
function fakeHub(settings: Record<string, string>) {
  const calls: Array<{ path: string; input: unknown }> = []
  const link: TRPCLink<AnyTRPCRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        calls.push({ path: op.path, input: op.input })
        const input = op.input as { key: string; value: string }
        let data: unknown = null
        if (op.path === 'settings.get') data = settings[input.key] ?? null
        if (op.path === 'settings.getAll') data = { ...settings }
        if (op.path === 'settings.set') settings[input.key] = input.value
        observer.next({ result: { type: 'data', data } } as never)
        observer.complete()
      })
  return { link, calls, settings }
}

function storage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v)
  }
}

const isDeviceKey = (k: string) => k.startsWith('font')

function client(hub: ReturnType<typeof fakeHub>, store: ReturnType<typeof storage>) {
  // Untyped on purpose: the paths are what the link keys on.
  return createTRPCClient<AnyTRPCRouter>({
    links: [deviceSettingsLink({ isDeviceKey, storage: store }), hub.link]
  }) as unknown as {
    settings: {
      get: { query: (i: { key: string }) => Promise<string | null> }
      set: { mutate: (i: { key: string; value: string }) => Promise<unknown> }
      getAll: { query: () => Promise<Record<string, string>> }
    }
  }
}

describe('deviceSettingsLink', () => {
  it("copies the hub's value on the first read, then keeps the device's own", async () => {
    const hub = fakeHub({ font: '13' })
    const store = storage()
    const c = client(hub, store)
    expect(await c.settings.get.query({ key: 'font' })).toBe('13')
    hub.settings.font = '20' // another device writes the hub
    expect(await c.settings.get.query({ key: 'font' })).toBe('13')
    expect(hub.calls.filter((x) => x.path === 'settings.get')).toHaveLength(1)
  })

  it('writes go to the device and still to the hub', async () => {
    const hub = fakeHub({})
    const store = storage()
    const c = client(hub, store)
    await c.settings.set.mutate({ key: 'font', value: '15' })
    expect(store.getItem('slayzone:device-setting:font')).toBe('15')
    expect(hub.settings.font).toBe('15')
  })

  it("lays the device's values over getAll", async () => {
    const hub = fakeHub({ font: '20', panels: 'a' })
    const store = storage()
    store.setItem('slayzone:device-setting:font', '11')
    const c = client(hub, store)
    expect(await c.settings.getAll.query()).toEqual({ font: '11', panels: 'a' })
  })

  it('leaves every other key to the hub', async () => {
    const hub = fakeHub({ panels: 'a' })
    const store = storage()
    const c = client(hub, store)
    expect(await c.settings.get.query({ key: 'panels' })).toBe('a')
    await c.settings.set.mutate({ key: 'panels', value: 'b' })
    expect(store.map.size).toBe(0)
  })
})
