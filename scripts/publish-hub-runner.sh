#!/usr/bin/env bash
#
# publish-hub-runner.sh — build, verify, and publish @slayzone/hub +
# @slayzone/runner to npm as install-time-rebuild packages.
#
# WHY THIS SCRIPT EXISTS / HOW TO RUN:
#   npm publish is an outward-facing, effectively-irreversible action that needs
#   YOUR npm auth (@slayzone org + 2FA). Run this yourself in your own terminal:
#       bash scripts/publish-hub-runner.sh            # dry run: build + pack + smoke, NO publish
#       bash scripts/publish-hub-runner.sh --publish  # also runs `npm publish --access public`
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
# SECURITY NOTE baked into the published READMEs: the hub's client-facing /trpc
# socket is UNAUTHENTICATED and binds 127.0.0.1 by default. Only expose it
# (SLAYZONE_SERVER_HOST) on a trusted network until user-auth on /trpc lands.

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
pnpm --filter @slayzone/runner build

# --- rewrite each package.json into a publishable, install-time-rebuild manifest ---
# The bundle already inlines workspace deps; published deps = ONLY native externals.
publish_manifest() {
  local pkgdir="$1" pubname="$2" bin="$3" desc="$4"; shift 4
  local natives=("$@")
  node -e '
    const fs=require("fs"), path=require("path");
    const [dir,name,bin,version,desc,...natives]=process.argv.slice(1);
    const src=JSON.parse(fs.readFileSync(path.join(dir,"package.json"),"utf8"));
    const deps={};
    for(const n of natives) deps[n]=src.dependencies[n];
    const out={
      name, version, description: desc, license:"GPL-3.0-only", private:false,
      type:"module", bin:{[bin]:"./dist/bin.cjs"}, main:"./dist/bin.cjs",
      files:["dist/","README.md"], engines:{node:">=24"},
      repository:{type:"git",url:"git+https://github.com/debuglebowski/slayzone.git"},
      dependencies: deps
    };
    fs.writeFileSync(path.join(dir,"package.json"), JSON.stringify(out,null,2)+"\n");
    console.log("   manifest:", name+"@"+version, "deps:", Object.keys(deps).join(", "));
  ' "$pkgdir" "$pubname" "$bin" "$VERSION" "$desc" "${natives[@]}"
}

echo "==> Rewriting publish manifests"
publish_manifest packages/apps/hub "@slayzone/hub" slayzone-hub \
  "SlayZone hub — headless server (DB, routers, auth, runner gateway)" \
  better-sqlite3 node-pty bufferutil utf-8-validate
publish_manifest packages/apps/runner "@slayzone/runner" slayzone-runner \
  "SlayZone runner — remote execution node (pty, git, fs, processes)" \
  node-pty bufferutil utf-8-validate

# --- security-warning README into each package ---
cat > packages/apps/hub/README.md <<'EOF'
# @slayzone/hub (SlayZone hub)

Headless SlayZone hub: owns the SQLite DB, tRPC/REST routers, auth, and the
runner gateway that runners dial into.

    SLAYZONE_DB_PATH=~/.slayzone/hub.sqlite \
      SLAYZONE_RUNNER_TRANSPORT_SECRET=$(openssl rand -hex 32) slayzone-hub

## ⚠️ Security

The client-facing `/trpc` socket is **unauthenticated** and binds `127.0.0.1`
by default. Do **not** set `SLAYZONE_SERVER_HOST` to expose it beyond loopback except
on a fully trusted network — user authentication on `/trpc` is not yet
implemented. Runner traffic (`/runners`) is TLS + cert-pinned and safe to expose.

GPL-3.0-only. Source: https://github.com/debuglebowski/slayzone
EOF
cat > packages/apps/runner/README.md <<'EOF'
# @slayzone/runner (SlayZone runner)

A SlayZone execution node. Dials OUT to a hub over pinned `wss://` using a join
token (mint one on the hub), then runs terminals/agents/git on this machine.

    SLAYZONE_JOIN_TOKEN=<token from the hub> slayzone-runner

The join token embeds the hub URL + cert fingerprint, so nothing else is
required. GPL-3.0-only. Source: https://github.com/debuglebowski/slayzone
EOF

# --- pack both ---
echo "==> npm pack"
( cd packages/apps/hub && npm pack --silent )
( cd packages/apps/runner && npm pack --silent )
HUB_TGZ="$WT/packages/apps/hub/$(ls packages/apps/hub/*.tgz | xargs -n1 basename | tail -1)"
RUN_TGZ="$WT/packages/apps/runner/$(ls packages/apps/runner/*.tgz | xargs -n1 basename | tail -1)"
echo "   $HUB_TGZ"
echo "   $RUN_TGZ"

# --- SMOKE: install BOTH tarballs under PLAIN NODE (proves the ABI rebuild) and
#     drive the full deploy handshake: boot hub → mint join token → boot runner →
#     assert the runner enrolls. This is the ONLY place the published-package
#     native rebuild (better-sqlite3 for the hub, node-pty for the runner) is
#     exercised end-to-end; the dev-tree bins can't (Electron ABI). ---
echo "==> Smoke: clean-install hub + runner tarballs under plain node + drive enroll handshake"
SMOKE="$(mktemp -d /tmp/slz-pub-smoke.XXXXXX)"
HUB_ROOT="$SMOKE/hub-root"; RUN_ROOT="$SMOKE/runner-root"
RUN_CREDS="$SMOKE/runner-creds"; RUN_WORK="$SMOKE/work"
mkdir -p "$HUB_ROOT" "$RUN_ROOT" "$RUN_CREDS" "$RUN_WORK"
( cd "$SMOKE" && mkdir hub runner \
  && ( cd hub && npm init -y >/dev/null && npm install "$HUB_TGZ" >/dev/null 2>&1 ) \
  && ( cd runner && npm init -y >/dev/null && npm install "$RUN_TGZ" >/dev/null 2>&1 ) )

# Shared HMAC secret so the hub's runner-auth verifies the runner it enrolls.
SMOKE_SECRET="$(openssl rand -hex 32)"

# Scrub any inherited SlayZone env before booting. Running this script from
# INSIDE a SlayZone session (dogfooding) leaks SLAYZONE_SUPERVISED=1 +
# SLAYZONE_DB_PATH (pointing at the real dev DB) + ELECTRON_RUN_AS_NODE into a
# child — which would (a) skip schema bootstrap (supervised ⇒ "no such table:
# tasks") giving a FALSE failure, and (b) risk touching the real store. Scrub the
# full set via `-u`; ports are 0 (OS-assigned) so nothing collides with a running
# app. HUB_ROOT anchors the hub's config + identity + auth DB in the tmp tree.
SCRUB=(-u SLAYZONE_SUPERVISED -u SLAYZONE_DB_PATH -u SLAYZONE_ROOT
       -u SLAYZONE_SERVER_PORT -u SLAYZONE_RUNNER_TRANSPORT_PORT -u SLAYZONE_RUNNER_TRANSPORT_SECRET
       -u SLAYZONE_HUB_URL -u SLAYZONE_JOIN_TOKEN -u SLAYZONE_RUNNER_CREDENTIALS_DIR
       -u ELECTRON_RUN_AS_NODE)

# Fixed loopback port for the hub's shared HTTP server (health + join-token REST);
# the /runners wss port stays OS-assigned (0) and is embedded in the minted token.
HUB_PORT=47811
env "${SCRUB[@]}" \
  SLAYZONE_ROOT="$HUB_ROOT" SLAYZONE_SERVER_PORT="$HUB_PORT" \
  SLAYZONE_RUNNER_TRANSPORT_PORT=0 \
  SLAYZONE_RUNNER_TRANSPORT_SECRET="$SMOKE_SECRET" \
  node "$SMOKE/hub/node_modules/.bin/slayzone-hub" > "$SMOKE/hub.log" 2>&1 &
HPID=$!

smoke_fail() {
  echo "   SMOKE FAIL — $1"
  echo "   --- hub.log ---";    grep -vE "Migration [0-9]+ applied" "$SMOKE/hub.log" 2>/dev/null | tail -25
  echo "   --- runner.log ---"; tail -25 "$SMOKE/runner.log" 2>/dev/null
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

# Mint a join token over the loopback REST channel (503 until the /runners wss
# listener has bound). Needs a JSON body; curl is universally present on CI.
TOKEN_JSON=""
for i in $(seq 1 20); do
  TOKEN_JSON="$(curl -s -X POST "http://127.0.0.1:$HUB_PORT/api/runners/join-token" \
    -H 'content-type: application/json' -d '{"label":"publish-smoke"}' 2>/dev/null || true)"
  echo "$TOKEN_JSON" | grep -q '"token"' && break
  [ "$i" = "20" ] && smoke_fail "join-token mint never succeeded (runner listener bind?)"
  sleep 1
done
JOIN_TOKEN="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).token)' "$TOKEN_JSON")"
HUB_WSS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).hubUrl)' "$TOKEN_JSON")"
echo "   ✓ minted join token (hub runner url: $HUB_WSS)"

# Boot the runner from ITS tarball (proves node-pty rebuilt for the consumer ABI)
# and point it at the minted token. The FS path-jail has no env channel — it comes
# from <ROOT>/config.json `allowedRoots` (or the SLAYZONE_ROOT default in bin.ts).
echo '{"allowedRoots":["'"$RUN_WORK"'"]}' > "$RUN_ROOT/config.json"
env "${SCRUB[@]}" \
  SLAYZONE_ROOT="$RUN_ROOT" SLAYZONE_HUB_URL="$HUB_WSS" SLAYZONE_JOIN_TOKEN="$JOIN_TOKEN" \
  SLAYZONE_RUNNER_CREDENTIALS_DIR="$RUN_CREDS" \
  node "$SMOKE/runner/node_modules/.bin/slayzone-runner" > "$SMOKE/runner.log" 2>&1 &
RPID=$!

# Assert enrollment via the RUNNER's stdout: on a fresh runner the dialer logs
# `connected to hub {…,"mode":"enroll"}` — the hub accepted the join token, minted
# credentials over the pinned wss link, and the handshake completed. (The hub's own
# "runner enrolled" line goes to <dataRoot>/logs/sidecar.log, NOT stdout — see
# hub/src/log.ts — so we assert on the runner's captured stdout, and specifically
# on mode=enroll: a fresh credential-less runner must ENROLL, not hello-reconnect.)
for i in $(seq 1 20); do
  if grep -q '"mode":"enroll"' "$SMOKE/runner.log" 2>/dev/null; then break; fi
  kill -0 "$RPID" 2>/dev/null || smoke_fail "runner process exited before enrolling"
  [ "$i" = "20" ] && smoke_fail "runner did not enroll within 20s"
  sleep 1
done
echo "   ✓ runner enrolled into the hub over the pinned wss link"
echo "   SMOKE PASS — installed hub + runner completed the enroll handshake under plain node"
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
# (e.g. hub published, runner failed) must be resumable. Skip any name@version
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
publish_one packages/apps/runner "@slayzone/runner"
echo "==> Done — @slayzone/hub@$VERSION + @slayzone/runner@$VERSION at tag: $NPM_TAG"
