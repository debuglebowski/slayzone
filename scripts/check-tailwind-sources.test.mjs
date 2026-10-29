/**
 * Tests for scripts/check-tailwind-sources.mjs (part of `pnpm lint:theme`): every
 * class-bearing module a theme-css shell renders must sit under an `@source` path, or
 * its classes are never generated (MediaView's `bg-popover/90` shipped see-through).
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-tailwind-sources.mjs')
const THEME = '@slayzone/theme-css'
const COMPONENT = 'export const X = () => <div className="bg-popover/90" />\n'

/**
 * Builds a fixture workspace under `pkgs/<dir>` and runs the guard over it.
 * `packages`: dir → { name?, deps?, devDeps?, files: { relPath: content } }.
 * `sources`: the theme's `@source` lines, relative to pkgs/theme-css/src/index.css.
 */
function check(packages, sources) {
  const root = mkdtempSync(join(tmpdir(), 'tw-sources-'))
  try {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'pkgs/*'\n")
    const all = {
      'theme-css': {
        name: THEME,
        files: {
          'src/index.css': [
            '@import "tailwindcss";',
            '/* @source "../../commented-out/src"; */',
            ...sources.map((s) => `@source "${s}";`)
          ].join('\n')
        }
      },
      ...packages
    }
    for (const [dir, pkg] of Object.entries(all)) {
      const pkgDir = join(root, 'pkgs', dir)
      mkdirSync(pkgDir, { recursive: true })
      const ws = (names) => Object.fromEntries((names ?? []).map((n) => [n, 'workspace:*']))
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: pkg.name ?? dir,
          dependencies: ws(pkg.deps),
          devDependencies: ws(pkg.devDeps)
        })
      )
      for (const [rel, content] of Object.entries(pkg.files ?? {})) {
        mkdirSync(dirname(join(pkgDir, rel)), { recursive: true })
        writeFileSync(join(pkgDir, rel), content)
      }
    }
    const r = spawnSync(process.execPath, [GUARD, '--root', root], { encoding: 'utf8' })
    return { status: r.status, out: r.stdout + r.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const shell = (extra = {}) => ({
  deps: [THEME, 'ui'],
  files: { 'src/main.css': `@import "${THEME}";\n`, 'src/App.tsx': COMPONENT },
  ...extra
})

test('passes when every class-bearing file the shell renders is under an @source', () => {
  const r = check({ shell: shell(), ui: { files: { 'src/Button.tsx': COMPONENT } } }, [
    '../../ui/src'
  ])
  expect(r.status).toBe(0)
  expect(r.out).toContain('all scanned')
})

test('fails a file outside every @source, naming it and the shell — the MediaView case', () => {
  const r = check(
    {
      shell: shell(),
      ui: {
        files: { 'src/client/GhMarkdown.tsx': COMPONENT, 'src/client/MediaView.tsx': COMPONENT }
      }
    },
    ['../../ui/src/client/GhMarkdown.tsx']
  )
  expect(r.status).toBe(1)
  expect(r.out).toContain('pkgs/ui/src/client/MediaView.tsx  (rendered by shell)')
  expect(r.out).not.toContain('GhMarkdown.tsx  (')
})

test('follows the dependency closure: a package reached only transitively must be scanned', () => {
  const r = check(
    {
      shell: shell(),
      ui: { deps: ['deep'], files: { 'src/Button.tsx': COMPONENT } },
      deep: { files: { 'src/Deep.tsx': COMPONENT } }
    },
    ['../../ui/src']
  )
  expect(r.status).toBe(1)
  expect(r.out).toContain('pkgs/deep/src/Deep.tsx')
})

test("counts the shell's devDependencies (it bundles them) but not a reached package's", () => {
  const r = check(
    {
      shell: shell({ deps: [THEME], devDeps: ['ui'] }),
      ui: { devDeps: ['fixtures'], files: { 'src/Button.tsx': COMPONENT } },
      fixtures: { files: { 'src/Fixture.tsx': COMPONENT } }
    },
    ['../../shell/src']
  )
  expect(r.status).toBe(1)
  expect(r.out).toContain('pkgs/ui/src/Button.tsx')
  expect(r.out).not.toContain('Fixture.tsx')
})

test('ignores tests, process-side dirs, class-free modules and packages no shell renders', () => {
  const r = check(
    {
      shell: shell(),
      ui: {
        files: {
          'src/Button.tsx': COMPONENT,
          'src/Button.test.tsx': COMPONENT,
          'src/server/page.ts': 'export const html = `<p class="x">hi</p>`\n',
          'src/electron/menu.tsx': COMPONENT,
          'src/provider.tsx': 'export const P = ({ children }) => children\n'
        }
      },
      orphan: { files: { 'src/Unused.tsx': COMPONENT } }
    },
    ['../../ui/src/Button.tsx']
  )
  expect(r.status).toBe(0)
})

test("checks .ts modules that carry class strings, and the shell's own @source lines count", () => {
  const files = { 'src/styles.ts': "export const row = { className: 'bg-card/50' }\n" }
  expect(check({ shell: shell(), ui: { files } }, ['../../shell/src']).status).toBe(1)
  const r = check(
    {
      shell: shell({
        files: { 'src/main.css': `@import "${THEME}";\n@source "../../ui/src";\n` }
      }),
      ui: { files }
    },
    ['../../shell/src']
  )
  expect(r.status).toBe(0)
})

test('fails an @source path that does not exist', () => {
  const r = check({ shell: shell(), ui: { files: { 'src/Button.tsx': COMPONENT } } }, [
    '../../ui/src',
    '../../gone/src'
  ])
  expect(r.status).toBe(1)
  expect(r.out).toContain('pkgs/gone/src')
})

test('cannot verify (exit 2) when no CSS file imports the theme', () => {
  const r = check({ shell: shell({ files: { 'src/main.css': '@import "tailwindcss";\n' } }) }, [
    '../../shell/src'
  ])
  expect(r.status).toBe(2)
})
