# TODAY's code (the working tree run.sh streams in as the build context), installed
# and built for Linux + plain Node — no Electron. Native modules (better-sqlite3,
# node-pty) are built for this Node's ABI because the Electron rebuild in
# scripts/postinstall.js is skipped (CI_SKIP_POSTINSTALL).
#
# The persona user is uid 1000 with home /home/persona, exactly as in the generate
# image, so every absolute path an old release wrote into a persona stays valid.
FROM node:24-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git python3 make g++ ca-certificates procps sqlite3 && rm -rf /var/lib/apt/lists/*
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
