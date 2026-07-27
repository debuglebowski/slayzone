#!/usr/bin/env sh
# slayzone-deeplink.sh — Linux `x-scheme-handler/slayzone` handler.
#
# Registered via slayzone-deeplink.desktop; the OS invokes it with the
# `slayzone://...` URL when GitHub/Convex redirects to the OAuth callback. It
# forwards the URL to the running SlayZone sidecar's HTTP route, which converges
# on the SAME chain the macOS Unix-socket path uses (parseAuthCallbackUrl →
# authEvents → the app.auth.onCallback tRPC subscription → the renderer completes
# the Convex sign-in). No chromium changes needed — this is decoupled from the
# fork binary, so it survives chromium rebases.
set -eu

url="${1:-}"
if [ -z "$url" ]; then
  echo "usage: slayzone-deeplink.sh <slayzone://...>" >&2
  exit 2
fi

# The sidecar binds a baked loopback port (prod 8765, dev 8766), matching the
# renderer's baked WS URL (there is no server-URL override channel yet — see
# window-api-shim/src/server-url.ts; align both when one lands). SLAYZONE_HUB_ADDRESS
# (one `host:port`) pins a single target; unset, try prod first, then dev.
addrs="${SLAYZONE_HUB_ADDRESS:-127.0.0.1:8765 127.0.0.1:8766}"

for addr in $addrs; do
  # -G + --data-urlencode safely encodes the URL into the query string (no body
  # parser, no jq/python dependency); -X POST keeps it a POST. The route reads
  # req.query.url.
  if curl -sf -m 5 -G -X POST \
       --data-urlencode "url=$url" \
       "http://${addr}/api/auth/deep-link" >/dev/null 2>&1; then
    exit 0
  fi
done

echo "slayzone-deeplink: no SlayZone sidecar reachable (tried: $addrs)" >&2
exit 1
