/**
 * Tests for scripts/lint-theme.sh (first half of `pnpm lint:theme`): hardcoded color
 * classes in renderer .tsx, and color literals in the mobile app outside its theme
 * module, fail; theme-derived and user-data colors pass; an unreadable tree fails
 * closed (exit 2), never passes.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { afterEach, expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'lint-theme.sh')
const MOBILE = 'packages/apps/mobile/src'
const THEME_MODULE = `const PALETTE = { background: '#282c34', border: 'rgba(255, 255, 255, 0.15)' }\n`
// The strict (no chromatic palette) paths: the guard fails closed when one is missing.
// Read from the guard itself, so a path added there needs no edit here: a file
// entry gets a stub of its own, a folder entry an index.ts inside it.
const STRICT_PATHS = readFileSync(GUARD, 'utf8')
  .match(/^STRICT_PATHS=\(\n([\s\S]*?)^\)/m)[1]
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
const STRICT_FILES = Object.fromEntries(
  STRICT_PATHS.map((p) => [/\.tsx?$/.test(p) ? p : `${p}/index.ts`, 'export {}\n'])
)
const CHAT = STRICT_PATHS.find((p) => p.endsWith('/client/chat'))

const roots = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A workspace with the mobile theme module, the strict paths, plus `files` ({ relPath: source }). */
function tree(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lint-theme-'))
  roots.push(root)
  const all = { [`${MOBILE}/theme.ts`]: THEME_MODULE, ...STRICT_FILES, ...files }
  for (const [rel, source] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), source)
  }
  return root
}

/** Runs the guard over `root`: { status, hits: ['<rel path>:<line>'], out }. */
function run(root) {
  const r = spawnSync('bash', [GUARD, '--root', root], { encoding: 'utf8' })
  const hits = r.stdout
    .split('\n')
    .map((l) => /^(packages\/[^:]+:\d+):/.exec(l)?.[1])
    .filter(Boolean)
  return { status: r.status, hits, out: r.stdout + r.stderr }
}

function flags(files, expected) {
  const r = run(tree(files))
  expect(r.status, r.out).toBe(1)
  expect(r.hits, r.out).toEqual(expected)
}

function passes(files) {
  const r = run(tree(files))
  expect(r.status, r.out).toBe(0)
}

// ── mobile app ──────────────────────────────────────────────────────────────

test('flags hex, rgb()/rgba()/hsl()/oklch() and named colors outside theme.ts', () => {
  flags(
    {
      [`${MOBILE}/Screen.tsx`]: [
        `const a = { color: '#fff' }`,
        `const b = { borderColor: "#282c34aa" }`,
        'const c = { backgroundColor: `#123456` }',
        `const d = { color: 'rgba(0, 0, 0, 0.5)' }`,
        `const e = { color: rgb(1, 2, 3) }`,
        `const f = { color: 'oklch(0.5 0 0)' }`,
        `const g = { color: 'hsl(0 0% 50%)' }`,
        `const h = <Text style={{ color: 'white' }} />`,
        `const i = <TextInput placeholderTextColor="gray" />`,
        `const j = { color: 'white', backgroundColor: 'transparent' }`
      ].join('\n')
    },
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `${MOBILE}/Screen.tsx:${n}`)
  )
})

test('flags literals in nested folders and .ts files too', () => {
  flags({ [`${MOBILE}/screens/list/styles.ts`]: `export const x = '#000000'\n` }, [
    `${MOBILE}/screens/list/styles.ts:1`
  ])
})

test('passes the theme module itself, theme values, user data and transparent', () => {
  passes({
    [`${MOBILE}/Screen.tsx`]: [
      `const theme = useTheme()`,
      `const a = { color: theme.foreground, borderColor: theme.border }`,
      `const b = { backgroundColor: project?.color ?? theme.mutedForeground }`,
      `const c = { backgroundColor: 'transparent' }`,
      `const d = toRgb(value)`,
      `const e = color.rgb(1)`,
      `// the dark background is #282c34 (a comment, not a literal)`,
      `const f = { tintColor: theme.primary }`
    ].join('\n')
  })
})

test('fails closed when the mobile source or its theme module is missing', () => {
  const noTheme = mkdtempSync(join(tmpdir(), 'lint-theme-'))
  roots.push(noTheme)
  mkdirSync(join(noTheme, MOBILE), { recursive: true })
  expect(run(noTheme).status).toBe(2)

  const noMobile = mkdtempSync(join(tmpdir(), 'lint-theme-'))
  roots.push(noMobile)
  mkdirSync(join(noMobile, 'packages'), { recursive: true })
  expect(run(noMobile).status).toBe(2)

  expect(spawnSync('bash', [GUARD, '--root', join(noMobile, 'nope')]).status).toBe(2)
})

// ── renderer ────────────────────────────────────────────────────────────────

test('flags palette and arbitrary-hex classes in .tsx, except the intentional files', () => {
  flags(
    {
      'packages/domains/x/src/client/A.tsx': `<div className="bg-neutral-800 text-foreground" />\n<div className="border-[#1a1a1a]" />\n`,
      'packages/domains/onboarding/src/client/tutorial/scenes/S.tsx': `<div className="bg-zinc-900" />\n`,
      'packages/domains/x/src/client/B.tsx': `<div className="bg-surface-1 text-muted-foreground" />\n`
    },
    ['packages/domains/x/src/client/A.tsx:1', 'packages/domains/x/src/client/A.tsx:2']
  )
})

test('flags gray palette classes with any prefix or variant chain', () => {
  flags(
    {
      'packages/domains/x/src/client/A.tsx': [
        `<div className="from-zinc-500" />`,
        `<div className="dark:hover:text-slate-300/80" />`,
        `<div className="ring-[#abcdef]" />`
      ].join('\n')
    },
    [1, 2, 3].map((n) => `packages/domains/x/src/client/A.tsx:${n}`)
  )
})

test('chromatic palette classes fail only in the strict paths', () => {
  flags(
    {
      [`${CHAT}/Bubble.tsx`]: `<div className="text-amber-300" />\n`,
      'packages/shared/diff-view/src/Diff.ts': `export const c = 'bg-emerald-500/10'\n`,
      'packages/domains/x/src/client/A.tsx': `<div className="text-amber-300" />\n`,
      [`${CHAT}/Ok.tsx`]: `<div className="text-success bg-warning/10" />\n`
    },
    [`${CHAT}/Bubble.tsx:1`, 'packages/shared/diff-view/src/Diff.ts:1']
  )
})

test('fails closed when a strict path is missing', () => {
  const root = tree()
  rmSync(join(root, 'packages/shared/diff-view'), { recursive: true, force: true })
  expect(run(root).status).toBe(2)
})

test('both rules report in one run', () => {
  flags(
    {
      'packages/domains/x/src/client/A.tsx': `<div className="bg-gray-100" />\n`,
      [`${MOBILE}/B.tsx`]: `const a = { color: '#fff' }\n`
    },
    ['packages/domains/x/src/client/A.tsx:1', `${MOBILE}/B.tsx:1`]
  )
})
