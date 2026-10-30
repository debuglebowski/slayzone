import {
  createHubSessionStore,
  hubEntryOf,
  type HubSession,
  type SessionStorage
} from './hub-session'

/** The keychain, in memory. */
function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const storage: SessionStorage = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value)
    },
    delete: async (key) => {
      values.delete(key)
    }
  }
  return { storage, values }
}

const session = (address: string, token: string): HubSession => ({
  entry: hubEntryOf(address),
  token
})

const addresses = (sessions: HubSession[]) => sessions.map((s) => s.entry.label)

describe('hub sessions in the keychain', () => {
  it('keeps nothing until a sign-in', async () => {
    const store = createHubSessionStore(memoryStorage().storage)
    expect(await store.restore()).toEqual([])
  })

  it('restores every signed-in hub, in sign-in order, with its own bearer', async () => {
    const { storage } = memoryStorage()
    const store = createHubSessionStore(storage)
    await store.save(session('home.example', 't-home'))
    await store.save(session('work.example:8788', 't-work'))

    const restored = await createHubSessionStore(storage).restore()
    expect(addresses(restored)).toEqual(['home.example', 'work.example:8788'])
    expect(restored.map((s) => s.token)).toEqual(['t-home', 't-work'])
    expect(restored[1].entry).toEqual(hubEntryOf('work.example:8788'))
  })

  it('signing in again to a listed hub replaces its bearer and keeps its place', async () => {
    const store = createHubSessionStore(memoryStorage().storage)
    await store.save(session('home.example', 'old'))
    await store.save(session('work.example', 't-work'))
    await store.save(session('home.example', 'new'))

    const restored = await store.restore()
    expect(addresses(restored)).toEqual(['home.example', 'work.example'])
    expect(restored[0].token).toBe('new')
  })

  it('signing out of one hub forgets only its bearer', async () => {
    const { storage, values } = memoryStorage()
    const store = createHubSessionStore(storage)
    await store.save(session('home.example', 't-home'))
    await store.save(session('work.example', 't-work'))

    await store.forget(hubEntryOf('home.example').id)

    expect(addresses(await store.restore())).toEqual(['work.example'])
    expect([...values.values()]).not.toContain('t-home')
  })

  it('moves the single session of earlier versions into the list', async () => {
    const legacy = session('home.example', 't-home')
    const { storage, values } = memoryStorage({
      'last-hub': 'home.example',
      [`hub-token.${legacy.entry.id.replace(/[^A-Za-z0-9._-]/g, '_')}`]: 't-home'
    })
    const store = createHubSessionStore(storage)

    expect(await store.restore()).toEqual([legacy])
    expect(values.has('last-hub')).toBe(false)
    // Migrated once: later launches read the list.
    expect(await createHubSessionStore(storage).restore()).toEqual([legacy])
  })

  it('skips a listed hub whose bearer is gone, and keeps its place for a sign-in', async () => {
    const { storage, values } = memoryStorage()
    const store = createHubSessionStore(storage)
    await store.save(session('home.example', 't-home'))
    await store.save(session('work.example', 't-work'))
    for (const [key, value] of values) if (value === 't-home') values.delete(key)

    expect(addresses(await store.restore())).toEqual(['work.example'])
    await store.save(session('home.example', 'again'))
    expect(addresses(await store.restore())).toEqual(['home.example', 'work.example'])
  })

  it('reads an unreadable list as no sessions', async () => {
    const store = createHubSessionStore(memoryStorage({ hubs: '{not json' }).storage)
    expect(await store.restore()).toEqual([])
  })

  it('keeps both of two sign-ins that finish at the same time', async () => {
    const store = createHubSessionStore(memoryStorage().storage)
    await Promise.all([
      store.save(session('home.example', 't-home')),
      store.save(session('work.example', 't-work'))
    ])
    expect(addresses(await store.restore()).sort()).toEqual(['home.example', 'work.example'])
  })
})
