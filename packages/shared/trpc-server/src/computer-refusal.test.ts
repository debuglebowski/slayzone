/**
 * Review 2, B3: a computer's refusal by its own policy — its path jail refused a
 * folder (`RpcError` with `refusedByComputer`, -32006) — reaches a client as a typed
 * conflict: tRPC `CONFLICT` (HTTP 409) with `data.appCode: COMPUTER_REFUSED` and the
 * computer's message, never the INTERNAL_SERVER_ERROR an unknown throw becomes. Any
 * other error keeps its shape.
 */
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { describe, expect, it } from 'vitest'
import { COMPUTER_REFUSED_RPC_CODE } from '@slayzone/platform/path-scope'
import { COMPUTER_FRAME_TOO_LARGE_RPC_CODE } from '@slayzone/platform/computer-frame-limit'
import { publicProcedure, router } from './trpc'

/** An `RpcError` as computer-transport builds it (structural: no domain import here). */
function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { name: 'RpcError', code })
}

const appRouter = router({
  refused: publicProcedure.mutation(() => {
    throw rpcError(
      COMPUTER_REFUSED_RPC_CODE,
      "path '/etc' is outside the folders of task t1; refused"
    )
  }),
  tooLarge: publicProcedure.mutation(() => {
    throw rpcError(
      COMPUTER_FRAME_TOO_LARGE_RPC_CODE,
      "reply to 'chat.request' is 211812345 bytes (202.0 MiB); the frame limit is 104857600 bytes (100.0 MiB)"
    )
  }),
  otherRpc: publicProcedure.mutation(() => {
    throw rpcError(-32603, 'internal')
  })
})

interface WireError {
  error: { message: string; data: { code: string; appCode?: string } }
}

async function call(path: string): Promise<{ status: number; body: WireError }> {
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
  // superjson envelope on the wire.
  return { status: res.status, body: { error: (await res.json()).error.json } }
}

describe('a computer refusal over tRPC', () => {
  it('is CONFLICT (409) with COMPUTER_REFUSED and the computer’s message', async () => {
    const { status, body } = await call('refused')
    expect(status).toBe(409)
    expect(body.error.data).toMatchObject({ code: 'CONFLICT', appCode: 'COMPUTER_REFUSED' })
    expect(body.error.message).toMatch(/outside the folders of task t1/)
  })

  it('a frame over the computer link limit is PAYLOAD_TOO_LARGE (413) with COMPUTER_FRAME_TOO_LARGE', async () => {
    const { status, body } = await call('tooLarge')
    expect(status).toBe(413)
    expect(body.error.data).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      appCode: 'COMPUTER_FRAME_TOO_LARGE'
    })
    expect(body.error.message).toMatch(/reply to 'chat\.request' is 211812345 bytes/)
  })

  it('leaves every other error as it was', async () => {
    const { status, body } = await call('otherRpc')
    expect(status).toBe(500)
    expect(body.error.data.code).toBe('INTERNAL_SERVER_ERROR')
    expect(body.error.data.appCode).toBeUndefined()
  })
})
