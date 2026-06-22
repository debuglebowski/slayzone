# Fork: Windows `slayzone://` OAuth deep-link → sidecar auth

Adds Windows support for the chromium-fork GitHub-OAuth flow. Mac path = C++
`SidecarClient` over a Unix socket (`patches/chromium/0003`, `0030`); Linux path =
HTTP handler (`scripts/chromium/linux/`). Windows **mirrors Linux**.

## Decision: HTTP handler, not the C++ named pipe

Two options the task lays out:

1. **C++ named-pipe transport** (mac parity): new `SidecarClient` Windows transport
   (`\\.\pipe\slayzone-sidecar`) + a cross-platform argv/ProcessSingleton interception
   in Chromium startup → `SidecarClient::Call("auth:deep-link",{url})`.
2. **HTTP handler** (mirror Linux): register `slayzone://` in the Windows registry →
   a tiny handler POSTs the URL to the sidecar's existing `/api/auth/deep-link` REST
   route → the same `parseAuthCallbackUrl → authEvents → app.auth.onCallback` chain.

**Chosen: HTTP handler.** Rationale (same as the landed Linux call):
- On Windows the URL arrives as a **command-line argv** (launch or ProcessSingleton
  forward), exactly like Linux's `.desktop` arg — NOT a runtime event like mac's
  `openURLs:`. So a standalone handler is the natural fit; no need to live inside
  the chromium process.
- The named-pipe path requires standing up a full **Windows chromium build
  toolchain** (gn/ninja on Windows) — which does not exist yet (`build.sh` is
  mac-only). That is not a sustainable *first* landing and it diverges from Linux.
- HTTP decouples from the chromium binary → no C++ patch to carry across rebases,
  no Windows rebuild, works with any future fork binary. The sidecar route already
  exists and is platform-agnostic.

Named-pipe remains the documented mac-parity alternative if a Windows chromium
build is ever stood up; this landing does not preclude it.

## Changes

`scripts/chromium/windows/` (new — mirrors `scripts/chromium/linux/`):
- `slayzone-deeplink.ps1` — the handler. Given the `slayzone://…` URL as `$args[0]`,
  POSTs it to `http://127.0.0.1:<port>/api/auth/deep-link?url=<encoded>`. Tries prod
  `8765` then dev `8766`; override via `SLAYZONE_SERVER_PORT`. Uses
  `Invoke-RestMethod` (built-in; no `curl.exe`/`jq` dependency) + `[uri]::EscapeDataString`.
- `register-deeplink.ps1` — per-user install. Writes `HKCU\Software\Classes\slayzone`
  (`URL Protocol`) + `shell\open\command` = `powershell -NoProfile -ExecutionPolicy
  Bypass -File "<handler>" "%1"`. No admin needed. Resolves the handler path next to
  itself (no placeholder to edit, unlike the Linux `.desktop`).
- `unregister-deeplink.ps1` — removes the key (clean uninstall / re-test).
- `README.md` — why HTTP not named-pipe, files, install (per-user), verify, the
  system-wide (HKLM via installer) note, status/gaps. Mirrors the Linux README.

`packages/shared/transport/src/server/http/rest-api/`:
- `auth-deep-link.test.ts` (new) — the HTTP entry both Linux + Windows depend on had
  no route-level test (only the mac socket integration test). Covers: `?url=` query
  form (the curl/PS form) emits `callback{code}`; JSON `{url}` body form; `error`
  passthrough; 400 on missing url; 400 on a non-callback url; non-callback does NOT
  emit. TDD — written to fail first.

`plans/fork-convex-auth.md` — flip the Platform gap line: Windows pending → done via
the registry handler.

## Verification

- Route test (`auth-deep-link.test.ts`) — runnable on mac/CI; proves the receiving
  contract the PS handler targets (query form, body form, emit, 400s).
- PS handler logic — verified by inspection + a node simulation of the same HTTP
  POST (encoding + port fallback). `pwsh` not on this dev mac and registry +
  `powershell.exe` arg passing are Windows-only, so the **registry round-trip +
  end-to-end GitHub login need a real Windows machine** (mirrors Linux's "needs a
  real Linux desktop"). Every machine-verifiable segment is covered.

## Unresolved questions

- Ship a system-wide (HKLM) installer step now, or leave per-user `register-deeplink.ps1`
  until the fork has a Windows packaging target (none today)?
- `Invoke-RestMethod` (chosen, universal) vs `curl.exe` (mirrors `.sh` literally,
  but not guaranteed pre-Win10-1803)? Picked the former for robustness — confirm OK.
