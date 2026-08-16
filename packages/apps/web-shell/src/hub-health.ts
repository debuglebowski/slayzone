// Web shell — pre-boot auth-required probe.
//
// `GET /health` is deliberately unauthenticated and PUBLIC (see health.ts's
// own docstring: "a client has to learn it needs a token BEFORE it has one")
// — read directly here, not via tRPC (no connection exists yet), so
// `main.tsx` can decide whether to show `LoginScreen` or connect straight
// through. This is what lets a SUPERVISED hub serve the web shell usefully:
// `hubAuthRequired = !supervised` there, so it never verifies a bearer at
// all — mirroring how desktop/CLI clients already connect to one with no
// token (see server.ts's widened `remote || supervised` static-serving gate).
//
// FAILS CLOSED: any fetch/parse error resolves `true` (assume auth IS
// required) — a transient health-check hiccup must never silently skip the
// login screen against a hub that actually enforces auth.
export async function fetchAuthRequired(): Promise<boolean> {
  try {
    const res = await fetch('/health', { credentials: 'same-origin' })
    if (!res.ok) return true
    const body = (await res.json()) as { authRequired?: unknown }
    return body.authRequired !== false
  } catch {
    return true
  }
}
