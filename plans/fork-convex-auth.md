# Fork: Convex auth → unblock leaderboard + Convex-gated UI

Wires real Convex + GitHub OAuth into the chromium fork (`packages/apps/renderer-app`)
so `convexConfigured` is true, the leaderboard renders (and the downstream feedback
subtask unblocks). Canonical logic is REUSED, never reimplemented.

## Auth-state delivery mechanism (the locked decision, implemented)

The renderer owns the Convex session (the leaderboard's Convex `useQuery`/`useMutation`
need an authenticated `ConvexReactClient` in the renderer). The two shells differ ONLY
in how the `slayzone://auth/callback` OAuth **code** reaches that renderer:

- **Electron (`oauthDelivery: 'inline'`, unchanged):** `app.auth.githubSystemSignIn`
  runs in the Electron main process, which opens the browser, blocks on `open-url`,
  and returns `{ code, verifier }` synchronously in the mutation result.

- **Fork (`oauthDelivery: 'subscription'`, new):** `slayzone://` deep-links are
  intercepted by the chromium C++ shell (`patches/chromium/0030`) and forwarded to the
  sidecar's Unix socket as `auth:deep-link`. The sidecar parses the code and emits it
  on `authEvents`; the **`app.auth.onCallback` tRPC subscription** (over the existing
  WS) pushes `{ code, error }` to the renderer's `ConvexAuthBridge`, which finishes with
  `actions.signIn('github', { code })` (reads the stashed PKCE verifier).

So: a tRPC subscription over the existing WS — NOT polling, NOT a bespoke channel.

### Why the sidecar starts the flow (not the renderer SDK directly)

`@convex-dev/auth`'s `actions.signIn('github', { redirectTo })` does
`window.location.href = <github-url>` on the OAuth start (`dist/react/client.js:152`).
In the fork that would destroy the renderer (and its subscription). So — exactly as
Electron does — the **sidecar** runs the PKCE start (`requestGithubSignInStart`: POST
the Convex `auth:signIn` action → `{ redirect, verifier }`), opens the browser itself
(`open <url>`), and returns `{ verifier, pending: true }`. The renderer stashes the
verifier and waits for the subscription. `requestGithubSignInStart` is now SHARED
(`@slayzone/transport/server`) — one PKCE handshake for both shells.

## Flow (fork, mac)

```
renderer: click "Sign in with GitHub"
  → app.auth.githubSystemSignIn.mutate({convexUrl, redirectTo})  (WS → sidecar)
sidecar: requestGithubSignInStart() → {redirect, verifier}; open <redirect>; return {verifier, pending}
renderer: localStorage[verifier-key] = verifier; await subscription
browser: user authorizes GitHub → Convex redirects → slayzone://auth/callback?code=…
macOS:   → SlayZone.app (chromium) → AppController.openURLs: → SidecarClient.Call("auth:deep-link",{url})
sidecar: Unix socket (sidecar-socket.ts) parses code → authEvents.emit('callback',{code})
         → app.auth.onCallback subscription → renderer
renderer: completeOAuthCode(code) → actions.signIn('github',{code}) (verifier from localStorage)
         → useConvexAuth().isAuthenticated = true → leaderboard live
```

## Changes

Shared (reuse, both shells):
- `@slayzone/leaderboard/convexAuth.tsx` — MOVED from the Electron renderer's
  `lib/convexAuth.tsx` (which is now a re-export shim). Adds an `oauthDelivery` prop +
  the `app.auth.onCallback` subscription path. Exports `ConvexAuthBootstrap`,
  `useLeaderboardAuth`, `isConvexConfigured`.
- `@slayzone/transport/server`:
  - `auth-github.ts` — `requestGithubSignInStart` (extracted from Electron main) +
    `parseAuthCallbackUrl`.
  - `app-deps.ts` — `authEvents` bus (`AuthEventMap`) + `app.auth.onCallback`
    subscription in `routers/app.ts`.

Sidecar (`@slayzone/server`, fork/standalone only):
- `sidecar-socket.ts` — Unix-socket LSP-framed JSON-RPC 2.0 server (the JS half of the
  C++ `SidecarClient`). Answers `sidecar.hello`/`sidecar.ping`; routes `auth:deep-link`.
- `composition.ts` — real `shellOpenExternal` (was a throwing stub) + the fork
  `authGithubSystemSignIn` (start + open browser + `pending`); creates `authEvents`.
- `server.ts` — starts the socket server (standalone) → `parseAuthCallbackUrl` →
  `authEvents.emit`.
- `shell-native.ts` — `openExternal(url)`.

Fork renderer (`renderer-app` / `chromium-shell`):
- `main.tsx` — wrap in `<ConvexAuthBootstrap oauthDelivery="subscription">`.
- `OverlayViewRouter.tsx` — feed `LeaderboardPage` the live `useLeaderboardAuth()`.
- `HomeView.tsx` — `convexConfigured={isConvexConfigured}`.
- `chromium-shell/vite.config.ts` — `envDir: root` so `VITE_CONVEX_URL` (root `.env`)
  is baked into the fork bundle (mirrors `electron.vite.config`). Unset → degrades to
  `LEADERBOARD_AUTH_DISABLED` (exactly today's behavior).

## Verification

- ✅ Typecheck: transport, leaderboard, server, renderer-app, chromium-shell, **app
  (Electron, both tsconfigs)** — all clean.
- ✅ Build: chromium-shell (`VITE_CONVEX_URL` + ConvexAuthProvider + onCallback baked in)
  and **Electron app** (convexAuth resolved via shim) — both exit 0. Electron not broken.
- ✅ Sidecar chain (deterministic integration test): isolated sidecar →
  `sidecar.hello`/`ping`/`auth:deep-link` over the socket → `authEvents` →
  `app.auth.onCallback` delivers `{code}` AND `{error}` to a WS subscriber; notifications
  get no response. PASS.
- ✅ Renderer flip (REAL `chrome://slayzone-shell/` window via CDP): sidebar **trophy
  shows** (`convexConfigured=true`); leaderboard renders the **configured** state
  ("Sign in with GitHub" + tables), NOT the `LEADERBOARD_AUTH_DISABLED` gate. No runtime
  provider error.
- ⏳ Full live GitHub round-trip (human GitHub login + real callback) — inherently
  human-in-the-loop; every machine-verifiable segment is covered above.

## Gaps / dependencies (flagged, not silently skipped)

- **Ops:** the Convex deployment (`VITE_CONVEX_URL`, present) must have the GitHub auth
  provider configured (client id/secret). Code degrades gracefully when `VITE_CONVEX_URL`
  is unset. No chromium C++/patch change needed — `auth:deep-link` + `sidecar.sock` are
  already compiled into the built binary (verified via `strings`).
- **Platform:** macOS via the C++ socket (`patches/chromium/0030`). **Linux: done**
  via an HTTP handler — a `.desktop` `x-scheme-handler/slayzone` →
  `scripts/chromium/linux/slayzone-deeplink.sh` → the sidecar `/api/auth/deep-link`
  route → the same `parseAuthCallbackUrl → authEvents → app.auth.onCallback` chain
  (no chromium patch/rebuild; receiving end tested on mac, `.desktop` round-trip
  needs a real Linux desktop — see `scripts/chromium/linux/README.md`). **Windows:
  done** the same way — a registry `slayzone://` handler → `register-deeplink.ps1`
  / `slayzone-deeplink.ps1` → the same `/api/auth/deep-link` route → same chain
  (no chromium patch/rebuild; route now has a dedicated test, `auth-deep-link.test.ts`;
  registry + PowerShell round-trip needs a real Windows machine — see
  `scripts/chromium/windows/README.md` and `plans/fork-windows-deeplink.md`). The
  C++ named-pipe transport remains the deferred mac-parity alternative.
- **Minor:** the fork has no sign-in timeout (Electron's 2-min `waitForOAuthCallback`
  has no fork analog — the renderer just stays "pending" if the user abandons GitHub).
  Acceptable; a renderer-side timeout could be added later.
- **Adjacent:** the daily local-stats sync (`app.leaderboard.getLocalStats`) is still a
  throwing stub in the fork sidecar; the bridge's `.catch(()=>{})` swallows it, so the
  user's own stats aren't pushed yet (rankings from others still display). Out of scope.

## Unresolved questions

- Convex deployment GitHub provider configured for `silent-emu-581`? (ops)
- Want a fork sign-in timeout/cancel affordance, or leave "pending" open-ended?
- Implement `leaderboardGetLocalStats` natively in the fork sidecar (so the signed-in
  user contributes their own stats), or defer?
