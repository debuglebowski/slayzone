import { CloudOff } from 'lucide-react'
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

/**
 * Badge naming the hub a tree project row lives on (2+ hubs only), tinted with
 * the hub's color. An unreachable hub says so with an icon.
 */
export function HubPill({ badge }: { badge: HubBadge }) {
  return (
    <span
      data-hub-badge={badge.label}
      title={badge.unreachable ? `${badge.label} is unreachable` : `Hub: ${badge.label}`}
      className="inline-flex h-[18px] max-w-[112px] shrink-0 items-center gap-1 rounded-md border px-1.5 text-[10px] font-semibold leading-none"
      style={{
        backgroundColor: `color-mix(in oklch, ${badge.color} 14%, transparent)`,
        borderColor: `color-mix(in oklch, ${badge.color} 40%, transparent)`,
        color: `color-mix(in oklch, ${badge.color} 60%, var(--foreground))`
      }}
    >
      {badge.unreachable && <CloudOff aria-label="unreachable" className="size-2.5 shrink-0" />}
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
