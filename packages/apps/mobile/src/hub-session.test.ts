import {
  createHubSessionStore,
  hubEntryOf,
  type HubSession,
  normalizeHubAddress,
  probeSignInOffer,
  type SessionStorage,
  signIn
} from './hub-session'

const mockKeychain = new Map<string, string>()
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => mockKeychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void mockKeychain.set(key, value),
  deleteItemAsync: async (key: string) => void mockKeychain.delete(key)
}))

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

describe('normalizeHubAddress: the hub address as people type or paste it', () => {
  it.each([
    ['hub.example.com', 'hub.example.com'],
    ['  hub.example.com  ', 'hub.example.com'],
    ['https://hub.example.com', 'hub.example.com'],
    ['http://hub.example.com:8788/', 'hub.example.com:8788'],
    ['hub.example.com/', 'hub.example.com'],
    ['https://hub.example.com/settings?x=1#y', 'hub.example.com'],
    ['Hub.Example.com', 'hub.example.com'],
    ['wss://Hub.example.com/trpc', 'hub.example.com'],
    ['127.0.0.1:8788', '127.0.0.1:8788'],
    ['[::1]:8788', '[::1]:8788']
  ])('%s → %s', (typed, address) => {
    expect(normalizeHubAddress(typed)).toBe(address)
  })
})

describe('signing in: what went wrong, in plain words', () => {
  interface Answer {
    status: number
    headers: { get: (name: string) => string | null }
    text: () => Promise<string>
  }
  const answer = (status: number, body: unknown, token: string | null = null): Answer => ({
    status,
    headers: { get: (name) => (name.toLowerCase() === 'set-auth-token' ? token : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  })
  const HEALTHY = { ok: true, switches: { enablePassword: true, enableSso: false } }
  let hub: (url: URL) => Answer | Promise<never>

  beforeEach(() => {
    mockKeychain.clear()
    global.fetch = jest.fn(async (input: string) => hub(new URL(input))) as unknown as typeof fetch
  })

  it('accepts the address as pasted (scheme, slash, capitals)', async () => {
    hub = (url) =>
      url.pathname === '/health' ? answer(200, HEALTHY) : answer(200, {}, 'the-token')
    const result = await signIn('https://Hub.example.com/', 'me@example.com', 'pw')
    expect(result).toEqual({
      ok: true,
      session: { entry: hubEntryOf('hub.example.com'), token: 'the-token' }
    })
  })

  it('a wrong password', async () => {
    hub = (url) =>
      url.pathname === '/health'
        ? answer(200, HEALTHY)
        : answer(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' })
    expect(await signIn('hub.example.com', 'me@example.com', 'nope')).toEqual({
      ok: false,
      error: 'Wrong email or password.'
    })
  })

  it('a 401 without a code is a wrong email or password too', async () => {
    hub = (url) => (url.pathname === '/health' ? answer(200, HEALTHY) : answer(401, 'nope'))
    expect(await signIn('hub.example.com', 'me@example.com', 'nope')).toEqual({
      ok: false,
      error: 'Wrong email or password.'
    })
  })

  it('no network or no such host: names the hub and what to check', async () => {
    hub = () => Promise.reject(new TypeError('Network request failed'))
    const result = await signIn('hub.example.com', 'me@example.com', 'pw')
    expect(result.ok).toBe(false)
    const error = result.ok ? '' : result.error
    expect(error).toMatch(/^Can't reach hub\.example\.com\. Check the address/)
    expect(error).not.toMatch(/Network request failed/)
  })

  it('a server that is not a hub (404, or not its /health)', async () => {
    hub = () => answer(404, '<html>Not found</html>')
    expect(await signIn('example.com', 'me@example.com', 'pw')).toEqual({
      ok: false,
      error: "example.com isn't a SlayZone hub. Check the address with whoever set up your hub."
    })
    hub = () => answer(200, '<html>Welcome</html>')
    expect(await signIn('example.com', 'me@example.com', 'pw')).toEqual({
      ok: false,
      error: "example.com isn't a SlayZone hub. Check the address with whoever set up your hub."
    })
  })

  it('a hub answering with a server error', async () => {
    hub = () => answer(502, 'Bad gateway')
    expect(await signIn('hub.example.com', 'me@example.com', 'pw')).toEqual({
      ok: false,
      error:
        'hub.example.com answered with an error (HTTP 502). Try again later, or tell whoever runs the hub.'
    })
  })

  it('an address that is not one', async () => {
    expect(await signIn('me@hub example', 'me@example.com', 'pw')).toEqual({
      ok: false,
      error: "Enter the hub's address, like hub.yourcompany.com or hub.yourcompany.com:8788."
    })
  })

  it('the offer probe says the same', async () => {
    hub = () => Promise.reject(new TypeError('Network request failed'))
    expect(await probeSignInOffer('https://hub.example.com/')).toMatchObject({
      ok: false,
      reason: 'hub',
      error: expect.stringMatching(/^Can't reach hub\.example\.com\./)
    })
  })
})
