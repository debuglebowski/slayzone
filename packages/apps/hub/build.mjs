import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, watch } from 'node:fs'
import { fileURLToPath } from 'node:url'

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

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

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

  // Single self-contained CJS bundle. Native deps (better-sqlite3, node-pty) +
  // ws's optional accelerators stay external and resolve via require() at
  // runtime — CJS so that BOTH the node_modules walk-up (dev: repo root) AND
  // NODE_PATH (packaged: app.asar.unpacked/node_modules, set by the supervisor)
  // work. An ESM bundle would import externals with the ESM resolver, which
  // ignores NODE_PATH entirely — that broke the packaged side-car. `.cjs`
  // extension because package.json is "type": "module".
  await build({
    entryPoints: ['src/bin.ts'],
    outfile: 'dist/bin.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['better-sqlite3', 'bufferutil', 'utf-8-validate', 'node-pty'],
    // Textual substitution consumed by src/build-info.ts. Declared `string |
    // undefined` there so running the un-bundled TS source resolves to sentinels.
    define: {
      __SLAYZONE_SERVER_COMMIT__: JSON.stringify(commit),
      __SLAYZONE_SERVER_BUILT_AT__: JSON.stringify(builtAt)
    }
  })

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
}

// Skip the initial build only when the caller already produced bin.cjs (the dev
// launcher builds once up front, then starts this watcher with --no-initial to
// avoid a redundant rebuild racing electron's first sidecar spawn).
if (!process.argv.includes('--no-initial')) await buildOnce()

// --- Watch mode (plans/sidecar-staleness.md, Phase 3) ------------------------
// `node build.mjs --watch` rebuilds bin.cjs (+ manifest) on any src change so
// the on-disk build stays fresh in dev. The supervisor watches the manifest and
// (opt-in) hot-restarts the sidecar onto it. Own fs.watch + full rebuild rather
// than esbuild's incremental watch, because `define` is fixed per esbuild
// context — a full rebuild is the clean way to get a fresh builtAt each time.
if (process.argv.includes('--watch')) {
  const srcDir = fileURLToPath(new URL('./src/', import.meta.url))
  let timer = null
  let building = false
  let pending = false
  const rebuild = async () => {
    if (building) {
      pending = true
      return
    }
    building = true
    try {
      await buildOnce()
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
  watch(srcDir, { recursive: true }, (_event, filename) => {
    // Only .ts sources feed the bundle; ignore editor temp files. Test files
    // aren't imported by bin.ts, so skip them to avoid needless rebuilds.
    if (filename && (!filename.endsWith('.ts') || filename.endsWith('.test.ts'))) return
    clearTimeout(timer)
    timer = setTimeout(() => void rebuild(), 150)
  })
  process.stdout.write('[build] watching src/ for changes…\n')
}
