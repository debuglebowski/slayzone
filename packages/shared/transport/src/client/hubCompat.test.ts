/**
 * The client's half of the client ↔ hub API contract (`@slayzone/trpc-server/api-version`):
 *
 * - `hubHasFeature`: a feature the hub lists in `features` — or, for a hub from before
 *   `features`, the `wire` flag that said the same.
 * - `knownApiIncompatibility`: what the last `hub.describe` answer said about the
 *   versions, synchronously; null while nothing is known.
 * - `hubCompatLink`: nothing but `hub.describe` goes to a hub known to be incompatible,
 *   and a NOT_FOUND for a procedure an older hub lacks reads "update the hub".
 */
import { TRPCClientError } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@slayzone/trpc-server/api-version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/trpc-server/api-version')>()),
  HUB_API_VERSION: 3,
  MIN_HUB_API: 2
}))

const { hubHasFeature, knownApiIncompatibility, rememberDescribe } = await import(
  './hubCapabilities'
)
const { hubCompatLink } = await import('./hubCompatLink')
type RuntimeClient = import('./runtime').RuntimeClient

function fakeClient(answer: () => Promise<unknown>): RuntimeClient {
  return { hub: { describe: { query: vi.fn(answer) } } } as unknown as RuntimeClient
}

describe('hubHasFeature', () => {
  it('reads features', async () => {
    const client = fakeClient(async () => ({ features: ['compact-bytes'] }))
    expect(await hubHasFeature(client, 'compact-bytes')).toBe(true)
    expect(await hubHasFeature(client, 'tool-previews')).toBe(false)
  })
  it('falls back to the wire flag a hub from before `features` sent', async () => {
    const client = fakeClient(async () => ({ wire: { compactBytes: true, toolPreviews: true } }))
    expect(await hubHasFeature(client, 'compact-bytes')).toBe(true)
    expect(await hubHasFeature(client, 'tool-previews')).toBe(true)
  })
  it('is false for a hub that says neither, and for one that cannot be asked', async () => {
    expect(
      await hubHasFeature(
        fakeClient(async () => ({})),
        'compact-bytes'
      )
    ).toBe(false)
    const down = fakeClient(() => Promise.reject(new Error('down')))
    expect(await hubHasFeature(down, 'compact-bytes')).toBe(false)
  })
})

describe('knownApiIncompatibility', () => {
  it('is null until the hub answered', () => {
    expect(knownApiIncompatibility(fakeClient(() => new Promise(() => {})))).toBeNull()
  })
  it('names a hub below this client’s minimum once it answered', async () => {
    const client = fakeClient(async () => ({ version: '0.43.0' }))
    await hubHasFeature(client, 'compact-bytes')
    expect(knownApiIncompatibility(client)).toMatchObject({ side: 'hub', hubApi: 0, minHubApi: 2 })
  })
  it('names the app when the hub no longer serves this client', async () => {
    const client = fakeClient(async () => ({ api: { version: 5, minClient: 4 } }))
    await hubHasFeature(client, 'compact-bytes')
    expect(knownApiIncompatibility(client)).toMatchObject({ side: 'app', clientApi: 3 })
  })
  it('follows a fresh answer (the hub was upgraded behind the same socket)', async () => {
    const client = fakeClient(async () => ({ api: { version: 1, minClient: 0 } }))
    await hubHasFeature(client, 'compact-bytes')
    expect(knownApiIncompatibility(client)?.side).toBe('hub')
    rememberDescribe(client, { api: { version: 3, minClient: 1 } })
    expect(knownApiIncompatibility(client)).toBeNull()
  })
})

type Op = { type: 'query'; path: string; input: unknown; id: number; context: object; signal: null }
const op = (path: string): Op => ({
  type: 'query',
  path,
  input: null,
  id: 1,
  context: {},
  signal: null
})

function run(
  link: ReturnType<typeof hubCompatLink>,
  path: string,
  downstream: (o: Op) => ReturnType<typeof observable>
): Promise<{ ok: true; value: unknown } | { ok: false; err: TRPCClientError<never> }> {
  return new Promise((resolve) => {
    const chain = (link as unknown as (r: object) => (a: object) => ReturnType<typeof observable>)(
      {}
    )
    chain({ op: op(path), next: downstream }).subscribe({
      next: (v: unknown) => resolve({ ok: true, value: v }),
      error: (err: unknown) => resolve({ ok: false, err: err as TRPCClientError<never> })
    })
  })
}

const answer = (value: unknown) => () =>
  observable((o) => {
    o.next({ result: { data: value } })
    o.complete()
  })

describe('hubCompatLink', () => {
  it('passes everything through while compatibility is unknown or fine', async () => {
    const link = hubCompatLink({ incompatibility: () => null })
    expect(await run(link, 'tasks.list', answer([]))).toMatchObject({ ok: true })
  })

  it('sends a hub known to be too old nothing but hub.describe', async () => {
    const next = vi.fn(answer('x'))
    const link = hubCompatLink({
      incompatibility: () => ({ side: 'hub', hubApi: 1, minHubApi: 2, release: '0.43.0' })
    })
    const refused = await run(link, 'tasks.list', next)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.err.message).toMatch(/hub.*0\.43\.0.*update the hub/i)
    expect(next).not.toHaveBeenCalled()
    expect(await run(link, 'hub.describe', next)).toMatchObject({ ok: true })
  })

  it('says "update SlayZone" when the hub no longer serves this app', async () => {
    const link = hubCompatLink({
      incompatibility: () => ({ side: 'app', clientApi: 1, minClientApi: 2, release: '0.50.0' })
    })
    const refused = await run(link, 'tasks.list', answer('x'))
    if (!refused.ok) expect(refused.err.message).toMatch(/update SlayZone/)
    else expect.unreachable()
  })

  it('turns a NOT_FOUND for a missing procedure into "the hub is too old for this"', async () => {
    const link = hubCompatLink({ incompatibility: () => null })
    const missing = () =>
      observable((o) => {
        o.error(
          TRPCClientError.from({
            error: {
              message: 'No "query"-procedure on path "tasks.brandNew"',
              code: -32004,
              data: { code: 'NOT_FOUND', httpStatus: 404 }
            }
          })
        )
      })
    const res = await run(link, 'tasks.brandNew', missing)
    if (res.ok) expect.unreachable()
    else {
      expect(res.err.message).toMatch(/tasks\.brandNew.*update the hub/i)
      expect(res.err.data).toMatchObject({ code: 'NOT_FOUND' })
    }
  })

  it('leaves any other NOT_FOUND alone', async () => {
    const link = hubCompatLink({ incompatibility: () => null })
    const notFound = () =>
      observable((o) => {
        o.error(
          TRPCClientError.from({
            error: { message: 'task t1 not found', code: -32004, data: { code: 'NOT_FOUND' } }
          })
        )
      })
    const res = await run(link, 'tasks.get', notFound)
    if (res.ok) expect.unreachable()
    else expect(res.err.message).toBe('task t1 not found')
  })
})

describe('hub health: an incompatible hub', () => {
  type State = { type: 'state'; state: 'pending' | 'idle' | 'connecting'; error: null }
  const OPEN: State = { type: 'state', state: 'pending', error: null }

  async function healthOf(answer: unknown) {
    const { behaviorSubject } = await import('@trpc/server/observable')
    const { watchHubHealth } = await import('./hubIssues')
    const source = behaviorSubject<State>(OPEN) as never
    const reports: unknown[] = []
    const stop = watchHubHealth({
      source,
      describe: () => Promise.resolve(answer),
      onHealth: (h) => reports.push(h)
    })
    await new Promise((r) => setTimeout(r, 0))
    stop()
    return reports.at(-1)
  }

  it('a hub below this client’s minimum is incompatible on the hub’s side', async () => {
    expect(await healthOf({ version: '0.43.0', authRequired: false })).toMatchObject({
      kind: 'incompatible',
      side: 'hub',
      release: '0.43.0'
    })
  })

  it('a hub that no longer serves this client is incompatible on the app’s side — before sign-in', async () => {
    expect(
      await healthOf({ api: { version: 6, minClient: 4 }, authRequired: true, scopes: null })
    ).toMatchObject({ kind: 'incompatible', side: 'app' })
  })

  it('a compatible hub is ok and says its release', async () => {
    expect(
      await healthOf({ version: '0.50.0', api: { version: 3, minClient: 1 }, authRequired: false })
    ).toEqual({ kind: 'ok', authRequired: false, release: '0.50.0' })
  })
})
