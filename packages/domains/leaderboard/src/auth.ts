// Injected auth contract for the leaderboard.
//
// The leaderboard is the only fork-relevant view coupled to Convex + GitHub
// OAuth, both of which live in the *app* renderer (lib/convexAuth.tsx), NOT in
// any @slayzone/* package. To keep this package host-agnostic — importable by
// both the Electron renderer (Convex wired) and the chromium-shell fork (Convex
// NOT wired) — the host injects the auth state as a prop instead of the page
// reaching into an app-only module. The Electron app passes its
// useLeaderboardAuth() result; the fork passes LEADERBOARD_AUTH_DISABLED.
export interface LeaderboardAuthState {
  /** Convex backend configured for this build (VITE_CONVEX_URL present). */
  configured: boolean
  isLoading: boolean
  isAuthenticated: boolean
  lastError: string | null
  signInWithGitHub: () => Promise<void>
  signOut: () => Promise<void>
  forgetMe: () => Promise<void>
}

// Default for hosts without Convex/auth wired (the chromium-shell fork as of the
// overlay-views migration). `configured: false` short-circuits LeaderboardPage to
// its auth-gate before any Convex hook runs, so no ConvexProvider is required.
export const LEADERBOARD_AUTH_DISABLED: LeaderboardAuthState = {
  configured: false,
  isLoading: false,
  isAuthenticated: false,
  lastError: null,
  signInWithGitHub: async () => {},
  signOut: async () => {},
  forgetMe: async () => {}
}
