// Chromium-fork top-level overlay-view router. Mirrors the canonical App.tsx
// plane that renders LeaderboardPage / UsageAnalyticsPage / ContextManagerPage
// as an `absolute inset-0 z-20` overlay above the tab content whenever
// useTabStore.activeView leaves 'tabs' (see App.tsx, the `activeView ===
// 'leaderboard' | 'usage-analytics' | 'context'` blocks).
//
// Render this INSIDE a `relative` content container, BELOW the TabBar, so the
// overlay covers the home/task content (which stays mounted underneath,
// preserving its state — matches canonical, which never unmounts the tabs while
// an overlay shows). No dedicated back button: clicking a tab in the TabBar
// above, or selecting a project/task, resets activeView to 'tabs'
// (setActiveTabIndex/openTask/selectProject all do), and ContextManagerPage
// owns its own onBack — same exit affordances as the Electron app.
//
// Pages are lazy + <Suspense> so the overlay code-splits out of first paint,
// matching the canonical app-shell/lazy.ts treatment.
//
// LEADERBOARD IS AUTH-GATED HERE: the fork has no Convex client wired
// (convexConfigured=false in HomeView), so we pass LEADERBOARD_AUTH_DISABLED and
// LeaderboardPage renders its sign-in gate instead of live rankings. Full
// leaderboard functionality is BLOCKED until fork Convex/GitHub auth lands — a
// separate task. usage-analytics + context render fully (sidecar-backed).
import { lazy, Suspense } from 'react'
import { useTabStore } from '@slayzone/settings'
import { LEADERBOARD_AUTH_DISABLED } from '@slayzone/leaderboard'

const LeaderboardPage = lazy(() =>
  import('@slayzone/leaderboard').then((m) => ({ default: m.LeaderboardPage }))
)
const UsageAnalyticsPage = lazy(() =>
  import('@slayzone/usage-analytics/client').then((m) => ({ default: m.UsageAnalyticsPage }))
)
const ContextManagerPage = lazy(() =>
  import('@slayzone/ai-config/client').then((m) => ({ default: m.ContextManagerPage }))
)

interface OverlayViewRouterProps {
  selectedProjectId: string
  projectName?: string
  projectPath?: string | null
  onTaskClick: (taskId: string) => void
}

export function OverlayViewRouter({
  selectedProjectId,
  projectName,
  projectPath,
  onTaskClick
}: OverlayViewRouterProps): React.JSX.Element | null {
  const activeView = useTabStore((s) => s.activeView)
  if (activeView === 'tabs') return null

  return (
    <div className="absolute inset-0 z-20 overflow-hidden bg-surface-0">
      <Suspense fallback={null}>
        {activeView === 'usage-analytics' && <UsageAnalyticsPage onTaskClick={onTaskClick} />}
        {activeView === 'context' && (
          <ContextManagerPage
            selectedProjectId={selectedProjectId}
            projectPath={projectPath}
            projectName={projectName}
            onBack={() => useTabStore.getState().setActiveView('tabs')}
          />
        )}
        {activeView === 'leaderboard' && <LeaderboardPage auth={LEADERBOARD_AUTH_DISABLED} />}
      </Suspense>
    </div>
  )
}
