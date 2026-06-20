import { useEffect, useRef } from 'react'
import { CheckCheck, Lock, Sparkles, Trophy } from 'lucide-react'
import { track } from '@slayzone/telemetry/client'
import type { LeaderboardAuthState } from './auth'
import { LeaderboardHeader } from './LeaderboardHeader'
import { LeaderboardTable } from './LeaderboardTable'
import { formatTokens } from './LeaderboardPage.utils'
import { useLeaderboardController } from './useLeaderboardController'

// Host-injected auth (see ./auth). The Electron renderer passes
// useLeaderboardAuth() (Convex + GitHub OAuth wired); the chromium-shell fork
// passes LEADERBOARD_AUTH_DISABLED → renders <LeaderboardAuthGate/> below.
export function LeaderboardPage({ auth }: { auth: LeaderboardAuthState }): React.JSX.Element {
  const tracked = useRef(false)
  useEffect(() => {
    if (!tracked.current) {
      tracked.current = true
      track('leaderboard_viewed')
    }
  }, [])
  // Gate BEFORE LeaderboardPageInner mounts: its controller calls Convex
  // useQuery/useMutation, which require a ConvexProvider ancestor the fork has
  // no client for. `configured: false` keeps every Convex hook out of the tree.
  if (!auth.configured) return <LeaderboardAuthGate />
  return <LeaderboardPageInner auth={auth} />
}

// Shown when the host hasn't wired Convex/auth (the chromium-shell fork today).
// The leaderboard is fundamentally a signed-in, cloud-backed view — without a
// Convex client there is nothing to rank, so this is the honest terminal state
// until fork auth lands.
function LeaderboardAuthGate(): React.JSX.Element {
  return (
    <div className="h-full overflow-hidden flex items-center justify-center p-6">
      <div className="max-w-sm rounded-xl border bg-surface-1/85 p-6 text-center">
        <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
          <Trophy className="size-6 text-muted-foreground" />
        </div>
        <h1 className="text-lg font-semibold">Leaderboard requires sign-in</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The leaderboard ranks signed-in users by tokens used and tasks completed. This build
          has no Convex backend configured, so sign-in is unavailable here.
        </p>
        <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground/80">
          <Lock className="size-3.5" />
          Convex / GitHub auth not wired in this environment
        </p>
      </div>
    </div>
  )
}

function LeaderboardPageInner({ auth }: { auth: LeaderboardAuthState }): React.JSX.Element {
  const ctl = useLeaderboardController(auth)
  const { canParticipate, topTokens, topTasks } = ctl

  return (
    <div className="h-full overflow-hidden bg-[radial-gradient(1200px_400px_at_20%_-10%,color-mix(in_oklab,var(--primary)_12%,transparent),transparent_65%)]">
      <div className="mx-auto w-full h-full max-w-[1440px] p-6 flex flex-col gap-5">
        <LeaderboardHeader auth={auth} ctl={ctl} />

        <section
          className={`grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 min-h-0 ${canParticipate ? '' : 'opacity-80'}`}
        >
          <LeaderboardTable
            icon={<Sparkles className="size-4" />}
            title="Most AI Tokens Used"
            rows={topTokens?.entries.map((r) => ({
              key: r.userId,
              name: r.displayName,
              image: r.image,
              value: formatTokens(r.totalTokens)
            }))}
            viewerRow={
              topTokens?.viewer
                ? {
                    key: topTokens.viewer.userId,
                    name: topTokens.viewer.displayName,
                    image: topTokens.viewer.image,
                    value: formatTokens(topTokens.viewer.totalTokens),
                    rank: topTokens.viewer.rank
                  }
                : null
            }
          />
          <LeaderboardTable
            icon={<CheckCheck className="size-4" />}
            title="Most Completed Tasks"
            rows={topTasks?.entries.map((r) => ({
              key: r.userId,
              name: r.displayName,
              image: r.image,
              value: String(r.totalCompletedTasks)
            }))}
            viewerRow={
              topTasks?.viewer
                ? {
                    key: topTasks.viewer.userId,
                    name: topTasks.viewer.displayName,
                    image: topTasks.viewer.image,
                    value: String(topTasks.viewer.totalCompletedTasks),
                    rank: topTasks.viewer.rank
                  }
                : null
            }
          />
        </section>
      </div>
    </div>
  )
}
