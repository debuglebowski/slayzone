# chromium/

Chromium fork sources + patches. Source tree is **not** committed — it lives at
`chromium/src/` (gitignored, ~50 GB).

## Pinned version

See `CHROMIUM_VERSION`. Bump by editing that file + re-running sync.

## First-time setup

```sh
# 1. depot_tools (already cloned into tools/depot_tools/ by Phase 1 scaffold)
# 2. fetch + sync source (~50 GB, 30-90 min)
scripts/chromium/fetch.sh

# 3. apply SlayZone patches
scripts/chromium/apply-patches.sh

# 4. build (1-3 hrs on arm64 Mac, unsignedc local only)
scripts/chromium/build.sh

# 5. launch
scripts/chromium/run.sh
```

## Layout

```
chromium/
├── CHROMIUM_VERSION      # pinned tag, single line
├── README.md             # this file
├── src/                  # gitignored — Chromium source (fetch-managed)
└── out/                  # gitignored — build outputs (if placed outside src/)
```

## Patches

`patches/chromium/*.patch` — `git am` format, applied in lexicographic order.
Phase 1 ships `0001-slayzone-hello-page.patch` as the smoke-test.
