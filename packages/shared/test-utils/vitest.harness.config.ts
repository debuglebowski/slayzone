import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'

// Node-environment suites (`pnpm test:unit`, the "harness" group in run-all.sh).
// Run under Electron's node (ELECTRON_RUN_AS_NODE=1): better-sqlite3 is rebuilt for
// Electron's ABI by the root postinstall, so plain `node` ERR_DLOPENs it.
//
// The mocks below replace the old `--experimental-loader ./loader.ts` redirects, one
// for one: `electron`, `@dagrejs/dagre`, any relative `linear-client`, `./merge-ai`.

const here = import.meta.dirname
const rootDir = resolve(here, '../../..')
const local = (file: string): string => resolve(here, file)

// A relative specifier (any `./` or `../` depth) for a given module basename, with or
// without an extension: the integration linear-client is imported as `./linear-client`
// AND `../linear-client`, both must redirect to the same mock.
const matchesRelative =
  (basename: string) =>
  (s: string): boolean =>
    /^\.\.?\//.test(s) && new RegExp(`(^|/)${basename}(\\.ts|\\.js)?$`).test(s)

const redirects: Array<{ match: (s: string) => boolean; file: string }> = [
  { match: (s) => s === 'electron', file: local('mock-electron.ts') },
  { match: (s) => s === '@dagrejs/dagre', file: local('mock-dagre.ts') },
  { match: matchesRelative('linear-client'), file: local('mock-linear-client.ts') },
  {
    match: (s) => s === './merge-ai' || s === './merge-ai.ts' || s === './merge-ai.js',
    file: local('mock-merge-ai.ts')
  }
]

function harnessMocks(): Plugin {
  return {
    name: 'slayzone-harness-mocks',
    enforce: 'pre',
    resolveId(source, importer) {
      // The mocks themselves may import the real thing (none do today); never loop.
      if (importer && importer.startsWith(here) && /mock-/.test(importer)) return null
      for (const r of redirects) if (r.match(source)) return r.file
      return null
    }
  }
}

export default defineConfig({
  root: rootDir,
  plugins: [harnessMocks()],
  test: {
    environment: 'node',
    // run-all.sh passes an explicit file list, which filters within this glob.
    include: ['packages/**/*.test.{ts,tsx,mjs}', 'scripts/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/worktrees/**'],
    globalSetup: [local('harness-global-setup.ts')],
    setupFiles: [local('harness-setup.ts')],
    pool: 'forks',
    isolate: true,
    // Many suites boot a real hub/computer bin, git, or a fresh migrated DB.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    passWithNoTests: false
  }
})
