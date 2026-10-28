/**
 * The resolution part of the fs module cache key (fs-module-cache.ts).
 *
 * Vitest keys a cached transform by the module's own content, but the cached code holds
 * its imports already RESOLVED (`@slayzone/ui` → `/packages/shared/ui/src/index.ts`). A
 * change that moves where an unchanged import resolves must therefore change the key,
 * or a warm cache serves a path that no longer exists (or silently the old module). A
 * change that cannot move it must not, or the cache is cold on every commit.
 */
import { describe, expect, test } from 'vitest'
import { createResolutionKey, type WorkspaceLayout } from './fs-module-cache'

const ROOT = '/repo'

function layout(files: string[], pkgs: Record<string, Record<string, unknown>>): WorkspaceLayout {
  return {
    files: [
      ...files,
      ...Object.keys(pkgs).map((dir) => (dir ? `${dir}/package.json` : 'package.json'))
    ],
    readPackageJson: (dir) => pkgs[dir] ?? null
  }
}

const PKGS: Record<string, Record<string, unknown>> = {
  '': { name: 'root', private: true },
  'packages/ui': { name: '@x/ui', type: 'module', exports: { '.': './src/index.ts' } },
  'packages/task': { name: '@x/task', exports: { '.': './src/index.ts' } },
  'packages/test-utils': { name: '@x/test-utils', exports: { '.': './harness.ts' } },
  'packages/gen': {
    name: '@x/gen',
    exports: { '.': './src/index.ts', './generated/*': './src/generated/*' }
  },
  'packages/app': { name: '@x/app' }
}
const FILES = [
  'packages/ui/src/index.ts',
  'packages/ui/src/button.tsx',
  'packages/task/src/index.ts',
  'packages/task/src/card.tsx',
  'packages/task/src/card.test.tsx',
  'packages/test-utils/harness.ts',
  'packages/gen/src/index.ts',
  'packages/gen/src/generated/a.ts',
  'packages/app/src/renderer/src/lib/x.ts',
  'scripts/tool.mjs'
]

const ALIASES = [{ find: '@', replacement: `${ROOT}/packages/app/src/renderer/src` }]

function keyOf(
  id: string,
  source: string,
  opts: { files?: string[]; pkgs?: Record<string, Record<string, unknown>> } = {}
): string | false {
  const key = createResolutionKey(ROOT, layout(opts.files ?? FILES, opts.pkgs ?? PKGS), ALIASES)
  return key(`${ROOT}/${id}`, source)
}

const CARD = 'packages/task/src/card.tsx'

describe('createResolutionKey', () => {
  test('is stable for an unchanged workspace', () => {
    const src = "import { Button } from '@x/ui'\nimport { a } from './index'\n"
    expect(keyOf(CARD, src)).toBe(keyOf(CARD, src))
    expect(typeof keyOf(CARD, src)).toBe('string')
  })

  test('a file added, removed or renamed in its own package changes it', () => {
    const src = "import { a } from './index'\n"
    const base = keyOf(CARD, src)
    expect(keyOf(CARD, src, { files: [...FILES, 'packages/task/src/index/x.ts'] })).not.toBe(base)
    expect(
      keyOf(CARD, src, { files: FILES.filter((f) => f !== 'packages/task/src/index.ts') })
    ).not.toBe(base)
  })

  test('a file added in a package it does not reach leaves it alone', () => {
    const src = "import { a } from './index'\nimport { Button } from '@x/ui'\n"
    expect(keyOf(CARD, src, { files: [...FILES, 'packages/ui/src/new.tsx'] })).toBe(
      keyOf(CARD, src)
    )
    expect(keyOf(CARD, src, { files: [...FILES, 'scripts/other.mjs'] })).toBe(keyOf(CARD, src))
  })

  test('a relative import into another package keys on that package’s files', () => {
    const test = 'packages/task/src/card.test.tsx'
    const src = "import { harness } from '../../test-utils/harness'\n"
    const base = keyOf(test, src)
    expect(
      keyOf(test, src, { files: [...FILES, 'packages/test-utils/harness/index.ts'] })
    ).not.toBe(base)
  })

  test('an alias import keys on the package the alias points into', () => {
    const src = "import { x } from '@/lib/x'\n"
    const base = keyOf(CARD, src)
    expect(
      keyOf(CARD, src, { files: [...FILES, 'packages/app/src/renderer/src/lib/x/index.ts'] })
    ).not.toBe(base)
    // A scoped bare specifier is not the `@` alias.
    const bare = "import { Button } from '@x/ui'\n"
    expect(keyOf(CARD, bare, { files: [...FILES, 'packages/app/src/renderer/src/lib/y.ts'] })).toBe(
      keyOf(CARD, bare)
    )
  })

  test('a workspace package import keys on its resolution fields, not the rest of its package.json', () => {
    const src = "import { Button } from '@x/ui'\n"
    const base = keyOf(CARD, src)
    const withExports = {
      ...PKGS,
      'packages/ui': { ...PKGS['packages/ui'], exports: { '.': './src/main.ts' } }
    }
    expect(keyOf(CARD, src, { pkgs: withExports })).not.toBe(base)
    const withScripts = {
      ...PKGS,
      'packages/ui': { ...PKGS['packages/ui'], scripts: { test: 'vitest' } }
    }
    expect(keyOf(CARD, src, { pkgs: withScripts })).toBe(base)
  })

  test('a wildcard-exports package also keys on its files', () => {
    const src = "import { a } from '@x/gen/generated/a'\n"
    const base = keyOf(CARD, src)
    expect(
      keyOf(CARD, src, { files: [...FILES, 'packages/gen/src/generated/a/index.ts'] })
    ).not.toBe(base)
  })

  test('its own package.json resolution fields are part of it (type, imports)', () => {
    const src = "import { a } from './index'\n"
    const base = keyOf(CARD, src)
    const typed = { ...PKGS, 'packages/task': { ...PKGS['packages/task'], type: 'module' } }
    expect(keyOf(CARD, src, { pkgs: typed })).not.toBe(base)
  })

  test('every import form is seen: export-from, dynamic, require, vi.mock, new URL', () => {
    const test = 'packages/task/src/card.test.tsx'
    const more = { files: [...FILES, 'packages/test-utils/extra.ts'] }
    for (const src of [
      "export { harness } from '../../test-utils/harness'\n",
      "const m = await import('../../test-utils/harness')\n",
      "const m = require('../../test-utils/harness')\n",
      "vi.mock('../../test-utils/harness', () => ({}))\n",
      "const u = new URL('../../test-utils/harness.ts', import.meta.url)\n"
    ]) {
      expect(keyOf(test, src, more), src).not.toBe(keyOf(test, src))
    }
  })

  test('an alias into node_modules adds nothing (the lockfile covers it)', () => {
    const aliases = [
      ...ALIASES,
      { find: /^vitest$/, replacement: `${ROOT}/node_modules/vitest/index.js` }
    ]
    const key = createResolutionKey(ROOT, layout(FILES, PKGS), aliases)
    const src = "import { a } from './index'\n"
    expect(key(`${ROOT}/${CARD}`, `${src}import { test } from 'vitest'\n`)).toBe(
      key(`${ROOT}/${CARD}`, src)
    )
  })

  test('a template-literal dynamic import is never cached', () => {
    expect(keyOf(CARD, 'const m = await import(`./locales/${lang}.ts`)\n')).toBe(false)
  })

  test('a module outside the workspace sources adds nothing', () => {
    const key = createResolutionKey(ROOT, layout(FILES, PKGS), ALIASES)
    expect(key(`${ROOT}/node_modules/react/index.js`, "require('./cjs/react.production.js')")).toBe(
      ''
    )
    expect(key('\0virtual:thing', '')).toBe('')
    expect(key('/elsewhere/file.ts', "import './a'")).toBe('')
  })

  test('a query on the id is ignored', () => {
    const src = "import { a } from './index'\n"
    const key = createResolutionKey(ROOT, layout(FILES, PKGS), ALIASES)
    expect(key(`${ROOT}/${CARD}?v=123`, src)).toBe(key(`${ROOT}/${CARD}`, src))
  })
})
