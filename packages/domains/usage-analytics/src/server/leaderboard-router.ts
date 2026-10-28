// The `app.leaderboard` router. `@slayzone/api` mounts it at `app.leaderboard`.
import { router, publicProcedure } from '@slayzone/trpc-server'
import { getLocalLeaderboardStats } from './local-leaderboard'
import { getUsageAnalyticsRouterDeps } from './router-deps'

// Leaderboard — reads ctx.db directly. It was an AppDeps slot, which meant this
// process asked the Electron host to run a query against the database THIS
// process owns; standalone hubs got a fail-loud stub instead of a leaderboard.
export const appLeaderboardRouter = router({
  // Summed over the caller's projects only, on a hub with login (T-17).
  getLocalStats: publicProcedure.query(async ({ ctx }) => {
    const projectIds = await getUsageAnalyticsRouterDeps().ownedProjectIds(ctx)
    return getLocalLeaderboardStats(ctx.db, projectIds ? { projectIds } : null)
  })
})

export type AppLeaderboardRouter = typeof appLeaderboardRouter
/** Where `@slayzone/api` mounts it: `app.leaderboard`. */
export type AppLeaderboardMounts = { app: { leaderboard: AppLeaderboardRouter } }
