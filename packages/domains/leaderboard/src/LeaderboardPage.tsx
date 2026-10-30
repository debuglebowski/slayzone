import { useEffect, useRef } from 'react'
import { CheckCheck, Loader2, Sparkles, Trophy } from 'lucide-react'
import { useTrack } from '@slayzone/telemetry/client'
import type { LeaderboardAuthState, LeaderboardUnavailable } from './auth'
import { LeaderboardHeader } from './LeaderboardHeader'
import { LeaderboardTable } from './LeaderboardTable'
import { formatTokens } from './LeaderboardPage.utils'
import { useLeaderboardController } from './useLeaderboardController'
import { ConvexScope } from './convexAuth'

// Host-injected auth (see ./auth). The Electron renderer passes
// useLeaderboardAuth() (Convex + GitHub OAuth wired); the chromium-shell fork
// passes LEADERBOARD_AUTH_DISABLED → renders <LeaderboardAuthGate/> below.
export function LeaderboardPage({ auth }: { auth: LeaderboardAuthState }): React.JSX.Element {
  const { track } = useTrack()
  const tracked = useRef(false)
  useEffect(() => {
    if (!tracked.current) {
      tracked.current = true
      track('leaderboard_viewed')
    }
  }, [track])
  // Gate BEFORE LeaderboardPageInner mounts: its controller calls Convex
  // useQuery/useMutation, which need the ConvexProvider ConvexScope puts above it —
  // there is no client while Convex is off. `configured: false` keeps every Convex
  // hook out of the tree.
  if (!auth.configured)
    return <LeaderboardAuthGate unavailable={auth.unavailable ?? { kind: 'starting' }} />
  return (
    <ConvexScope>
      <LeaderboardPageInner auth={auth} />
    </ConvexScope>
  )
}

// Shown while Convex is not running. The leaderboard is fundamentally a signed-in,
// cloud-backed view — without a Convex client there is nothing to rank. Says the ONE
// reason in force (`auth.unavailable`); while the answers are still coming in it gives
// no verdict at all.
function LeaderboardAuthGate({
  unavailable
}: {
  unavailable: LeaderboardUnavailable
}): React.JSX.Element {
  if (unavailable.kind === 'starting') {
    return (
      <div
        className="h-full overflow-hidden flex items-center justify-center p-6"
        data-testid="leaderboard-starting"
      >
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  return (
    <div className="h-full overflow-hidden flex items-center justify-center p-6">
      <div className="max-w-sm rounded-xl border bg-surface-1/85 p-6 text-center">
        <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
          <Trophy className="size-6 text-muted-foreground" />
        </div>
        <h1 className="text-lg font-semibold">Leaderboard unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The leaderboard ranks signed-in users by tokens used and tasks completed. It needs
          SlayZone&apos;s cloud service (Convex).
        </p>
        <p
          className="mt-3 text-sm text-muted-foreground"
          data-testid="leaderboard-unavailable-reason"
        >
          <UnavailableReason unavailable={unavailable} />
        </p>
      </div>
    </div>
  )
}

function UnavailableReason({
  unavailable
}: {
  unavailable: Exclude<LeaderboardUnavailable, { kind: 'starting' }>
}): React.JSX.Element {
  switch (unavailable.kind) {
    case 'hub-telemetry-off':
      return (
        <>
          {unavailable.hubLabel ? (
            <>
              The hub <span className="font-medium text-foreground">{unavailable.hubLabel}</span>,
              where this app&apos;s data lives,
            </>
          ) : (
            'This hub'
          )}{' '}
          has turned telemetry off (<code>SLAYZONE_HUB_ENABLE_TELEMETRY=0</code>), or could not be
          asked. SlayZone&apos;s cloud service stays off while it does.
        </>
      )
    case 'telemetry-off':
      return (
        <>
          You turned telemetry off in Settings. SlayZone&apos;s cloud service is off with it; turn
          telemetry back on to use the leaderboard.
        </>
      )
    case 'no-deployment':
      return <>This build has no SlayZone cloud service configured.</>
  }
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
