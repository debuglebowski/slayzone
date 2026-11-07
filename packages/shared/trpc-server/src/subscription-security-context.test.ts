/**
 * Round-5 K7: the caller's security context (who is asking — what the hub's owner
 * check at the computer gateway reads) is set around a procedure's resolver. A
 * subscription's body runs LATER — when it is subscribed to, or each time its
 * generator is pulled — outside that scope, with no caller: `fileEditor.watch`'s
 * fs.watchStart passed the owner check as if the hub itself had asked. The context
 * is carried into the body.
 */
import { observable } from '@trpc/server/observable'
import { describe, expect, it } from 'vitest'
import { currentSecurityContext } from '@slayzone/platform/security-log'
import { openProcedure, router } from './trpc'

const seen: Array<string | null> = []
const actor = () => currentSecurityContext()?.actor ?? null

const appRouter = router({
  watchObservable: openProcedure.subscription(() =>
    observable<number>((emit) => {
      seen.push(actor())
      // Work started from the body — a request to a computer — keeps the caller too.
      void Promise.resolve().then(() => {
        seen.push(actor())
        emit.next(1)
      })
      return () => undefined
    })
  ),
  watchGenerator: openProcedure.subscription(async function* () {
    await Promise.resolve()
    seen.push(actor())
    yield 1
  })
})

const caller = appRouter.createCaller({ principal: { userId: 'user-B' } } as never)

describe("a subscription's body runs as its caller", () => {
  it('an observable, and what it starts', async () => {
    seen.length = 0
    const obs = (await caller.watchObservable()) as unknown as {
      subscribe: (o: { next: (v: number) => void }) => { unsubscribe: () => void }
    }
    const got = await new Promise<number>((resolve) => {
      const sub = obs.subscribe({ next: (v) => resolve(v) })
      void Promise.resolve().then(() => sub)
    })
    expect(got).toBe(1)
    expect(seen).toEqual(['user-B', 'user-B'])
  })

  it('an async generator, pulled later', async () => {
    seen.length = 0
    const iterable = (await caller.watchGenerator()) as unknown as AsyncIterable<number>
    const out: number[] = []
    for await (const v of iterable) out.push(v)
    expect(out).toEqual([1])
    expect(seen).toEqual(['user-B'])
  })
})
