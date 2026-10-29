/**
 * Tests for scripts/check-tsconfig-hermetic.mjs (`pnpm lint:tsconfig-hermetic`): every
 * file a package's tsconfig brings into its typecheck must be in the package or in a
 * workspace package it depends on (transitively).
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-tsconfig-hermetic.mjs')

/**
 * Builds a fixture workspace and runs the guard over it.
 * `packages`: name → { deps?: string[], files?: { relPath: content } } (a `tsconfig.json`
 * value that is an object is JSON-encoded). Packages live in `pkgs/<name>`.
 * Returns { status, out }.
 */
function check(packages, { workspace, rootFiles = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tsconfig-hermetic-'))
  try {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), workspace ?? "packages:\n  - 'pkgs/*'\n")
    writeFileSync(join(root, 'tsconfig.base.json'), '{ "compilerOptions": { "strict": true } }')
    for (const [rel, content] of Object.entries(rootFiles)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), content)
    }
    for (const [name, { deps = [], files = {} }] of Object.entries(packages)) {
      const dir = join(root, 'pkgs', name.replace(/[@/]/g, '_'))
      mkdirSync(dir, { recursive: true })
      const dependencies = Object.fromEntries(deps.map((d) => [d, 'workspace:*']))
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dependencies }))
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true })
        writeFileSync(
          join(dir, rel),
          typeof content === 'string' ? content : JSON.stringify(content)
        )
      }
    }
    const r = spawnSync(process.execPath, [GUARD, '--root', root], { encoding: 'utf8' })
    return { status: r.status, out: r.stdout + r.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const tsconfig = (fields) => ({ extends: '../../tsconfig.base.json', ...fields })

test('passes includes in the package, in a dependency and in a transitive dependency', () => {
  const r = check({
    a: {
      deps: ['b'],
      files: {
        'tsconfig.json': tsconfig({
          include: ['src/**/*', '../b/src/ambient.d.ts', '../c/src/ambient.d.ts']
        })
      }
    },
    b: { deps: ['c'], files: { 'tsconfig.json': tsconfig({ include: ['src'] }) } },
    c: { files: { 'tsconfig.json': tsconfig({ include: ['src'] }) } }
  })
  expect(r.out).toContain('every tsconfig entry and relative import in-closure')
  expect(r.status).toBe(0)
})

test('fails an include into a package that is not a dependency, naming file and entry', () => {
  const r = check({
    // `types`-style aggregator: depends on b, and b reaches back into it.
    agg: { deps: ['b'], files: { 'tsconfig.json': tsconfig({ include: ['src'] }) } },
    b: {
      files: { 'tsconfig.json': tsconfig({ include: ['src/**/*', '../agg/src/global.d.ts'] }) }
    }
  })
  expect(r.status).toBe(1)
  expect(r.out).toContain('pkgs/b/tsconfig.json')
  expect(r.out).toContain('include: "../agg/src/global.d.ts"')
  expect(r.out).toContain('outside b and its workspace dependencies')
})

test('fails a glob whose static part escapes the package', () => {
  const r = check({
    a: { files: { 'tsconfig.json': tsconfig({ include: ['../*/src/**/*'] }) } },
    b: {}
  })
  expect(r.status).toBe(1)
  expect(r.out).toContain('include: "../*/src/**/*"')
})

test('checks files, references, paths targets, typeRoots and relative extends', () => {
  const r = check({
    a: {
      files: {
        'tsconfig.json': tsconfig({
          files: ['../b/x.ts'],
          references: [{ path: '../b' }],
          compilerOptions: {
            paths: { '@b/*': ['../b/src/*'], '@self/*': ['./src/*'] },
            typeRoots: ['../b/types']
          }
        }),
        'tsconfig.node.json': { extends: '../b/tsconfig.json' }
      }
    },
    b: {}
  })
  expect(r.status).toBe(1)
  expect(r.out).toContain('files: "../b/x.ts"')
  expect(r.out).toContain('references: "../b"')
  expect(r.out).toContain('compilerOptions.paths[@b/*]: "../b/src/*"')
  expect(r.out).not.toContain('@self/*')
  expect(r.out).toContain('compilerOptions.typeRoots: "../b/types"')
  expect(r.out).toContain('pkgs/a/tsconfig.node.json  extends: "../b/tsconfig.json"')
})

test('a paths target resolves against baseUrl', () => {
  const r = check({
    a: {
      files: {
        'tsconfig.json': tsconfig({
          compilerOptions: { baseUrl: '..', paths: { '@b/*': ['b/src/*'] } }
        })
      }
    },
    b: {}
  })
  expect(r.status).toBe(1)
  expect(r.out).toContain('compilerOptions.paths[@b/*]: "b/src/*"')
})

test('a bare extends or types entry must name a dependency when it names a workspace package', () => {
  const ok = check({
    a: {
      deps: ['@x/tsconfig'],
      files: {
        'tsconfig.json': {
          extends: '@x/tsconfig/base.json',
          compilerOptions: { types: ['node', 'vite/client', '@x/tsconfig/global'] }
        }
      }
    },
    '@x/tsconfig': {}
  })
  expect(ok.status).toBe(0)

  const bad = check({
    a: {
      files: {
        'tsconfig.json': {
          extends: '@x/tsconfig/base.json',
          compilerOptions: { types: ['@x/tsconfig'] }
        }
      }
    },
    '@x/tsconfig': {}
  })
  expect(bad.status).toBe(1)
  expect(bad.out).toContain(
    'extends: "@x/tsconfig/base.json" — @x/tsconfig is not a dependency of a'
  )
  expect(bad.out).toContain('compilerOptions.types: "@x/tsconfig"')
})

test('the repo-root tsconfig.base.json and the convex/ directory are allowed', () => {
  const r = check(
    {
      a: {
        files: {
          'tsconfig.json': tsconfig({
            compilerOptions: { paths: { 'convex/_generated/*': ['../../convex/_generated/*'] } }
          })
        }
      }
    },
    { rootFiles: { 'convex/_generated/api.d.ts': 'export {}' } }
  )
  expect(r.status).toBe(0)
})

test('reads JSONC (comments, trailing commas, `//` inside strings) and every tsconfig*.json', () => {
  const r = check({
    a: {
      files: {
        'tsconfig.json': `{
          // a comment
          "extends": "../../tsconfig.base.json", /* another */
          "compilerOptions": {
            "paths": { "//resources/x.js": ["./src/x.ts"], },
          },
          "include": ["src",],
        }`,
        'e2e/tsconfig.e2e.json': { include: ['../../b/src'] },
        'node_modules/dep/tsconfig.json': tsconfig({ include: ['../../../b/src'] })
      }
    },
    b: {}
  })
  expect(r.status).toBe(1)
  expect(r.out).toContain('pkgs/a/e2e/tsconfig.e2e.json  include: "../../b/src"')
  // node_modules is not the package's own config.
  expect(r.out).not.toContain('node_modules')
  expect(r.out).toContain('1 typecheck input reaches outside')
})

test('fails (exit 2) on a tsconfig that is not JSON(C), and on an unreadable workspace', () => {
  const broken = check({ a: { files: { 'tsconfig.json': '{ "include": [' } } })
  expect(broken.status).toBe(2)
  expect(broken.out).toContain('pkgs/a/tsconfig.json is not valid JSON(C)')

  const noList = check({ a: {} }, { workspace: 'catalog: {}\n' })
  expect(noList.status).toBe(2)
  expect(noList.out).toContain('cannot verify, failing')
})

test('fails a relative import in a typechecked source that leaves the closure', () => {
  const r = check({
    a: {
      deps: ['b'],
      files: {
        'tsconfig.json': tsconfig({ include: ['src'] }),
        'src/ok.ts': "import { x } from './local'\nimport { y } from '../../b/src/y'\nexport {}\n",
        'src/static.test.ts': "import { harness } from '../../c/harness.js'\n",
        'src/multi.ts':
          "import {\n  one,\n  two\n} from '../../c/src/index'\nexport * from '../../c/src/more'\n",
        'src/dynamic.ts':
          "let mod: typeof import('../../c/src/handlers')\n" +
          "mod = await import('../../c/src/handlers')\n" +
          "const r = require('../../c/src/req')\n",
        'src/ambient.tsx': '/// <reference path="../../c/src/ambient.d.ts" />\nexport {}\n',
        'src/side-effect.mts': "import '../../c/src/polyfill'\n",
        // Outside `include`, so not an input of this package's typecheck.
        'test/outside.test.ts': "import { z } from '../../c/src/z'\n"
      }
    },
    b: {},
    c: {}
  })
  expect(r.status).toBe(1)
  expect(r.out).toContain('pkgs/a/src/static.test.ts  import: "../../c/harness.js"')
  expect(r.out).toContain('pkgs/a/src/multi.ts  import: "../../c/src/index"')
  expect(r.out).toContain('pkgs/a/src/multi.ts  import: "../../c/src/more"')
  expect(r.out).toContain('pkgs/a/src/dynamic.ts  import: "../../c/src/handlers"')
  expect(r.out).toContain('pkgs/a/src/dynamic.ts  import: "../../c/src/req"')
  expect(r.out).toContain('pkgs/a/src/ambient.tsx  import: "../../c/src/ambient.d.ts"')
  expect(r.out).toContain('pkgs/a/src/side-effect.mts  import: "../../c/src/polyfill"')
  expect(r.out).not.toContain('ok.ts')
  expect(r.out).not.toContain('outside.test.ts')
  expect(r.out).toContain('7 typecheck inputs reach outside')
})

test('a package without a tsconfig has no typechecked sources to scan', () => {
  const r = check({ a: { files: { 'helper.ts': "import { x } from '../b/src/x'\n" } }, b: {} })
  expect(r.out).toContain('in-closure')
  expect(r.status).toBe(0)
})
