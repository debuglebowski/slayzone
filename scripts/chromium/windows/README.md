# Windows `slayzone://` OAuth deep-link handler

Windows support for the chromium-fork GitHub-OAuth flow (the macOS path lives in
`patches/chromium/0030` + the C++ `SidecarClient`; the Linux path in
`scripts/chromium/linux/`; design: `plans/fork-convex-auth.md`,
`plans/fork-windows-deeplink.md`).

## Why HTTP, not the C++ named pipe

On macOS the `slayzone://` callback arrives as a runtime AppKit event reachable
only inside the chromium process, so mac forwards it to the sidecar over a Unix
socket (`SidecarClient` → `auth:deep-link`). On Windows — exactly like Linux — the
URL instead arrives as a **command-line arg** (process launch, or a
ProcessSingleton forward to the running instance), and the registered handler can
be *any* program. So we route it straight to the sidecar over HTTP rather than
adding a named-pipe transport to the C++ `SidecarClient`.

Benefits: no chromium C++ patch to carry across rebases, **no Windows chromium
build** (none exists yet — `scripts/chromium/build.sh` is mac-only), works with any
future fork binary. It converges on the exact same sidecar chain
(`/api/auth/deep-link` → `parseAuthCallbackUrl` → `authEvents.emit('callback')` →
`app.auth.onCallback` tRPC sub → renderer).

The named-pipe transport (`\\.\pipe\slayzone-sidecar`) remains the documented
mac-parity alternative if a Windows chromium build is ever stood up; this landing
does not preclude it.

## Files

- `slayzone-deeplink.ps1` — the handler. Given a `slayzone://...` URL, POSTs it to
  `http://127.0.0.1:<port>/api/auth/deep-link?url=<encoded>` (tries prod `8765`
  then dev `8766`; override with `SLAYZONE_HUB_PORT`). Uses the built-in
  `Invoke-RestMethod` — no `curl.exe`/`jq` dependency.
- `register-deeplink.ps1` — registers `slayzone://` for the current user (HKCU).
- `unregister-deeplink.ps1` — removes it.

## Install (per-user)

```powershell
# From this directory (handler path is auto-resolved next to the script):
powershell -NoProfile -ExecutionPolicy Bypass -File .\register-deeplink.ps1

# Or point at a handler installed elsewhere:
powershell -NoProfile -ExecutionPolicy Bypass -File .\register-deeplink.ps1 `
  -HandlerPath 'C:\Program Files\SlayZone\slayzone-deeplink.ps1'
```

This writes `HKCU\Software\Classes\slayzone` (the `URL Protocol` marker) and
`...\shell\open\command` = `powershell.exe -NoProfile -ExecutionPolicy Bypass
-File "<handler>" "%1"`. No admin required.

A packaged build should do the equivalent **system-wide** from its installer:
write the same keys under `HKLM\Software\Classes\slayzone` (NSIS:
`WriteRegStr HKLM "Software\Classes\slayzone" ...`), pointing the command at the
handler shipped in the app's install dir.

## Verify

```powershell
# With a SlayZone sidecar running, simulate a callback:
Start-Process 'slayzone://auth/callback?code=TESTCODE'
# → the renderer's ConvexAuthBridge receives {code:"TESTCODE"} over app.auth.onCallback.
# (TESTCODE fails the real Convex exchange — that's expected; it proves the route.)

# Or invoke the handler directly (bypasses the registry, tests just the POST):
powershell -NoProfile -ExecutionPolicy Bypass -File .\slayzone-deeplink.ps1 `
  'slayzone://auth/callback?code=TESTCODE'
```

## Status / gaps

- The sidecar `/api/auth/deep-link` route + the full receiving chain are
  implemented and tested (route-level test:
  `packages/shared/transport/src/server/http/rest-api/auth-deep-link.test.ts`;
  socket integration test on mac). Both are platform-agnostic.
- The registry registration + `Start-Process` round-trip need a **real Windows
  machine** to verify end-to-end (the dev/CI host is macOS — no `powershell.exe`,
  no registry).
- Port discovery uses the baked dev/prod ports (matches the renderer's baked WS
  URL — no server-URL override channel exists yet). Align both if one lands.
