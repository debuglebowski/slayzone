import { useEffect, useMemo, useState } from 'react'
import { useFederationOrNull } from './FederationProvider'

/**
 * Which hub something lives on, for marking it when the client lists more than
 * one hub (with one, there is nothing to tell apart).
 */
export interface HubBadge {
  hubId: string
  label: string
  /** The hub's identity color: a CSS color, stable while the hub list is. */
  color: string
  /** The hub's socket has been failing for `HUB_UNREACHABLE_GRACE_MS`. */
  unreachable: boolean
}

/** How long a hub's socket must keep failing before the hub reads unreachable:
 *  a reconnect blip should not grey anything out. */
export const HUB_UNREACHABLE_GRACE_MS = 2_000

/**
 * The color of the hub at `index` in the hub list. Golden-angle hue steps, so
 * every hub gets a hue far from all the others however many there are. A value,
 * like a project's color, not a theme token: it names a hub, not a role.
 */
export function hubBadgeColor(index: number): string {
  return `hsl(${Math.round((index * 137.508) % 360)} 70% 55%)`
}

const NONE: ReadonlySet<string> = new Set()

/** Every hub's badge in the nearest federation, by hub id; null with one hub or none. */
export function useHubBadges(): ReadonlyMap<string, HubBadge> | null {
  const fed = useFederationOrNull()
  const [unreachable, setUnreachable] = useState<ReadonlySet<string>>(NONE)

  useEffect(() => {
    if (!fed || fed.hubs.length < 2) return
    const mark = (hubId: string, down: boolean): void =>
      setUnreachable((prev) => {
        if (prev.has(hubId) === down) return prev
        const next = new Set(prev)
        if (down) next.add(hubId)
        else next.delete(hubId)
        return next
      })
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const unsubs: Array<() => void> = []
    for (const hub of fed.hubs) {
      const source = fed.resolve(hub.id)?.ws.wsClient.connectionState
      if (!source) continue
      const onState = (state: ReturnType<typeof source.get>): void => {
        const failing = state.state === 'connecting' && state.error !== null
        if (!failing) {
          clearTimeout(timers.get(hub.id))
          timers.delete(hub.id)
          mark(hub.id, false)
        } else if (!timers.has(hub.id)) {
          timers.set(
            hub.id,
            setTimeout(() => mark(hub.id, true), HUB_UNREACHABLE_GRACE_MS)
          )
        }
      }
      onState(source.get())
      const subscription = source.subscribe({ next: onState })
      unsubs.push(() => subscription.unsubscribe())
    }
    return () => {
      for (const unsub of unsubs) unsub()
      for (const timer of timers.values()) clearTimeout(timer)
    }
  }, [fed])

  const hubs = fed?.hubs
  return useMemo(() => {
    if (!hubs || hubs.length < 2) return null
    return new Map(
      hubs.map((hub, index) => [
        hub.id,
        {
          hubId: hub.id,
          label: hub.label,
          color: hubBadgeColor(index),
          unreachable: unreachable.has(hub.id)
        }
      ])
    )
  }, [hubs, unreachable])
}

/** The badge of one hub in the nearest federation; null with one hub or none. */
export function useHubBadge(hubId: string | null | undefined): HubBadge | null {
  const badges = useHubBadges()
  return (hubId && badges?.get(hubId)) || null
}
