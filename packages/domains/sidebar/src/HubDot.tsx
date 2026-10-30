import type { HubBadge } from '@slayzone/transport/client'

/** Corner dot in the hub's color: which hub a rail tile lives on (2+ hubs only). */
export function HubDot({ badge }: { badge: HubBadge }) {
  return (
    <span
      aria-hidden
      data-hub-badge={badge.label}
      className="pointer-events-none absolute -bottom-1 -right-1 z-40 size-2.5 rounded-full ring-2 ring-background"
      style={{ backgroundColor: badge.color }}
    />
  )
}

/** Tooltip suffix naming the hub, and saying when it is unreachable. */
export function HubTooltipSuffix({ badge }: { badge: HubBadge }) {
  return (
    <span className="text-muted-foreground">
      {' · '}
      {badge.label}
      {badge.unreachable && ' (unreachable)'}
    </span>
  )
}
