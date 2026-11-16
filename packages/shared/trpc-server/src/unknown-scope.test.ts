/**
 * A request naming a task or project this hub does not have (another hub's, in a
 * multi-hub desktop) is refused at the hub as NOT_FOUND (404) with a message naming
 * it — not routed to this hub's default computer, and not the INTERNAL_SERVER_ERROR
 * an unknown throw becomes.
 */
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { describe, expect, it } from 'vitest'
import { UnknownScopeError } from '@slayzone/platform/path-scope'
import { publicProcedure, router } from './trpc'

const appRouter = router({
  unknown: publicProcedure.mutation(() => {
    throw new UnknownScopeError('project', 'p-other-hub')
  })
})

async function call(path: string) {
  const res = await fetchRequestHandler({
    endpoint: '/trpc',
    router: appRouter,
    req: new Request(`http://hub/trpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: null })
    }),
    createContext: () => ({}) as never
  })
  const body = (await res.json()).error.json as { message: string; data: { code: string } }
  return { status: res.status, body }
}

describe('an unknown task or project over tRPC', () => {
  it('is NOT_FOUND (404) naming it', async () => {
    const { status, body } = await call('unknown')
    expect(status).toBe(404)
    expect(body.data.code).toBe('NOT_FOUND')
    expect(body.message).toBe('project p-other-hub is not on this hub')
  })
})
