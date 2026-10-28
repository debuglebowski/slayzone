export {
  refreshUsageData,
  queryDailyTotals,
  queryAnalytics,
  queryTaskCost,
  type UsageScope
} from './cache'
// Leaderboard stats — computed against ctx.db in the hub. Was an AppDeps slot
// (the hub asking the desktop to query the hub's own database).
export { getLocalLeaderboardStats } from './local-leaderboard'
// `app.leaderboard`, mounted by `@slayzone/api` under `app`, and its host seam.
export {
  appLeaderboardRouter,
  type AppLeaderboardRouter,
  type AppLeaderboardMounts
} from './leaderboard-router'
// `usageAnalytics`, mounted by `@slayzone/api` at `usageAnalytics`.
export {
  usageAnalyticsRouter,
  type UsageAnalyticsRouter,
  type UsageAnalyticsMounts
} from './usage-analytics-router'
export {
  setUsageAnalyticsRouterDeps,
  getUsageAnalyticsRouterDeps,
  type UsageAnalyticsRouterDeps
} from './router-deps'
