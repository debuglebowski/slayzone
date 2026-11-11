# TODAY's code (the working tree run.sh streams in as the build context), installed
# and built for Linux + plain Node — no Electron. Native modules (better-sqlite3,
# node-pty) are built for this Node's ABI because the Electron rebuild in
# scripts/postinstall.js is skipped (CI_SKIP_POSTINSTALL).
#
# The persona user is uid 1000 with home /home/persona, exactly as in the generate
# image, so every absolute path an old release wrote into a persona stays valid.
FROM node:24.21.0-bookworm-slim
LABEL slz.migration-harness=1
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git python3 make g++ ca-certificates procps sqlite3 curl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
RUN usermod -l persona -d /home/persona -m node && groupmod -n persona node
WORKDIR /repo
# The build gets its OWN home (pnpm store, corepack, node-gyp caches): /home/persona must
# hold nothing but the persona, since the harness dumps all of it. run.sh runs the
# harness with HOME=/home/persona.
RUN mkdir /build && chown persona:persona /repo /build
USER persona
ENV HOME=/build CI_SKIP_POSTINSTALL=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Dependency layer: only the lockfile → cached until dependencies change.
COPY --chown=persona:persona package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=persona:persona patches ./patches
COPY --chown=persona:persona vendor ./vendor
RUN pnpm fetch

COPY --chown=persona:persona . .
RUN pnpm install --offline --frozen-lockfile \
      --filter . --filter "@slayzone/app..." --filter "@slayzone/hub..." --filter "@slayzone/computer..."
RUN pnpm --filter @slayzone/hub build && pnpm --filter @slayzone/computer build
RUN node tools/migration-personas/harness/build.mjs

# An in-place .deb upgrade: the new release's bundles sit where the old one installed
# them. v0.38+ standalone computers record `/opt/SlayZone/resources/computer/bin.cjs` as
# the release their launcher forks (computer-runtime/supervisor.json, host-release.json),
# so today's code must answer at that path, as it would after `apt upgrade`.
USER root
RUN mkdir -p /opt/SlayZone/resources/computer /opt/SlayZone/resources/hub \
    && ln -s /repo/packages/apps/computer/dist/bin.cjs /opt/SlayZone/resources/computer/bin.cjs \
    && ln -s /repo/packages/apps/hub/dist/bin.cjs /opt/SlayZone/resources/hub/bin.cjs
USER persona

# The scripted agents (same as the generator): after the upgrade the harness continues
# every chat, which spawns `claude` / `codex` on the computers — they must resume each
# chat's own pre-upgrade session (checked from the fakes' spawn logs).
USER root
RUN mkdir -p /opt/fake \
    && ln -s /repo/packages/shared/test-utils/fake-claude /opt/fake/fake-claude \
    && ln -s /repo/packages/shared/test-utils/fake-cli /opt/fake/fake-cli \
    && ln -s /repo/packages/shared/test-utils/fake-codex /opt/fake/fake-codex \
    && install -m 755 /repo/tools/migration-personas/generate/fake-claude/claude /usr/local/bin/claude \
    && cp /repo/tools/migration-personas/generate/fake-claude/interactive.mjs /opt/fake/interactive.mjs \
    && install -m 755 /repo/tools/migration-personas/generate/fake-codex/codex /usr/local/bin/codex \
    && mkdir -p /opt/fake/state/epochs/1 /opt/fake/codex-state/epochs/1 \
    && echo 1 > /opt/fake/state/current && echo 1 > /opt/fake/codex-state/current \
    && cp /repo/tools/migration-personas/generate/fake-claude/scenario.json /opt/fake/state/epochs/1/scenario.json \
    && cp /repo/tools/migration-personas/generate/fake-codex/scenario.json /opt/fake/codex-state/epochs/1/scenario.json \
    && chown -R persona:persona /opt/fake/state /opt/fake/codex-state
ENV SHELL=/bin/bash
USER persona
