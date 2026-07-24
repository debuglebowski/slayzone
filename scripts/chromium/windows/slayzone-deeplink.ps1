# slayzone-deeplink.ps1 — Windows `slayzone://` scheme handler.
#
# Registered via register-deeplink.ps1; Windows invokes it with the `slayzone://`
# URL when GitHub/Convex redirects to the OAuth callback. It forwards the URL to
# the running SlayZone sidecar's HTTP route, which converges on the SAME chain the
# macOS Unix-socket path uses (parseAuthCallbackUrl -> authEvents -> the
# app.auth.onCallback tRPC subscription -> the renderer completes the Convex
# sign-in). No chromium changes needed — this is decoupled from the fork binary,
# so it survives chromium rebases. Mirrors scripts/chromium/linux/slayzone-deeplink.sh.
[CmdletBinding()]
param([string]$Url)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Url)) {
  [Console]::Error.WriteLine('usage: slayzone-deeplink.ps1 <slayzone://...>')
  exit 2
}

# The sidecar binds a baked loopback port (prod 8765, dev 8766), matching the
# renderer's baked WS URL (there is no server-URL override channel yet — see
# window-api-shim/src/server-url.ts; align both when one lands). Override with
# SLAYZONE_HUB_PORT (space-separated). Try prod first, then dev.
$ports = if ($env:SLAYZONE_HUB_PORT) {
  $env:SLAYZONE_HUB_PORT -split '\s+' | Where-Object { $_ }
}
else {
  @('8765', '8766')
}

# EscapeDataString safely encodes the whole URL into the query string (the route
# reads req.query.url) — no body parser, no jq/python dependency. Mirrors the
# Linux helper's `curl -G --data-urlencode "url=$url"`.
$encoded = [uri]::EscapeDataString($Url)

foreach ($port in $ports) {
  $endpoint = "http://127.0.0.1:$port/api/auth/deep-link?url=$encoded"
  try {
    Invoke-RestMethod -Method Post -Uri $endpoint -TimeoutSec 5 | Out-Null
    exit 0
  }
  catch {
    # Sidecar not on this port (or not running) — try the next.
  }
}

[Console]::Error.WriteLine(
  "slayzone-deeplink: no SlayZone sidecar reachable (tried ports: $($ports -join ', '))")
exit 1
