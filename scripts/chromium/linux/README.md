# Linux `slayzone://` OAuth deep-link handler

Linux support for the chromium-fork GitHub-OAuth flow (the macOS path lives in
`patches/chromium/0030` + the C++ `SidecarClient`; design:
`plans/fork-convex-auth.md`).

## Why HTTP, not the C++ socket

On macOS the `slayzone://` callback arrives as a runtime AppKit event reachable
only inside the chromium process, so mac forwards it to the sidecar over a Unix
socket (`SidecarClient` → `auth:deep-link`). On Linux the URL arrives as a
**command-line arg via a `.desktop` handler**, and that handler can be *any*
program — so we route it straight to the sidecar over HTTP instead of patching
Chromium. Benefits: no chromium C++ patch to carry across rebases, no Linux
rebuild, works with the existing fork binary. It converges on the exact same
sidecar chain (`/api/auth/deep-link` → `parseAuthCallbackUrl` →
`authEvents.emit('callback')` → `app.auth.onCallback` tRPC sub → renderer).

## Files

- `slayzone-deeplink.sh` — the handler. Given a `slayzone://...` URL, POSTs it to
  `http://127.0.0.1:<port>/api/auth/deep-link` (tries prod `8765` then dev `8766`;
  override with `SLAYZONE_SERVER_PORT`).
- `slayzone-deeplink.desktop` — registers `x-scheme-handler/slayzone`.

## Install (per-user)

```sh
# 1. Install the handler somewhere stable and executable.
install -Dm755 slayzone-deeplink.sh ~/.local/bin/slayzone-deeplink.sh

# 2. Point the .desktop Exec at it and install the desktop entry.
sed "s#/opt/slayzone/slayzone-deeplink.sh#$HOME/.local/bin/slayzone-deeplink.sh#" \
  slayzone-deeplink.desktop > ~/.local/share/applications/slayzone-deeplink.desktop

# 3. Register it as the slayzone:// scheme handler.
update-desktop-database ~/.local/share/applications
xdg-mime default slayzone-deeplink.desktop x-scheme-handler/slayzone
```

A packaged build should do the equivalent system-wide (`/usr/share/applications`,
handler under the app's install dir) from its postinstall.

## Verify

```sh
# With a SlayZone sidecar running, simulate a callback:
xdg-open 'slayzone://auth/callback?code=TESTCODE'
# → the renderer's ConvexAuthBridge receives {code:"TESTCODE"} over app.auth.onCallback.
# (TESTCODE fails the real Convex exchange — that's expected; it proves the route.)
```

## Status / gaps

- The sidecar `/api/auth/deep-link` route + the full receiving chain are
  implemented and tested (on macOS, since the route + chain are platform-agnostic).
- The `.desktop` registration + `xdg-open` round-trip need a real Linux desktop to
  verify end-to-end.
- Port discovery uses the baked dev/prod ports (matches the renderer's baked WS
  URL — no server-URL override channel exists yet). Align both if one lands.
