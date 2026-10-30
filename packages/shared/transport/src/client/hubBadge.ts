import { useEffect, useState } from 'react'
import { useFederationOrNull } from './FederationProvider'
import { NO_SOCKET, useConnectionState } from './hubConnection'

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

/** The badge of a hub in the nearest federation; null with one hub or none. */
export function useHubBadge(hubId: string | null | undefined): HubBadge | null {
  const fed = useFederationOrNull()
  const hubs = fed?.hubs ?? []
  const index = hubId ? hubs.findIndex((h) => h.id === hubId) : -1
  const shown = hubs.length > 1 && index >= 0
  const resolved = shown && hubId ? fed?.resolve(hubId) : null
  const connection = useConnectionState(resolved?.ws.wsClient.connectionState ?? NO_SOCKET)
  const unreachable = useHeldFor(
    connection.status === 'connecting' && connection.error !== null,
    HUB_UNREACHABLE_GRACE_MS
  )
  if (!shown || !hubId) return null
  return { hubId, label: hubs[index].label, color: hubBadgeColor(index), unreachable }
}

/** `value` has been true for `ms` without a break. */
function useHeldFor(value: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false)
  // Each stretch counts its own time: a change restarts it (React's "adjust
  // state when a prop changes" pattern, during render).
  const [was, setWas] = useState(value)
  if (value !== was) {
    setWas(value)
    setHeld(false)
  }
  useEffect(() => {
    if (!value) return
    const timer = setTimeout(() => setHeld(true), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return value && held
}
