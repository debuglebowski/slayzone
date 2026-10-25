import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runtimeImportsEsbuildPlugin } from '@slayzone/build-guards/runtime-imports'
import { watchBundleInputs } from '@slayzone/build-guards/watch-inputs'

// --- Build identity (plans/sidecar-staleness.md, Phase 1) --------------------
// Stamp the sidecar with the commit + build time so the running process can
// report exactly which code it executes (via /health + the `sidecar.boot`
// diagnostic event), and the supervisor can compare running-vs-disk to detect a
// stale sidecar. Git may be absent (some packaging paths) → fall back to
// sentinels rather than fail the build.
function gitCommit() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const { version } = pkg

/**
 * esbuild options for one build. `commit`/`builtAt` are compiled in via
 * `define`, so they are fixed per call — every build gets a fresh pair.
 * `metafile` feeds the dev watcher (exact list of bundled inputs).
 */
function buildOptions(commit, builtAt) {
  return {
    // Single self-contained CJS bundle. Native deps (better-sqlite3, node-pty) +
    // ws's optional accelerators stay external and resolve via require() at
    // runtime — CJS so that BOTH the node_modules walk-up (dev: repo root) AND
    // NODE_PATH (packaged: app.asar.unpacked/node_modules, set by the supervisor)
    // work. An ESM bundle would import externals with the ESM resolver, which
    // ignores NODE_PATH entirely — that broke the packaged side-car. `.cjs`
    // extension because package.json is "type": "module".
    entryPoints: ['src/bin.ts'],
    outfile: 'dist/bin.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['better-sqlite3', 'bufferutil', 'utf-8-validate', 'node-pty'],
    // Fails the build if an external would not resolve where the hub runs (packaged
    // app.asar.unpacked, or `npm i @slayzone/hub`). See build-guards.
    plugins: [runtimeImportsEsbuildPlugin({ bundleName: 'hub', packageJson: pkg })],
    // Shebang: this bundle is ALSO the `slayzone-hub` bin of the published
    // @slayzone/hub package, so npm/npx exec it directly (no `node` prefix).
    // Without it the kernel has no interpreter and /bin/sh runs the JS as a
    // shell script → `use strict: not found`. In-app spawns pass an explicit
    // node/electron argv[0] and are unaffected, which is why the omission only
    // broke `npx @slayzone/hub`.
    banner: { js: '#!/usr/bin/env node' },
    // Textual substitution consumed by src/build-info.ts. Declared `string |
    // undefined` there so running the un-bundled TS source resolves to sentinels.
    define: {
      __SLAYZONE_SERVER_COMMIT__: JSON.stringify(commit),
      __SLAYZONE_SERVER_BUILT_AT__: JSON.stringify(builtAt)
    },
    metafile: true
  }
}

/**
 * One full build. Each invocation recomputes commit + builtAt so the value
 * compiled into the bundle (esbuild `define`) and the value written to the
 * manifest ALWAYS match for that build — critical for watch mode: a rebuilt bin
 * must report the same buildId the manifest advertises, or the supervisor would
 * see it as permanently stale and hot-restart in a loop.
 */
async function buildOnce() {
  const commit = gitCommit()
  const builtAt = new Date().toISOString()
  const buildId = `${commit}@${builtAt}`
  const result = await build(buildOptions(commit, builtAt))

  // On-disk manifest = the source of truth the supervisor reads to compare
  // against the running sidecar. Includes the bundle's sha256 (content identity,
  // catches dirty/uncommitted rebuilds) which cannot be compiled into the bundle.
  const bundleSha256 = createHash('sha256')
    .update(readFileSync(new URL('./dist/bin.cjs', import.meta.url)))
    .digest('hex')
  writeFileSync(
    new URL('./dist/sidecar-build.json', import.meta.url),
    JSON.stringify({ buildId, commit, builtAt, version, bundleSha256 }, null, 2) + '\n'
  )
  process.stdout.write(`[build] sidecar ${buildId} (sha256 ${bundleSha256.slice(0, 12)}…)\n`)
  return result.metafile
}

// Skip the initial build only when the caller already produced bin.cjs (the dev
// launcher builds once up front, then starts this watcher with --no-initial to
// avoid a redundant rebuild racing electron's first sidecar spawn).
const initialMetafile = process.argv.includes('--no-initial') ? null : await buildOnce()

// --- Watch mode (plans/sidecar-staleness.md, Phase 3) ------------------------
// `node build.mjs --watch` rebuilds bin.cjs (+ manifest) on any bundle-input change so
// the on-disk build stays fresh in dev. The supervisor watches the manifest and
// (opt-in) hot-restarts the sidecar onto it. Own fs.watch + full rebuild rather
// than esbuild's incremental watch, because `define` is fixed per esbuild
// context — a full rebuild is the clean way to get a fresh builtAt each time.
if (process.argv.includes('--watch')) {
  let building = false
  let pending = false
  const watcher = watchBundleInputs({
    onChange: () => void rebuild(),
    fallbackDir: fileURLToPath(new URL('./src/', import.meta.url))
  })
  async function rebuild() {
    if (building) {
      pending = true
      return
    }
    building = true
    try {
      watcher.update(await buildOnce())
    } catch (err) {
      process.stderr.write(`[build] rebuild failed: ${err instanceof Error ? err.message : err}\n`)
    } finally {
      building = false
      if (pending) {
        pending = false
        void rebuild()
      }
    }
  }
  // Watch every bundled input — hub/src AND the workspace server code it
  // inlines (packages/domains/*/src/server, shared/*, …), not just hub/src.
  // With --no-initial the caller just built bin.cjs, so learn the input list
  // from a write:false analysis build instead of rewriting the bundle.
  // If even that fails (src is mid-edit), watch src/ until a build succeeds.
  watcher.update(
    initialMetafile ??
      (await build({
        ...buildOptions('unknown', new Date(0).toISOString()),
        write: false,
        logLevel: 'silent'
      }).then(
        (r) => r.metafile,
        () => null
      ))
  )
  process.stdout.write('[build] watching bundle inputs for changes…\n')
}
