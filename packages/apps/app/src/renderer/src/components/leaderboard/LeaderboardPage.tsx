import { useEffect, useRef } from 'react'
import { CheckCheck, Sparkles } from 'lucide-react'
import { useLeaderboardAuth } from '@/lib/convexAuth'
import { track } from '@slayzone/telemetry/client'
import { LeaderboardHeader } from './LeaderboardHeader'
import { LeaderboardTable } from './LeaderboardTable'
import { formatTokens } from './LeaderboardPage.utils'
import { useLeaderboardController } from './useLeaderboardController'

export function LeaderboardPage(): React.JSX.Element {
  const tracked = useRef(false)
  useEffect(() => {
    if (!tracked.current) {
      tracked.current = true
      track('leaderboard_viewed')
    }
  }, [])
  const auth = useLeaderboardAuth()
  if (!auth.configured) {
    return (
      <div className="h-full overflow-hidden flex items-center justify-center text-sm text-muted-foreground">
        Leaderboard unavailable (Convex not configured)
      </div>
    )
  }
  return <LeaderboardPageInner auth={auth} />
}

function LeaderboardPageInner({
  auth
}: {
  auth: ReturnType<typeof useLeaderboardAuth>
}): React.JSX.Element {
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
