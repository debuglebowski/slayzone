/** Local request lifetime; only its RPC request id crosses the computer transport. */
import { AsyncLocalStorage } from 'node:async_hooks'
const requestAbort = new AsyncLocalStorage<AbortSignal | undefined>()
export const currentRequestAbort = (): AbortSignal | undefined => requestAbort.getStore()
export function runWithRequestAbort<T>(signal: AbortSignal | undefined, action: () => T): T {
  return requestAbort.run(signal, action)
}
