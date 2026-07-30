/**
 * Downgrade guard — asserts the installed `@xterm/addon-webgl` build carries the
 * shared-texture-atlas fix (xterm.js #6042 + #6055).
 *
 * Why this exists: `CharAtlasCache` is a MODULE-LEVEL cache, so every terminal
 * with matching font/size/DPR/theme shares ONE `TextureAtlas`. Our atlas
 * correction (`correctAtlas` → `clearTextureAtlas()`) wipes and repacks that
 * shared atlas, but rebuilds vertex data only for the CALLING renderer. In
 * builds before the fix, `TextureAtlas.clearTexture()` sets no invalidation flag
 * at all, so sibling renderers are never told: they keep painting stale
 * texcoords against freshly-repacked tiles and the screen renders garbage glyphs
 * over a correct layout until the user resizes.
 *
 * The fix replaces the consume-once `TextureAtlas.beginFrame()` one-shot with a
 * monotonic `_pageLayoutVersion` (bumped inside `clearTexture()`) that each
 * `GlyphRenderer` compares against its own `_lastSeenPageLayoutVersion` — so
 * every sibling self-repairs on its next frame instead of exactly one of them.
 *
 * The pin is exact (no `^`) and lives in this package's package.json. A future
 * re-pin, a lockfile resolution change, or a registry unpublish could silently
 * put us back on an unfixed build and the scramble would return with no failing
 * test anywhere. This asserts against the SHIPPED BUNDLE rather than the
 * package.json version string, so it holds regardless of how the version is
 * spelled or which beta the fix first landed in.
 *
 * Run with: pnpm exec tsx packages/domains/terminal/src/client/xterm-atlas-fix.test.ts
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

/**
 * Read a file out of the installed `@xterm/addon-webgl` package. Resolved via
 * `createRequire` against this test file so it follows the same node_modules
 * resolution the bundler uses — not a hardcoded repo-root path that would break
 * under a different install layout (pnpm store, hoisting change, CI).
 */
function readAddonFile(relPath: string): string {
  const require = createRequire(import.meta.url)
  const pkgJsonPath = require.resolve('@xterm/addon-webgl/package.json')
  const pkgDir = pkgJsonPath.slice(0, pkgJsonPath.lastIndexOf('/'))
  return readFileSync(`${pkgDir}/${relPath}`, 'utf8')
}

function run(): void {
  console.log('\n=== xterm shared-atlas fix (downgrade guard) ===\n')

  test('shipped ESM bundle contains the pageLayoutVersion fix', () => {
    const bundle = readAddonFile('lib/addon-webgl.mjs')
    ok(
      bundle.includes('pageLayoutVersion'),
      'installed @xterm/addon-webgl/lib/addon-webgl.mjs has no `pageLayoutVersion` — ' +
        'this build predates the shared-atlas fix (xterm.js #6042/#6055). Clearing the ' +
        'texture atlas on one terminal will scramble every terminal sharing that atlas. ' +
        'Re-pin @xterm/* forward; see plans/terminal-scramble-and-byte-filters.md.'
    )
  })

  test('shipped CJS bundle contains the fix too', () => {
    // Vite may resolve either entry depending on the consumer; both must carry it.
    const bundle = readAddonFile('lib/addon-webgl.js')
    ok(
      bundle.includes('pageLayoutVersion'),
      'installed @xterm/addon-webgl/lib/addon-webgl.js (CJS entry) has no `pageLayoutVersion`'
    )
  })

  test('TextureAtlas source bumps the version inside clearTexture()', () => {
    // The bug is specifically that `clearTexture()` — the method `correctAtlas`
    // reaches via `WebglAddon.clearTextureAtlas()` — signalled nothing. Assert
    // the bump is in THAT method, not merely present somewhere in the file
    // (pre-fix builds already invalidated on page-merge and overflow-page paths,
    // neither of which is our path).
    const src = readAddonFile('src/TextureAtlas.ts')
    const start = src.indexOf('public clearTexture()')
    ok(start !== -1, 'could not locate `public clearTexture()` in TextureAtlas.ts')
    const body = src.slice(start, src.indexOf('\n  }', start))
    ok(
      body.includes('_pageLayoutVersion++'),
      'clearTexture() does not bump `_pageLayoutVersion` — sibling renderers sharing ' +
        'this atlas receive no invalidation signal and will paint stale texcoords'
    )
  })

  test('GlyphRenderer tracks the version per renderer', () => {
    // Per-renderer tracking is what makes EVERY sibling repair. A consume-once
    // atlas-level flag (the pre-fix shape, and what the community patch #6018
    // proposed) repairs exactly one sibling and stays broken for N > 2 panes.
    const src = readAddonFile('src/GlyphRenderer.ts')
    ok(
      src.includes('_lastSeenPageLayoutVersion'),
      'GlyphRenderer has no `_lastSeenPageLayoutVersion` — invalidation is not tracked ' +
        'per renderer, so only one of N sharing terminals would recover'
    )
  })

  console.log('─'.repeat(40))
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
