#!/usr/bin/env bash
#
# smoke-hub-no-natives.sh <hub.tgz> — the packed @slayzone/hub installs and boots WITHOUT
# its optional native dependencies: node-pty, bufferutil, utf-8-validate (T-30).
#
# That is what `npm install @slayzone/hub` leaves on a machine with no C/C++ toolchain:
# the optional builds fail and npm drops them. `--omit=optional` gives the same tree on
# any machine, so this needs no toolchain-less runner. It then boots the INSTALLED bin
# under plain node, in a throwaway root on a port the OS picks:
#   1. SLAYZONE_HUB_ENABLE_PROCESSES=0 (a hosted hub): /health ok, processes reported off;
#   2. processes on: still boots — node-pty is required on the first hub-local spawn,
#      never at boot, and that spawn is refused with a clear error, not a crash.
#
# Called by scripts/publish-npm.sh right after `npm pack`. Standalone:
#     bash scripts/smoke-hub-no-natives.sh path/to/slayzone-hub-<version>.tgz
#
# Needs network (npm fetches better-sqlite3 and its prebuilt binary for this node).

set -euo pipefail

[ $# -eq 1 ] || { echo "usage: $0 <hub.tgz>" >&2; exit 2; }
TGZ="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
[ -f "$TGZ" ] || { echo "no such tarball: $1" >&2; exit 2; }

DIR="$(mktemp -d /tmp/slz-hub-no-natives.XXXXXX)"
HPID=""
cleanup() {
  [ -n "$HPID" ] && kill "$HPID" 2>/dev/null || true
  rm -rf "$DIR"
}
trap cleanup EXIT

fail() {
  echo "   NO-NATIVES SMOKE FAIL — $1"
  [ -f "$DIR/hub.log" ] && grep -vE "Migration [0-9]+ applied" "$DIR/hub.log" | tail -20
  exit 1
}

echo "==> Smoke: hub tarball without its optional natives (node-pty, bufferutil, utf-8-validate)"

# --- install -----------------------------------------------------------------------
( cd "$DIR" && npm init -y >/dev/null 2>&1 \
  && npm install --omit=optional --no-audit --no-fund "$TGZ" >install.log 2>&1 ) \
  || { tail -20 "$DIR/install.log"; fail "npm install --omit=optional failed"; }

PKG="$DIR/node_modules/@slayzone/hub/package.json"
node -e '
  const p = require(process.argv[1]);
  const deps = Object.keys(p.dependencies || {}).sort().join(",");
  const opt = Object.keys(p.optionalDependencies || {}).sort().join(",");
  if (deps !== "better-sqlite3") throw new Error("dependencies must be better-sqlite3 only, got: " + deps);
  if (opt !== "bufferutil,node-pty,utf-8-validate")
    throw new Error("optionalDependencies must be node-pty, bufferutil, utf-8-validate, got: " + opt);
' "$PKG" 2>"$DIR/manifest.err" || fail "manifest: $(cat "$DIR/manifest.err")"
for n in node-pty bufferutil utf-8-validate; do
  [ ! -e "$DIR/node_modules/$n" ] || fail "$n is installed despite --omit=optional"
done
[ -d "$DIR/node_modules/better-sqlite3" ] || fail "better-sqlite3 (required) is not installed"
echo "   ✓ installed with better-sqlite3 only (manifest: 1 required, 3 optional natives)"

# --- boot --------------------------------------------------------------------------
# Scrub inherited SlayZone + module-resolution env: run from inside a SlayZone session,
# SLAYZONE_ROOT would point at a real install and NODE_PATH could hand the hub a
# node-pty this smoke is proving it does without.
SCRUB=(-u SLAYZONE_SUPERVISED -u SLAYZONE_ROOT
       -u SLAYZONE_HUB_ADDRESS -u SLAYZONE_HUB_LISTEN_ADDRESS -u SLAYZONE_HUB_PUBLIC_ADDRESS
       -u SLAYZONE_HUB_REQUIRE_LOGIN -u SLAYZONE_HUB_ENABLE_PASSWORD -u SLAYZONE_HUB_ENABLE_SSO
       -u SLAYZONE_HUB_ENABLE_PROCESSES -u SLAYZONE_HUB_ENABLE_INTEGRATIONS
       -u SLAYZONE_HUB_AUTH_SECRET -u SLAYZONE_HUB_JOIN_TOKEN
       -u ELECTRON_RUN_AS_NODE -u NODE_PATH -u NODE_OPTIONS)

# boot_hub <processes 0|1>: boot, check /health, stop.
boot_hub() {
  local processes="$1" root="$DIR/root-$1" port="" health
  mkdir -p "$root"
  : >"$DIR/hub.log"
  env "${SCRUB[@]}" SLAYZONE_ROOT="$root" SLAYZONE_HUB_LISTEN_ADDRESS=127.0.0.1:0 \
    SLAYZONE_HUB_ENABLE_PROCESSES="$processes" \
    "$DIR/node_modules/.bin/slayzone-hub" >"$DIR/hub.log" 2>&1 &
  HPID=$!
  for i in $(seq 1 30); do
    kill -0 "$HPID" 2>/dev/null || fail "hub (processes=$processes) exited during boot"
    port="$(sed -n 's|.*listening on http://127\.0\.0\.1:\([0-9][0-9]*\).*|\1|p' "$DIR/hub.log" | head -1)"
    [ -n "$port" ] && break
    [ "$i" = "30" ] && fail "hub (processes=$processes) did not boot within 30s"
    sleep 1
  done
  health="$(node -e '
    fetch(`http://127.0.0.1:${process.argv[1]}/health`).then(async (r) => {
      const j = await r.json();
      if (!r.ok || j.ok !== true) throw new Error(`status ${r.status}: ${JSON.stringify(j)}`);
      if (j.switches?.enableProcesses !== (process.argv[2] === "1"))
        throw new Error(`switches.enableProcesses=${j.switches?.enableProcesses}`);
      console.log("ok");
    }).catch((e) => { console.log(String(e.message || e)); process.exit(1); });
  ' "$port" "$processes")" || fail "hub (processes=$processes) /health: $health"
  kill "$HPID" 2>/dev/null || true
  wait "$HPID" 2>/dev/null || true
  HPID=""
}

boot_hub 0
echo "   ✓ processes off: booted without node-pty and /health is ok"
boot_hub 1
echo "   ✓ processes on: booted without node-pty (it is required on the first local spawn)"
echo "   NO-NATIVES SMOKE PASS"
