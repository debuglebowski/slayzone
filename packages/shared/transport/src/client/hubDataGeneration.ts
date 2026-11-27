import { useEffect } from 'react'

/**
 * Reload when a hub's data was REPLACED (a backup restore), for every client of that
 * hub — any user, desktop or web — not only the admin who restored it.
 *
 * The hub reports an opaque `dataGeneration` in `hub.describe` (open, no restore
 * details; platform hub-data-generation.ts). It changes only when a restore was
 * swapped in, never on a plain restart. A client that saw one generation and then
 * sees another holds views of data that no longer exists: it reloads. A hub older
 * than the field sends none, and nothing happens.
 */

type DescribeClient = { hub: { describe: { query: () => Promise<unknown> } } }

const seen = new WeakMap<object, string>()

/** Record `answer`'s generation for `client`; true when it differs from one seen before. */
export function noteDataGeneration(client: object, answer: unknown): boolean {
  const generation =
    answer && typeof answer === 'object'
      ? (answer as { dataGeneration?: unknown }).dataGeneration
      : undefined
  if (typeof generation !== 'string') return false
  const previous = seen.get(client)
  seen.set(client, generation)
  return previous !== undefined && previous !== generation
}

/**
 * Ask `hub.describe` now, every `intervalMs` and whenever the window becomes visible;
 * call `onReplaced` once the generation changes. A hub that cannot answer (it is
 * restarting) is simply asked again. Returns the stop function.
 */
export function watchHubDataGeneration(opts: {
  client: DescribeClient
  onReplaced: () => void
  intervalMs?: number
}): () => void {
  let stopped = false
  let fired = false
  const check = (): void => {
    void opts.client.hub.describe.query().then(
      (answer) => {
        if (stopped || fired) return
        if (noteDataGeneration(opts.client, answer)) {
          fired = true
          opts.onReplaced()
        }
      },
      () => {
        // Down or restarting: the next tick asks again.
      }
    )
  }
  check()
  const timer = setInterval(check, opts.intervalMs ?? 15_000)
  const onVisible = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') check()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  return () => {
    stopped = true
    clearInterval(timer)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  }
}

/** Mount once per window: reloads it when the hub behind `client` had its data replaced. */
export function useReloadWhenHubDataReplaced(client: object): void {
  useEffect(
    () =>
      watchHubDataGeneration({
        client: client as DescribeClient,
        onReplaced: () => window.location.reload()
      }),
    [client]
  )
}
