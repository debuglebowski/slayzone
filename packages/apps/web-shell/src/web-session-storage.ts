// Web shell's own scoped-session token storage.
//
// `localStorage` (not `sessionStorage`, unlike server-url.ts's per-tab
// windowId): a scoped session is meant to survive a reload AND a closed tab —
// that is the whole point of the server's 7-day-idle / 30-day-absolute
// sliding expiry (web-sessions.ts). `sessionStorage` would make every new tab
// re-prompt for a password, which the expiry design does not intend.
//
// Storing the raw token here is not an extra leak beyond what the server
// already accepts: `POST /api/auth/web-login` (rest-api/hub/web-login.ts)
// returns the SAME token in its response body specifically so a client that
// holds its own tRPC WS connection (authenticated via `connectionParams`, not
// a cookie) has something to read — its own docstring says so. The `HttpOnly`
// cookie set alongside it covers `/api/*` REST calls; this covers `/trpc`.
const TOKEN_KEY = 'slayzone-web-session-token'

export function getStoredSessionToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY)
}

export function setStoredSessionToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token)
}

export function clearStoredSessionToken(): void {
  window.localStorage.removeItem(TOKEN_KEY)
}
