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
#   - Auth for --publish: NODE_AUTH_TOKEN (CI) or `npm login` (local). @slayzone org.
#   - Decide the version below (VERSION=...). npm versions are near-permanent;
#     to iterate, bump the patch and publish again.
#
# SECURITY NOTE baked into the published READMEs: the hub's client-facing /trpc
# socket is UNAUTHENTICATED and binds 127.0.0.1 by default. Only expose it
# (SLAYZONE_HOST) on a trusted network until user-auth on /trpc lands.

set -euo pipefail

VERSION="${SLZ_PUBLISH_VERSION:-0.1.0}"
DO_PUBLISH=0
[ "${1:-}" = "--publish" ] && DO_PUBLISH=1

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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
      files:["dist/","README.md"], engines:{node:">=20"},
      repository:{type:"git",url:"git+https://github.com/JCB-K/SlayZone.git"},
      dependencies: deps
    };
    fs.writeFileSync(path.join(dir,"package.json"), JSON.stringify(out,null,2)+"\n");
    console.log("   manifest:", name+"@"+version, "deps:", Object.keys(deps).join(", "));
  ' "$pkgdir" "$pubname" "$bin" "$VERSION" "$desc" "${natives[@]}"
}

echo "==> Rewriting publish manifests"
publish_manifest packages/apps/hub "@slayzone/hub" slayzone-hub \
  "SlayZone hub — headless server (DB, routers, auth, fleet gateway)" \
  better-sqlite3 node-pty bufferutil utf-8-validate
publish_manifest packages/apps/runner "@slayzone/runner" slayzone-runner \
  "SlayZone runner — remote execution node (pty, git, fs, processes)" \
  node-pty bufferutil utf-8-validate

# --- security-warning README into each package ---
cat > packages/apps/hub/README.md <<'EOF'
# @slayzone/hub (SlayZone hub)

Headless SlayZone hub: owns the SQLite DB, tRPC/REST routers, auth, and the
fleet gateway that runners dial into.

    SLAYZONE_FLEET_MODE=1 SLAYZONE_DB_PATH=~/.slayzone/hub.sqlite \
      SLAYZONE_FLEET_SECRET=$(openssl rand -hex 32) slayzone-hub

## ⚠️ Security

The client-facing `/trpc` socket is **unauthenticated** and binds `127.0.0.1`
by default. Do **not** set `SLAYZONE_HOST` to expose it beyond loopback except
on a fully trusted network — user authentication on `/trpc` is not yet
implemented. Runner traffic (`/fleet`) is TLS + cert-pinned and safe to expose.

GPL-3.0-only. Source: https://github.com/JCB-K/SlayZone
EOF
cat > packages/apps/runner/README.md <<'EOF'
# @slayzone/runner (SlayZone runner)

A SlayZone execution node. Dials OUT to a hub over pinned `wss://` using a join
token (mint one on the hub), then runs terminals/agents/git on this machine.

    SLAYZONE_JOIN_TOKEN=<token from the hub> slayzone-runner

The join token embeds the hub URL + cert fingerprint, so nothing else is
required. GPL-3.0-only. Source: https://github.com/JCB-K/SlayZone
EOF

# --- pack both ---
echo "==> npm pack"
( cd packages/apps/hub && npm pack --silent )
( cd packages/apps/runner && npm pack --silent )
HUB_TGZ="$WT/packages/apps/hub/$(ls packages/apps/hub/*.tgz | xargs -n1 basename | tail -1)"
RUN_TGZ="$WT/packages/apps/runner/$(ls packages/apps/runner/*.tgz | xargs -n1 basename | tail -1)"
echo "   $HUB_TGZ"
echo "   $RUN_TGZ"

# --- SMOKE: install the hub tarball under PLAIN NODE (proves the ABI rebuild) + boot it ---
echo "==> Smoke: clean-install hub tarball under plain node + boot headless"
SMOKE="$(mktemp -d /tmp/slz-pub-smoke.XXXXXX)"
( cd "$SMOKE" && npm init -y >/dev/null && npm install "$HUB_TGZ" >/dev/null 2>&1 )
SDB="$SMOKE/hub.sqlite"
SLAYZONE_DB_PATH="$SDB" SLAYZONE_STORE_DIR="$SMOKE" SLAYZONE_PORT=47811 \
  SLAYZONE_FLEET_MODE=1 SLAYZONE_FLEET_PORT=47812 \
  SLAYZONE_FLEET_SECRET="$(openssl rand -hex 32)" \
  node "$SMOKE/node_modules/.bin/slayzone-hub" > "$SMOKE/hub.log" 2>&1 &
SPID=$!
sleep 9
if kill -0 $SPID 2>/dev/null && grep -q "listening on http://127.0.0.1:47811" "$SMOKE/hub.log"; then
  echo "   SMOKE PASS — headless hub booted from the published tarball under plain node"
  kill $SPID 2>/dev/null || true
else
  echo "   SMOKE FAIL — hub did not boot from the tarball. Log tail:"
  grep -vE "Migration [0-9]+ applied" "$SMOKE/hub.log" | tail -20
  kill $SPID 2>/dev/null || true
  echo "Aborting before publish." ; exit 1
fi
rm -rf "$SMOKE"

if [ "$DO_PUBLISH" -ne 1 ]; then
  echo "==> DRY RUN complete. Tarballs built + smoke-verified. Re-run with --publish to publish."
  echo "    Copy a tarball to your server and 'npm install ./<tgz>' to deploy without publishing."
  exit 0
fi

# --- PUBLISH (needs npm auth + @slayzone org) ---
# Auth resolves from NODE_AUTH_TOKEN (CI, via setup-node registry-url) or an
# interactive `npm login` (local). `npm whoami` is only a courtesy label and is
# NOT gated on — it can fail under token-only auth even when publish would work.
WHO="$(npm whoami 2>/dev/null || echo 'token-auth')"
echo "==> Publishing to npm (auth: $WHO)"
( cd packages/apps/hub && npm publish --access public )
( cd packages/apps/runner && npm publish --access public )
echo "==> Published @slayzone/hub@$VERSION + @slayzone/runner@$VERSION"
