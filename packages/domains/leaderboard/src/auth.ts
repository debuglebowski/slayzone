// Injected auth contract for the leaderboard.
//
// The leaderboard is the only fork-relevant view coupled to Convex + GitHub
// OAuth, both of which live in the *app* renderer (lib/convexAuth.tsx), NOT in
// any @slayzone/* package. To keep this package host-agnostic — importable by
// both the Electron renderer (Convex wired) and the chromium-shell fork (Convex
// NOT wired) — the host injects the auth state as a prop instead of the page
// reaching into an app-only module. The Electron app passes its
// useLeaderboardAuth() result; the fork passes LEADERBOARD_AUTH_DISABLED.
/**
 * Why Convex is not running — the one reason in force, for the leaderboard's gate.
 *   - `starting`: the tier / hub answers are still coming in, or the session is starting;
 *   - `no-deployment`: this host has no Convex deployment (a build without
 *     `VITE_CONVEX_URL`, or a host that wires none);
 *   - `telemetry-off`: the user's telemetry tier is `off`;
 *   - `hub-telemetry-off`: the home hub (this app's own data) has
 *     `SLAYZONE_HUB_ENABLE_TELEMETRY=0`, or could not be asked. `hubLabel` null = unnamed.
 */
export type LeaderboardUnavailable =
  | { kind: 'starting' }
  | { kind: 'no-deployment' }
  | { kind: 'telemetry-off' }
  | { kind: 'hub-telemetry-off'; hubLabel: string | null }

export interface LeaderboardAuthState {
  /** Convex runs here: a deployment is configured and third-party services are allowed. */
  configured: boolean
  /** Why not, while `configured` is false; null while it runs. */
  unavailable: LeaderboardUnavailable | null
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
  unavailable: { kind: 'no-deployment' },
  isLoading: false,
  isAuthenticated: false,
  lastError: null,
  // All three are unreachable in this host: `configured: false` sends
  // LeaderboardPage to its auth-gate, so no control that calls them ever renders.
  signInWithGitHub: async () => {
    // No Convex client to open a GitHub OAuth flow against.
  },
  signOut: async () => {
    // No session exists to end.
  },
  forgetMe: async () => {
    // No stored Convex identity to erase.
  }
}
