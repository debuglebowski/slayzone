#!/usr/bin/env bash
#
# publish-npm.sh — build, verify, and publish @slayzone/hub, @slayzone/computer and
# @slayzone/cli to npm.
#
# hub + computer are install-time-rebuild packages (native addons); the CLI has no
# native deps and publishes as a plain self-contained bundle. Of the hub's natives only
# better-sqlite3 is required: node-pty and bufferutil are OPTIONAL, so
# the hub installs and boots on a machine with no compiler (T-30).
#
# WHY THIS SCRIPT EXISTS / HOW TO RUN:
#   npm publish is an outward-facing, effectively-irreversible action that needs
#   YOUR npm auth (@slayzone org + 2FA). Run this yourself in your own terminal:
#       bash scripts/publish-npm.sh            # dry run: build + pack + smoke, NO publish
#       bash scripts/publish-npm.sh --publish  # also runs `npm publish --access public`
#
# It builds from a CLEAN git HEAD worktree (so any uncommitted work in your main
# tree is NOT baked into the published bundle). The esbuild build inlines all
# @slayzone/* workspace deps into a single dist/bin.cjs; only the native addons
# stay external and are rebuilt on the target machine at `npm install` time
# (that's the ABI fix — dev-tree binaries are Electron-ABI and crash under
# plain node).
#
# PRECONDITIONS you must satisfy:
#   - You own/control the `@slayzone` npm scope (else the scoped publish fails).
#   - Auth for --publish: in CI, npm Trusted Publishing (OIDC) — no token, npm
#     >=11.5.1 exchanges the GitHub OIDC token for a scoped publish credential
#     (org must have a Trusted Publisher for both pkgs). Local: `npm login`.
#   - Decide the version below (VERSION=...). npm versions are near-permanent;
#     to iterate, bump the patch and publish again.
#
# SECURITY NOTE baked into the published READMEs: the hub listens on 127.0.0.1 with
# no login by default, and serves plain http. A hub that other machines can reach
# refuses to start unless it requires login, publishes a public address (the TLS
# front end that terminates TLS) and has SLAYZONE_HUB_AUTH_SECRET in its env.

set -euo pipefail

DO_PUBLISH=0
[ "${1:-}" = "--publish" ] && DO_PUBLISH=1

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Version = the shared workspace version (stamped from @slayzone/app by
# scripts/sync-versions.mjs). Override with SLZ_PUBLISH_VERSION if needed.
VERSION="${SLZ_PUBLISH_VERSION:-$(node -p "require('$REPO_ROOT/packages/apps/app/package.json').version")}"
WT="$(mktemp -d /tmp/slz-publish-wt.XXXXXX)"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"

cleanup() { git -C "$REPO_ROOT" worktree remove --force "$WT" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> Building from clean HEAD $HEAD_SHA in throwaway worktree: $WT"
git -C "$REPO_ROOT" worktree add --detach "$WT" HEAD
cd "$WT"
pnpm install --frozen-lockfile
pnpm --filter @slayzone/hub build
# Web UI: vite writes it to packages/apps/hub/dist/web, which the hub serves at `/`
# (build.mjs never cleans dist/, so the order vs the hub build is free). Build env
# is pinned here, not inherited from whoever runs this (decided in T-24): no
# VITE_CONVEX_URL, so Convex stays off in the hub UI; no POSTHOG_* overrides, so
# PostHog keeps vite.config.ts's defaults (anonymous tier, eu.i.posthog.com).
env -u VITE_CONVEX_URL -u POSTHOG_DISABLED -u POSTHOG_API_KEY -u POSTHOG_HOST \
  pnpm --filter @slayzone/web-shell build
pnpm --filter @slayzone/computer build
pnpm --filter @slayzone/cli build

# --- rewrite each package.json into a publishable, install-time-rebuild manifest ---
# The bundle already inlines workspace deps; published deps = ONLY native externals.
#
# publish_manifest <pkgdir> <pubname> <bin> <entry> <desc> [native-dep...] [--optional native-dep...]
#   entry — the bundle the bin points at, relative to the package root. The hub
#           and computer emit dist/bin.cjs; the CLI emits dist/slay.js.
#   native-dep... — may be EMPTY (the CLI has no native deps). Under `set -u`,
#           bash 3.2 (which macOS still ships) treats `"${arr[@]}"` on an empty
#           array as an unbound variable, so the args are passed through "$@"
#           directly rather than via an intermediate array.
#   --optional — the natives after it go to `optionalDependencies`: npm still tries
#           to build them, and drops them instead of failing the install when it
#           cannot. Only for natives the bundle loads lazily or in a try/catch.
publish_manifest() {
  local pkgdir="$1" pubname="$2" bin="$3" entry="$4" desc="$5"; shift 5
  node -e '
    const fs=require("fs"), path=require("path");
    const [dir,name,bin,entry,version,desc,...natives]=process.argv.slice(1);
    const src=JSON.parse(fs.readFileSync(path.join(dir,"package.json"),"utf8"));
    const deps={}, optional={};
    let into=deps;
    for(const n of natives){
      if(n==="--optional"){ into=optional; continue; }
      into[n]=src.dependencies[n];
    }
    const out={
      name, version, description: desc, license:"GPL-3.0-only", private:false,
      type:"module", bin:{[bin]:entry}, main:entry,
      files:["dist/","README.md"], engines:{node:">=24"},
      repository:{type:"git",url:"git+https://github.com/debuglebowski/slayzone.git"},
      dependencies: deps,
      ...(Object.keys(optional).length ? { optionalDependencies: optional } : {})
    };
    fs.writeFileSync(path.join(dir,"package.json"), JSON.stringify(out,null,2)+"\n");
    console.log("   manifest:", name+"@"+version, "bin:", entry,
      "deps:", Object.keys(deps).join(", ") || "(none)",
      ...(Object.keys(optional).length ? ["optional:", Object.keys(optional).join(", ")] : []));
  ' "$pkgdir" "$pubname" "$bin" "$entry" "$VERSION" "$desc" "$@"
}

echo "==> Rewriting publish manifests"
# The hub's DB needs better-sqlite3. node-pty is required only on a hub-local pty
# spawn (never with SLAYZONE_HUB_ENABLE_PROCESSES=0) and ws loads bufferutil in a
# try/catch, so those two are optional (T-30). ws's other accelerator, utf-8-validate,
# is never loaded on Node >= 18.14 (buffer.isUtf8), so it is not shipped at all. The
# computer keeps node-pty required: spawning ptys is its job.
publish_manifest packages/apps/hub "@slayzone/hub" slayzone-hub ./dist/bin.cjs \
  "SlayZone hub — headless server (DB, routers, auth, computer gateway)" \
  better-sqlite3 --optional node-pty bufferutil
publish_manifest packages/apps/computer "@slayzone/computer" slayzone-computer ./dist/bin.cjs \
  "SlayZone computer — remote execution node (pty, git, fs, processes)" \
  node-pty bufferutil
# The CLI has NO native deps: build.mjs inlines every workspace dep and leaves only
# the `node:sqlite` builtin external, so there is nothing to rebuild at install
# time (unlike hub/computer). Zero dependencies is therefore correct, not an omission.
publish_manifest packages/apps/cli "@slayzone/cli" slay ./dist/slay.js \
  "SlayZone CLI — run, list and target SlayZone hubs; drive tasks, ptys and projects"

# --- security-warning README into each package ---
cat > packages/apps/hub/README.md <<'EOF'
# @slayzone/hub (SlayZone hub)

Headless SlayZone hub: owns the SQLite DB, tRPC/REST routers, auth, and the
computer gateway that computers dial into.

    SLAYZONE_ROOT=~/slayzone-hub \
      SLAYZONE_HUB_AUTH_SECRET=$(openssl rand -hex 32) slayzone-hub

`SLAYZONE_ROOT` is the install anchor: all state (DB, artifacts, logs)
lives under `<ROOT>/storage`, and the DB filename is derived — not overridable.
Omit it and the hub anchors to its launch directory.

The web UI is served at `/` on the hub's address.

## Reaching it from other machines

By default the hub listens on `127.0.0.1` and requires no login — the same hub the
desktop app runs. The hub itself serves plain http and never does TLS: to let other
machines in, put a TLS front end (Caddy, nginx, a cloud load balancer) in front of it
and tell the hub both addresses (`host[:port]`, no scheme):

    SLAYZONE_HUB_LISTEN_ADDRESS=0.0.0.0:8788      # where the hub listens
    SLAYZONE_HUB_PUBLIC_ADDRESS=hub.example.com   # how clients and computers reach it
    SLAYZONE_HUB_REQUIRE_LOGIN=1
    SLAYZONE_HUB_AUTH_SECRET=$(openssl rand -hex 32)

A hub that other machines can reach (a listen address that is not loopback, or a public
address) **refuses to start** unless it requires login, has a public address and has
`SLAYZONE_HUB_AUTH_SECRET` in its environment — it never generates that key onto its own
disk. Clients dial the public address with `https://` / `wss://` (any host that is not
loopback); loopback is plain `http://` / `ws://`.

Switches (`0` or `1`; anything else refuses to start), each also a boolean in
`<ROOT>/hub.config.json` (env wins):

| Variable | Default | |
| --- | --- | --- |
| `SLAYZONE_HUB_REQUIRE_LOGIN` | `0` | every client must sign in |
| `SLAYZONE_HUB_ENABLE_PASSWORD` | `1` | email + password sign-in |
| `SLAYZONE_HUB_ENABLE_SSO` | `0` | Entra sign-in (needs `SLAYZONE_HUB_SSO_TENANT_ID`, `_CLIENT_ID`, `_CERT_PATH`, `_KEY_PATH` and a public address; `SLAYZONE_HUB_SSO_REQUIRE_MFA`, default `1`) |
| `SLAYZONE_HUB_ENABLE_PROCESSES` | `1` | hub-local processes |
| `SLAYZONE_HUB_ENABLE_INTEGRATIONS` | `1` | Linear / GitHub |

Today the hub validates and reports every switch (`/health`) and enforces
`REQUIRE_LOGIN`; enforcing the others follows.

GPL-3.0-only. Source: https://github.com/debuglebowski/slayzone
EOF
cat > packages/apps/computer/README.md <<'EOF'
# @slayzone/computer (SlayZone computer)

A SlayZone execution node. Dials OUT to a hub using a join token (mint one on the
hub; `wss://` for any hub that is not on this machine), then runs terminals/agents/git
on this machine.

    SLAYZONE_HUB_JOIN_TOKEN=<token from the hub> slayzone-computer

The join token embeds the hub URL, so nothing else is required.

This runs the computer in the FOREGROUND: it will not come back after a crash or a
logout. To install it as a supervised service instead, use the CLI:

    npm install -g @slayzone/cli
    slay computer create <name> --token <token from the hub>

GPL-3.0-only. Source: https://github.com/debuglebowski/slayzone
EOF
cat > packages/apps/cli/README.md <<'EOF'
# @slayzone/cli (`slay`)

Command-line control for SlayZone hubs, plus tasks, terminals and projects.

    npm install -g @slayzone/cli

## Hubs on this machine

    slay hub create <name>  # create a hub in this directory and keep it running
    slay hub ls             # every hub running on this machine
    slay hub logs <name>
    slay hub stop <name>    # stop it, keep it registered
    slay hub start <name>   # bring a stopped hub back
    slay hub rm <name>      # stop it and remove its registration

`hub create` registers the hub with your OS service manager (launchd on macOS,
systemd --user on Linux), so it restarts if it crashes and starts again when you
log in. Names are unique per machine — `create` fails if one already exists. To
run a hub in the foreground instead, use `npx @slayzone/hub`.

## Computers on this machine

A computer is an execution node: it dials out to a hub and runs terminals, agents
and git there. Mint a join token on the hub, then:

    slay computer create <name> --token <szjt1…>   # install it here and keep it running
    slay computer ls              # every computer installed on this machine
    slay computer logs <name>
    slay computer stop <name>     # stop it, keep it registered
    slay computer start <name>    # bring a stopped computer back
    slay computer rm <name>       # stop it and remove its registration

The token embeds the hub URL, so `--token` is the only configuration needed. It is stored in `<root>/config.json` (owner-only) — never in
the service unit. `--root <dir>` picks where the computer's config, credentials and
logs live (default: the current directory), and `--allow <dir>` (repeatable) sets
the filesystem roots it may touch. One computer per root.

`create` waits until the computer has actually reached its hub, and unregisters
itself again if it cannot — so a bad token fails loudly instead of leaving a
service that retries forever. `rm` leaves the computer's data on disk and does NOT
revoke it on the hub; revoke it there if the machine is going away.

## Targeting a hub

    slay hub use <name|url>     # point this CLI at a hub
    slay hub current            # which hub am I pointed at?
    slay --hub staging tasks list   # one-off override

GPL-3.0-only. Source: https://github.com/debuglebowski/slayzone
EOF

# --- pack all three ---
echo "==> npm pack"
( cd packages/apps/hub && npm pack --silent )
( cd packages/apps/computer && npm pack --silent )
( cd packages/apps/cli && npm pack --silent )
HUB_TGZ="$WT/packages/apps/hub/$(ls packages/apps/hub/*.tgz | xargs -n1 basename | tail -1)"
RUN_TGZ="$WT/packages/apps/computer/$(ls packages/apps/computer/*.tgz | xargs -n1 basename | tail -1)"
CLI_TGZ="$WT/packages/apps/cli/$(ls packages/apps/cli/*.tgz | xargs -n1 basename | tail -1)"
echo "   $HUB_TGZ"
echo "   $RUN_TGZ"
echo "   $CLI_TGZ"

# The hub tarball must carry the web UI: `files` ships dist/, so a missing bundle
# means the web-shell build above never landed in dist/web.
pack_fail() { echo "   PACK FAIL — $1"; echo "Aborting before publish."; exit 1; }
HUB_FILES="$(tar tzf "$HUB_TGZ")"
grep -qx 'package/dist/web/index.html' <<<"$HUB_FILES" \
  || pack_fail "hub tarball has no package/dist/web/index.html (web UI not built)"
grep -qE '^package/dist/web/assets/[^/]+\.js$' <<<"$HUB_FILES" \
  || pack_fail "hub tarball has no package/dist/web/assets/*.js (web UI not built)"
echo "   ✓ hub tarball carries the web UI ($(grep -c '^package/dist/web/' <<<"$HUB_FILES") of $(wc -l <<<"$HUB_FILES" | tr -d ' ') files, $(du -h "$HUB_TGZ" | cut -f1))"

# What a machine with no compiler gets: the hub without its optional natives must
# install and boot (T-30). Fails the run, like every smoke below.
bash scripts/smoke-hub-no-natives.sh "$HUB_TGZ" || { echo "Aborting before publish."; exit 1; }

# --- SMOKE: install BOTH tarballs under PLAIN NODE (proves the ABI rebuild) and
#     drive the full deploy handshake: boot hub → mint join token → boot computer →
#     assert the computer enrolls. This is the ONLY place the published-package
#     native rebuild (better-sqlite3 for the hub, node-pty for the computer) is
#     exercised end-to-end; the dev-tree bins can't (Electron ABI). ---
echo "==> Smoke: clean-install hub + computer tarballs under plain node + drive enroll handshake"
SMOKE="$(mktemp -d /tmp/slz-pub-smoke.XXXXXX)"
HUB_ROOT="$SMOKE/hub-root"; RUN_ROOT="$SMOKE/computer-root"
RUN_CREDS="$SMOKE/computer-creds"; RUN_WORK="$SMOKE/work"
mkdir -p "$HUB_ROOT" "$RUN_ROOT" "$RUN_CREDS" "$RUN_WORK"
( cd "$SMOKE" && mkdir hub computer cli \
  && ( cd hub && npm init -y >/dev/null && npm install "$HUB_TGZ" >/dev/null 2>&1 ) \
  && ( cd computer && npm init -y >/dev/null && npm install "$RUN_TGZ" >/dev/null 2>&1 ) \
  && ( cd cli && npm init -y >/dev/null && npm install "$CLI_TGZ" >/dev/null 2>&1 ) )

# Both bins MUST carry a `#!/usr/bin/env node` shebang: npm/npx exec the bin
# DIRECTLY (no `node` prefix), so a shebang-less bundle is handed to /bin/sh,
# which runs the JS as a shell script (`use strict: not found`, `var: not
# found`, `Syntax error: "(" unexpected`). Assert it on the INSTALLED bins —
# the same files npx runs — before anything else, so the failure names the
# cause instead of surfacing as a confusing boot error further down.
for b in "$SMOKE/hub/node_modules/.bin/slayzone-hub" \
         "$SMOKE/computer/node_modules/.bin/slayzone-computer" \
         "$SMOKE/cli/node_modules/.bin/slay"; do
  # `.bin` entries are symlinks on posix and shim scripts on Windows; resolve so
  # we read the bundle itself.
  target="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$b")"
  head -1 "$target" | grep -q '^#!.*node' \
    || { echo "   SMOKE FAIL — $b has no node shebang (npx would run it via /bin/sh)"
         rm -rf "$SMOKE"; echo "Aborting before publish."; exit 1; }
done
echo "   ✓ all three published bins carry a node shebang"

# Shared HMAC secret so the hub's computer-auth verifies the computer it enrolls.
SMOKE_SECRET="$(openssl rand -hex 32)"

# Scrub any inherited SlayZone env before booting. Running this script from
# INSIDE a SlayZone session (supervised mode) leaks SLAYZONE_SUPERVISED=1 +
# SLAYZONE_ROOT (pointing at the real dev install) + ELECTRON_RUN_AS_NODE into a
# child — which would (a) skip schema bootstrap (supervised ⇒ "no such table:
# tasks") giving a FALSE failure, and (b) risk touching the real store. Scrub the
# full set via `-u`; ports are 0 (OS-assigned) so nothing collides with a running
# app. HUB_ROOT anchors the hub's config + auth DB in the tmp tree.
SCRUB=(-u SLAYZONE_SUPERVISED -u SLAYZONE_ROOT
       -u SLAYZONE_HUB_ADDRESS -u SLAYZONE_HUB_LISTEN_ADDRESS -u SLAYZONE_HUB_PUBLIC_ADDRESS
       -u SLAYZONE_HUB_REQUIRE_LOGIN -u SLAYZONE_HUB_ENABLE_PASSWORD -u SLAYZONE_HUB_ENABLE_SSO
       -u SLAYZONE_HUB_ENABLE_PROCESSES -u SLAYZONE_HUB_ENABLE_INTEGRATIONS
       -u SLAYZONE_HUB_AUTH_SECRET
       -u SLAYZONE_HUB_JOIN_TOKEN
       -u SLAYZONE_COMPUTER_CREDENTIALS_DIR
       -u ELECTRON_RUN_AS_NODE)

# Fixed loopback port for the hub's ONE listener (tRPC + health + join-token REST +
# /computers, demuxed by path). The computer URL embedded in the minted token rides
# this same port; there is no separate computer port to set.
HUB_PORT=47811
env "${SCRUB[@]}" \
  SLAYZONE_ROOT="$HUB_ROOT" SLAYZONE_HUB_LISTEN_ADDRESS="127.0.0.1:$HUB_PORT" \
  SLAYZONE_HUB_AUTH_SECRET="$SMOKE_SECRET" \
  "$SMOKE/hub/node_modules/.bin/slayzone-hub" > "$SMOKE/hub.log" 2>&1 &
HPID=$!

smoke_fail() {
  echo "   SMOKE FAIL — $1"
  echo "   --- hub.log ---";    grep -vE "Migration [0-9]+ applied" "$SMOKE/hub.log" 2>/dev/null | tail -25
  echo "   --- computer.log ---"; tail -25 "$SMOKE/computer.log" 2>/dev/null
  kill "$HPID" "${RPID:-}" 2>/dev/null || true
  rm -rf "$SMOKE"
  echo "Aborting before publish." ; exit 1
}

# Wait for the hub to boot (listening line) under plain node — proves the hub's
# better-sqlite3 rebuilt for the consumer ABI.
for i in $(seq 1 30); do
  kill -0 "$HPID" 2>/dev/null || smoke_fail "hub process exited during boot"
  grep -q "listening on http://127.0.0.1:$HUB_PORT" "$SMOKE/hub.log" && break
  [ "$i" = "30" ] && smoke_fail "hub did not boot from the tarball within 30s"
  sleep 1
done
echo "   ✓ hub booted from the published tarball under plain node"

# The web UI: `/` must return the shell's index.html, and one asset it references
# must come back as JS. Check the content type, not only the 200: an unknown path
# also gets index.html with a 200 (the SPA fallback in web-assets.ts).
INDEX_CODE="$(curl -s -o "$SMOKE/index.html" -w '%{http_code}' "http://127.0.0.1:$HUB_PORT/" || true)"
if [ "$INDEX_CODE" != "200" ] || ! grep -q '<title>SlayZone</title>' "$SMOKE/index.html"; then
  smoke_fail "GET / did not return the web UI (HTTP $INDEX_CODE, want 200 + <title>SlayZone</title>)"
fi
ASSET_JS="$(grep -oE '/assets/[^"]+\.js' "$SMOKE/index.html" | sed -n 1p || true)"
[ -n "$ASSET_JS" ] || smoke_fail "GET / returned no /assets/*.js reference"
ASSET_RES="$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "http://127.0.0.1:$HUB_PORT$ASSET_JS" || true)"
case "$ASSET_RES" in
  "200 text/javascript"*) ;;
  *) smoke_fail "GET $ASSET_JS did not return JS (got '$ASSET_RES')" ;;
esac
echo "   ✓ hub serves the web UI at / ($ASSET_JS)"

# Mint a join token over the loopback REST channel (503 until the /computers wss
# listener has bound). Needs a JSON body; curl is universally present on CI.
TOKEN_JSON=""
for i in $(seq 1 20); do
  TOKEN_JSON="$(curl -s -X POST "http://127.0.0.1:$HUB_PORT/api/computers/join-token" \
    -H 'content-type: application/json' -d '{"label":"publish-smoke"}' 2>/dev/null || true)"
  echo "$TOKEN_JSON" | grep -q '"token"' && break
  [ "$i" = "20" ] && smoke_fail "join-token mint never succeeded (computer listener bind?)"
  sleep 1
done
JOIN_TOKEN="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).token)' "$TOKEN_JSON")"
HUB_WSS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).hubUrl)' "$TOKEN_JSON")"
echo "   ✓ minted join token (hub computer url: $HUB_WSS)"

# Boot the computer from ITS tarball (proves node-pty rebuilt for the consumer ABI)
# and point it at the minted token — which is self-sufficient: it embeds the hub's
# `/computers` url (plain `ws://` here, the hub being on loopback with no public
# address; it carries no certificate pin), so no address env is needed. The FS
# path-jail has no env channel either — it comes from
# <ROOT>/config.json `allowedRoots` (or the SLAYZONE_ROOT default in bin.ts).
echo '{"allowedRoots":["'"$RUN_WORK"'"]}' > "$RUN_ROOT/config.json"
env "${SCRUB[@]}" \
  SLAYZONE_ROOT="$RUN_ROOT" SLAYZONE_HUB_JOIN_TOKEN="$JOIN_TOKEN" \
  SLAYZONE_COMPUTER_CREDENTIALS_DIR="$RUN_CREDS" \
  "$SMOKE/computer/node_modules/.bin/slayzone-computer" > "$SMOKE/computer.log" 2>&1 &
RPID=$!

# Assert enrollment via the COMPUTER's stdout: on a fresh computer the dialer logs
# `connected to hub {…,"mode":"enroll"}` — the hub accepted the join token, minted
# credentials over the link, and the handshake completed. (The hub's own
# "computer enrolled" line goes to <dataRoot>/logs/sidecar.log, NOT stdout — see
# hub/src/log.ts — so we assert on the computer's captured stdout, and specifically
# on mode=enroll: a fresh credential-less computer must ENROLL, not hello-reconnect.)
for i in $(seq 1 20); do
  if grep -q '"mode":"enroll"' "$SMOKE/computer.log" 2>/dev/null; then break; fi
  kill -0 "$RPID" 2>/dev/null || smoke_fail "computer process exited before enrolling"
  [ "$i" = "20" ] && smoke_fail "computer did not enroll within 20s"
  sleep 1
done
echo "   ✓ computer enrolled into the hub with the pin-less join token"

# --- CLI smoke: the published `slay` must DISCOVER the running hub and STOP it.
# Discovery probes the hub port block, but this smoke hub binds a fixed loopback
# port ($HUB_PORT) outside that block, so point the CLI straight at it with
# `--hub <port>` (a direct probe — see hub-discovery's findHub). That covers the
# whole chain on published artifacts: bundle boots under plain node → /health
# identity fields present → hub resolved → SIGTERM path (this hub has no service
# unit) terminates it.
#
# Deliberately NOT `slay hub create`: that REGISTERS a launchd/systemd unit, and a
# publish smoke must not install a service on the CI computer or a developer's
# machine. Unit-file content is covered by platform/src/service-unit.test.ts.
SLAY="$SMOKE/cli/node_modules/.bin/slay"
CLI_ENV=(env "${SCRUB[@]}" SLAYZONE_ROOT="$HUB_ROOT")

# (a) The bundle executes at all under plain node. `--version` needs no hub and no
#     database, so a failure here is unambiguously a broken bundle.
CLI_VERSION="$("${CLI_ENV[@]}" "$SLAY" --version 2>&1)" \
  || smoke_fail "published slay failed to run: $CLI_VERSION"
[ "$CLI_VERSION" = "$VERSION" ] \
  || smoke_fail "published slay reports version '$CLI_VERSION', expected '$VERSION'"
echo "   ✓ published slay runs under plain node (v$CLI_VERSION)"

# (b) Discovery resolves the live hub and reports its identity. `--hub <port>`
#     probes directly, which is what reaches this fixed out-of-block port.
HUB_JSON="$("${CLI_ENV[@]}" "$SLAY" --hub "$HUB_PORT" hub current 2>&1)" \
  || smoke_fail "slay could not reach the hub on $HUB_PORT: $HUB_JSON"
echo "$HUB_JSON" | grep -q "Health: ok" \
  || smoke_fail "slay hub current did not report a healthy hub: $HUB_JSON"
echo "   ✓ slay resolved the running hub and probed it healthy"

# (c) Stop the smoke hub THROUGH the CLI — the real end-to-end assertion. This
#     exercises resolve-by-port → /health identity (pid) → SIGTERM fallback (this
#     hub has no service unit) → confirm-it-stopped.
STOP_OUT="$("${CLI_ENV[@]}" "$SLAY" hub stop "$HUB_PORT" 2>&1)" \
  || smoke_fail "slay hub stop failed: $STOP_OUT"
for i in $(seq 1 15); do
  kill -0 "$HPID" 2>/dev/null || break
  [ "$i" = "15" ] && smoke_fail "hub still alive after slay hub stop: $STOP_OUT"
  sleep 1
done
echo "   ✓ slay hub stop terminated the hub (discovery + SIGTERM path)"

echo "   SMOKE PASS — hub served the web UI, computer enrolled, and the published CLI drove the hub, under plain node"
kill "$HPID" "$RPID" 2>/dev/null || true
rm -rf "$SMOKE"

if [ "$DO_PUBLISH" -ne 1 ]; then
  echo "==> DRY RUN complete. Tarballs built + smoke-verified. Re-run with --publish to publish."
  echo "    Copy a tarball to your server and 'npm install ./<tgz>' to deploy without publishing."
  exit 0
fi

# --- PUBLISH (needs npm auth + @slayzone org) ---
# Auth resolves from Trusted Publishing OIDC (CI: npm >=11.5.1 auto-detects the
# GitHub OIDC token, no NODE_AUTH_TOKEN) or an interactive `npm login` (local).
# `npm whoami` is only a courtesy label and is NOT gated on — it returns nothing
# under OIDC even though publish works.
WHO="$(npm whoami 2>/dev/null || echo 'token-auth')"
# Prereleases (0.36.0-beta.2) must NOT go to the `latest` dist-tag — npm rejects
# it. Route pre-releases to `beta`, stable to `latest`.
case "$VERSION" in
  *-*) NPM_TAG="beta" ;;
  *)   NPM_TAG="latest" ;;
esac
echo "==> Publishing to npm (auth: $WHO, tag: $NPM_TAG)"

# Idempotent per package: an immutable npm version means a partial prior run
# (e.g. hub published, computer failed) must be resumable. Skip any name@version
# already on the registry; publish the rest. Makes any re-dispatch safe.
publish_one() {
  local dir="$1" name="$2"
  if npm view "$name@$VERSION" version >/dev/null 2>&1; then
    echo "   skip $name@$VERSION — already on registry"
    return 0
  fi
  ( cd "$dir" && npm publish --access public --tag "$NPM_TAG" )
  echo "   published $name@$VERSION"
}
publish_one packages/apps/hub "@slayzone/hub"
publish_one packages/apps/computer "@slayzone/computer"
publish_one packages/apps/cli "@slayzone/cli"
echo "==> Done — @slayzone/hub + @slayzone/computer + @slayzone/cli @$VERSION at tag: $NPM_TAG"
