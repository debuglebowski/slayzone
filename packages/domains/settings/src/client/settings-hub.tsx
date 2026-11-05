import { createContext, useContext, useState, type ReactNode } from 'react'
import { HubScope, useFederationOrNull } from '@slayzone/transport/client'
import type { HubEntry } from '@slayzone/platform/hub-registry'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'

/**
 * Which hub the Settings dialog's HUB-WIDE sections edit.
 *
 * Settings live on hubs, and a key is read from one of two places. Some are read
 * through the hub that OWNS the work: by that hub's own server code (`settings-core`
 * `scope.ts` `hub` keys — task-create defaults, worktree behaviour, the idle-close
 * sweep, agent startup) or by a client surface running inside that hub's `HubScope`
 * (the worktree copy dialog's presets). The rest are this client's own UI (fonts,
 * layout, panels), read from the DEFAULT hub only. The dialog's ambient tRPC is the
 * default hub, which left a remote hub's settings of the first kind unreachable from
 * the desktop.
 *
 * So the picker moves only the sections wrapped in `<HubWideSection>`, which mount the
 * picked hub's client + QueryClient through `<HubScope>`. Everything else stays on the
 * default hub: scoping a whole tab would send a font size to a remote hub that this
 * client never reads it back from.
 *
 * On the default hub (or with one hub, or outside a provider) a section renders with
 * the dialog's own client, unchanged — byte-identical to the single-hub dialog.
 */

type SettingsHubValue = {
  /** Connected hubs a section can be pointed at (those with an address). */
  hubs: HubEntry[]
  defaultHubId: string
  /** The picked hub; the default hub when the picked one left the federation. */
  hubId: string
  setHubId: (hubId: string) => void
}

const SettingsHubContext = createContext<SettingsHubValue | null>(null)

export function SettingsHubProvider({ children }: { children: ReactNode }): ReactNode {
  const federation = useFederationOrNull()
  const [picked, setHubId] = useState<string | null>(null)
  if (!federation) return <>{children}</>
  const hubs = federation.hubs.filter((h) => !!h.url)
  const { defaultHubId } = federation
  const hubId = picked && hubs.some((h) => h.id === picked) ? picked : defaultHubId
  return (
    <SettingsHubContext.Provider value={{ hubs, defaultHubId, hubId, setHubId }}>
      {children}
    </SettingsHubContext.Provider>
  )
}

/** Whether there is more than one hub to choose between. */
function hasChoice(ctx: SettingsHubValue | null): ctx is SettingsHubValue {
  return !!ctx && ctx.hubs.length > 1
}

/** Header picker for the hub-wide sections. Nothing with a single hub. */
export function SettingsHubPicker(): ReactNode {
  const ctx = useContext(SettingsHubContext)
  if (!hasChoice(ctx)) return null
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">Hub settings for</span>
      <Select value={ctx.hubId} onValueChange={ctx.setHubId}>
        <SelectTrigger
          size="sm"
          className="h-7 min-w-36 text-xs"
          aria-label="Hub"
          data-testid="settings-hub-picker"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          {ctx.hubs.map((h) => (
            <SelectItem key={h.id} value={h.id}>
              {h.label}
              {h.id === ctx.defaultHubId ? ' (default)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * A section that edits hub-wide settings: bound to the picked hub. Remounts on a hub
 * switch (`key`), so its controls re-seed from the new hub instead of carrying the
 * previous hub's local edits over.
 */
export function HubWideSection({ children }: { children: ReactNode }): ReactNode {
  const ctx = useContext(SettingsHubContext)
  if (!hasChoice(ctx)) return <>{children}</>
  const hub = ctx.hubs.find((h) => h.id === ctx.hubId)
  const note = (
    <p className="text-muted-foreground text-xs" data-testid="hub-wide-note">
      Applies to every task on <span className="text-foreground font-medium">{hub?.label}</span>
    </p>
  )
  if (ctx.hubId === ctx.defaultHubId) {
    return (
      <div key={ctx.hubId} className="space-y-3" data-hub-wide={ctx.hubId}>
        {note}
        {children}
      </div>
    )
  }
  return (
    <div key={ctx.hubId} className="space-y-3" data-hub-wide={ctx.hubId}>
      {note}
      <HubScope
        hubId={ctx.hubId}
        fallback={<p className="text-muted-foreground text-sm">This hub is not connected.</p>}
      >
        {children}
      </HubScope>
    </div>
  )
}
