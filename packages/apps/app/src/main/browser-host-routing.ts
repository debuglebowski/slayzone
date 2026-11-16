/**
 * Which subscribed renderers get a browser-host event.
 *
 * `engaged` (genuine user input in a web view) goes to the ONE window hosting the
 * view — the one the user is working in — so it is forwarded to the hub once, under
 * that window's client key; broadcasting it made "who used the task last" a race
 * between windows. If that window has no subscriber, the first subscriber takes it,
 * so idle-close still hears about the input. Every other event is broadcast.
 */
export function recipientsFor<T extends { id: number }>(
  event: string,
  payload: unknown,
  subscribers: readonly T[]
): T[] {
  if (event !== 'engaged') return [...subscribers]
  const hostId = (payload as { hostWebContentsId?: unknown } | null)?.hostWebContentsId
  const host = subscribers.find((s) => s.id === hostId)
  if (host) return [host]
  return subscribers.length ? [subscribers[0]] : []
}
