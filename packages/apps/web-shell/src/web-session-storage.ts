// The web shell keeps its session in NO storage a script can read (T-13): the hub sets
// it as the HttpOnly `slayzone_web_session` cookie, and `/trpc` and REST authenticate
// by that cookie (`web-sessions.ts` in the hub). An XSS on the page therefore cannot
// read the session out of the page — not from `localStorage`, `sessionStorage` or any
// response body.
//
// What is left here is the migration: an earlier version kept the token in
// `localStorage` under this key, readable by any script on the origin. `main.tsx`
// deletes it on every load, before anything else runs.
const LEGACY_TOKEN_KEY = 'slayzone-web-session-token'

/** Delete the token an earlier version stored. Never throws: storage can be blocked. */
export function clearLegacySessionToken(): void {
  try {
    window.localStorage.removeItem(LEGACY_TOKEN_KEY)
  } catch {
    /* storage unavailable (blocked site data): there is nothing to delete either */
  }
}
