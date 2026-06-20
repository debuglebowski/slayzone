// Chromium-fork top-level overlay-view router. Mirrors the canonical App.tsx
// plane that renders LeaderboardPage / UsageAnalyticsPage / ContextManagerPage
// as an `absolute inset-0 z-20` overlay above the tab content whenever
// useTabStore.activeView leaves 'tabs' (see App.tsx, the `activeView ===
// 'leaderboard' | 'usage-analytics' | 'context'` blocks).
//
// The real pages aren't ported into a @slayzone/* package yet, so each renders a
// placeholder. A later task swaps the placeholder body for the imported page
// (lazy + <Suspense>) — the store wiring + overlay frame here stay unchanged.
//
// Render this INSIDE a `relative` content container so the overlay covers the
// home/task content (which stays mounted underneath, preserving its state —
// matches canonical, which never unmounts the tabs while an overlay shows).
import { useTabStore, type ActiveView } from '@slayzone/settings'

type OverlayView = Exclude<ActiveView, 'tabs'>

const OVERLAY_TITLES: Record<OverlayView, string> = {
  leaderboard: 'Leaderboard',
  'usage-analytics': 'Usage Analytics',
  context: 'Context Manager'
}

export function OverlayViewRouter(): React.JSX.Element | null {
  const activeView = useTabStore((s) => s.activeView)
  if (activeView === 'tabs') return null

  const title = OVERLAY_TITLES[activeView]
  return (
    <div className="absolute inset-0 z-20 flex flex-col overflow-hidden bg-surface-0">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <button
          type="button"
          onClick={() => useTabStore.getState().setActiveView('tabs')}
          className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          ← Back
        </button>
        <span className="text-sm font-medium text-foreground">{title}</span>
      </div>
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {title} view lands in a later task — this is the overlay-router placeholder.
      </div>
    </div>
  )
}
