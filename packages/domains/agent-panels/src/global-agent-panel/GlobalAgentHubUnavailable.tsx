import type { ReactNode } from 'react'
import { CloudOff } from 'lucide-react'
import { Button } from '@slayzone/ui'
import { useFederationOrNull } from '@slayzone/transport/client'

/** A window reads its hub registry once, at load: reloading is what reads it again. */
function reloadWindow(): void {
  window.location.reload()
}

/**
 * Shown in place of the global agent when this window can't reach the hub that owns
 * the project (its registry doesn't list that hub, or lists it without an address, or
 * failed to load). The agent runs on that hub, so there is nothing to show until the
 * window can reach it; an empty panel said nothing.
 */
export function GlobalAgentHubUnavailable({
  hubId,
  width,
  onRetry = reloadWindow
}: {
  /** The hub that owns the session, when known. */
  hubId?: string
  /** The side panel's width; omitted, it fills its container (the floating window). */
  width?: number
  onRetry?: () => void
}): ReactNode {
  const federation = useFederationOrNull()
  const label = hubId ? federation?.hubs.find((h) => h.id === hubId)?.label : undefined
  return (
    <div
      data-testid="global-agent-hub-unavailable"
      className="h-full w-full rounded-md bg-surface-1 border border-border overflow-hidden flex flex-col items-center justify-center gap-2 p-4 text-center"
      style={width === undefined ? undefined : { width }}
    >
      <CloudOff className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">
        Can't reach {label ?? "this project's hub"}
      </p>
      <p className="text-xs text-muted-foreground max-w-xs">
        The global agent runs on the hub that owns the project. Retry reloads this window and
        connects again.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}
