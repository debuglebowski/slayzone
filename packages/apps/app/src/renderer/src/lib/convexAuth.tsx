// Convex + GitHub-OAuth wiring moved into @slayzone/leaderboard so BOTH shells
// (this Electron renderer and the chromium-shell fork) share one implementation
// instead of reimplementing it. This re-export preserves the existing
// `@/lib/convexAuth` import sites (App.tsx, main.tsx). The Electron renderer
// mounts <ConvexAuthBootstrap> with no oauthDelivery prop → the 'inline'
// (main-process mutation-return) path, identical to before the extraction.
export { ConvexAuthBootstrap, useLeaderboardAuth, isConvexConfigured } from '@slayzone/leaderboard'
