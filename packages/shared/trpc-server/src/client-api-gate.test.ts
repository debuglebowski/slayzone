/**
 * A hub refuses a client older than {@link MIN_CLIENT_API} on every procedure with
 * PRECONDITION_FAILED + `data.appCode: CLIENT_TOO_OLD`, so the app can say "update
 * SlayZone" instead of failing call by call. The client names its API version in the
 * `clientApi` query on its socket url; none = a client older than the contract = API 0. An in-process caller (no request) is
 * the hub's own code and is never refused.
 */
import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./api-version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api-version')>()),
  MIN_CLIENT_API: 2
}))

const { publicProcedure, router } = await import('./trpc')
const { CLIENT_TOO_OLD } = await import('./api-version')

const appRouter = router({
  ping: publicProcedure.query(() => 'pong')
})

function req(url: string): IncomingMessage {
  return { url, headers: {}, method: 'GET', socket: {} } as unknown as IncomingMessage
}

async function refusal(ctxReq: IncomingMessage | undefined): Promise<unknown> {
  const caller = appRouter.createCaller({ db: {} as never, dataRoot: '/x', req: ctxReq })
  return caller.ping().then(
    () => null,
    (err: unknown) => err
  )
}

describe('client API gate', () => {
  it('refuses a client that names no version (older than the contract)', async () => {
    const err = (await refusal(req('/trpc'))) as { code?: string; cause?: { code?: string } }
    expect(err).toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(err.cause?.code).toBe(CLIENT_TOO_OLD)
  })

  it('refuses a client below the minimum', async () => {
    expect(await refusal(req('/trpc?windowId=3&clientApi=1'))).toMatchObject({
      code: 'PRECONDITION_FAILED'
    })
  })

  it('serves a client at or above the minimum', async () => {
    expect(await refusal(req('/trpc?clientApi=2'))).toBeNull()
    expect(await refusal(req('/trpc?clientApi=7'))).toBeNull()
  })

  it('never refuses an in-process caller', async () => {
    expect(await refusal(undefined)).toBeNull()
  })
})

describe('client API gate on the wire', () => {
  it('carries CLIENT_TOO_OLD as data.appCode', async () => {
    const { fetchRequestHandler } = await import('@trpc/server/adapters/fetch')
    const res = await fetchRequestHandler({
      endpoint: '/trpc',
      router: appRouter,
      req: new Request('http://hub/trpc/ping?clientApi=1'),
      createContext: () => ({ db: {} as never, dataRoot: '/x', req: req('/trpc?clientApi=1') })
    })
    const body = (await res.json()) as { error: { json: { data: { appCode?: string } } } }
    expect(res.status).toBe(412)
    expect(body.error.json.data.appCode).toBe(CLIENT_TOO_OLD)
  })
})
