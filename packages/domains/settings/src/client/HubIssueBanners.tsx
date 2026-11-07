import { useEffect, type ReactNode } from 'react'
import { AlertTriangle, Info, LogIn, Settings2, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger, cn } from '@slayzone/ui'
import { useHubIssues, type HubIssue, type HubIssueEntry } from '@slayzone/transport/client'
import { useHubIssueBannerStore } from './hub-issue-banner-store'

/**
 * One banner per hub whose connection has a problem (`useHubIssues`), shown across
 * the app: a hub that drops the app's sign-in looks connected while every call there
 * fails, and nothing outside Settings → Hubs said so.
 *
 * Every banner offers Hub settings, Details (the cause in full and since when),
 * Dismiss (until that hub's cause changes) and Don't show again (that hub only,
 * undone from its card in Settings → Hubs). A lost sign-in also offers Sign in.
 */
export function HubIssueBanners({ className }: { className?: string }): ReactNode {
  const issues = useHubIssues()
  const muted = useHubIssueBannerStore((s) => s.muted)
  const dismissed = useHubIssueBannerStore((s) => s.dismissed)

  // A closed banner is about ONE occurrence: once its hub is fine again, the next
  // problem there is news.
  useEffect(() => {
    const store = useHubIssueBannerStore.getState()
    for (const hubId of Object.keys(dismissed)) {
      if (!issues.some((e) => e.hub.id === hubId)) store.clearDismissal(hubId)
    }
  }, [issues, dismissed])

  const visible = issues.filter(
    (e) => !muted.includes(e.hub.id) && dismissed[e.hub.id] !== e.issue.kind
  )
  if (visible.length === 0) return null
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {visible.map((e) => (
        <HubIssueBanner key={e.hub.id} entry={e} />
      ))}
    </div>
  )
}

const HEADLINE: Record<HubIssue['kind'], (label: string) => string> = {
  unreachable: (label) => `Can't reach ${label}`,
  signin: (label) => `Signed out of ${label} — nothing there works until you sign in again`,
  error: (label) => `${label} is connected but not answering`
}

const CAUSE: Record<HubIssue['kind'], string> = {
  unreachable: 'The connection keeps failing. SlayZone retries on its own.',
  signin: 'The hub no longer accepts this app’s sign-in (expired, or ended by your organization).',
  error: 'The hub accepted the connection but could not describe itself.'
}

function openHubSettings(): void {
  window.dispatchEvent(new CustomEvent('open-settings', { detail: 'hubs' }))
}

/** Compact pill buttons sized for the 30px banner (the shared `Button` starts at 32px). */
const PILL =
  'inline-flex h-6 shrink-0 items-center gap-1 rounded px-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/50'
const QUIET = cn(PILL, 'hover:bg-destructive/15')
const LOUD = cn(PILL, 'bg-destructive/20 hover:bg-destructive/30')

function HubIssueBanner({ entry }: { entry: HubIssueEntry }): ReactNode {
  const { hub, issue } = entry
  const store = useHubIssueBannerStore.getState
  return (
    <div
      data-testid="hub-issue-banner"
      data-hub-id={hub.id}
      data-issue={issue.kind}
      className="flex items-center gap-1 rounded-md border border-destructive/20 bg-destructive/10 py-0.5 pr-0.5 pl-3 text-xs text-destructive"
    >
      <AlertTriangle className="mr-1 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={issue.detail}>
        {HEADLINE[issue.kind](hub.label)}
      </span>
      {issue.kind === 'signin' ? (
        <button
          type="button"
          className={LOUD}
          onClick={() => {
            store().requestSignIn(hub.id)
            openHubSettings()
          }}
        >
          <LogIn className="size-3" />
          Sign in
        </button>
      ) : null}
      <button type="button" className={QUIET} onClick={openHubSettings}>
        <Settings2 className="size-3" />
        Hub settings
      </button>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={QUIET}>
            <Info className="size-3" />
            Details
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0 text-xs">
          <div className="space-y-2 p-3">
            <div className="font-medium text-foreground">{hub.label}</div>
            <div className="text-muted-foreground">{CAUSE[issue.kind]}</div>
            <div className="rounded bg-muted px-2 py-1.5 font-mono break-words text-foreground">
              {issue.detail}
            </div>
            <div className="text-muted-foreground">
              Since {new Date(issue.since).toLocaleString()}
            </div>
            {hub.url ? (
              <div className="font-mono break-all text-muted-foreground">{hub.url}</div>
            ) : null}
          </div>
          <div className="flex justify-end border-t border-border px-3 py-2">
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => store().setMuted(hub.id, true)}
            >
              Don't show again for this hub
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-destructive/20" />
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss until this changes"
        className={cn(QUIET, 'w-6 justify-center px-0')}
        onClick={() => store().dismiss(hub.id, issue.kind)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
