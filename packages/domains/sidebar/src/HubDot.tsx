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

/** Pill naming the hub a tree project row lives on (2+ hubs only). */
export function HubPill({ badge }: { badge: HubBadge }) {
  return (
    <span
      data-hub-badge={badge.label}
      title={badge.unreachable ? `${badge.label} is unreachable` : undefined}
      className="flex h-4 max-w-[96px] shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 text-[10px] font-medium leading-none text-muted-foreground"
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: badge.color }} />
      <span className="truncate">{badge.label}</span>
    </span>
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
