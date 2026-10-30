/**
 * Test-only helpers for the app's jest suites (never imported by app code).
 *
 * `trpcTest` is `createTrpcTest` (`@slayzone/transport/testing`: the real tRPC client
 * and React Query defaults over an in-memory backend) without garbage collection of
 * unused queries. A test unmounts its tree at the end, which starts each query's
 * collection timer (gcTime, 5 minutes by default), and jest does not exit while a timer
 * is pending. `gcTime: Infinity` arms no timer; each test builds its own QueryClient,
 * so nothing outlives the test that made it.
 */
import { createTrpcTest, type TrpcTest, type TrpcTestBackend } from '@slayzone/transport/testing'

export function trpcTest(backend: TrpcTestBackend): TrpcTest {
  const test = createTrpcTest(backend)
  const defaults = test.queryClient.getDefaultOptions()
  test.queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, gcTime: Number.POSITIVE_INFINITY }
  })
  return test
}

/** A promise that never settles: a request still in flight. */
export const pending = (): Promise<never> => new Promise<never>(() => undefined)
