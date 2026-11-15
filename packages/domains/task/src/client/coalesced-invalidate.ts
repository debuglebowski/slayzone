import type { QueryClient, QueryKey } from '@tanstack/react-query'

/**
 * Re-read a query once per burst of change notices (FU5 computer stalls, request
 * fan-out). A task's sessions list hears "prompts changed" AND "sessions changed" for
 * one change, from every mounted instance; each used to `refetch()` — one re-read per
 * notice per instance, each a summaries read + ledger queries on the task's computer.
 * Every notice within `delayMs` of the first is one `invalidateQueries` (exact key):
 * one re-read for every observer of that query.
 */
const pendingByClient = new WeakMap<QueryClient, Map<string, ReturnType<typeof setTimeout>>>()

export function invalidateSoon(client: QueryClient, queryKey: QueryKey, delayMs = 50): void {
  let pending = pendingByClient.get(client)
  if (!pending) {
    pending = new Map()
    pendingByClient.set(client, pending)
  }
  const id = JSON.stringify(queryKey)
  if (pending.has(id)) return
  const own = pending
  own.set(
    id,
    setTimeout(() => {
      own.delete(id)
      void client.invalidateQueries({ queryKey, exact: true })
    }, delayMs)
  )
}
