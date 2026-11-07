import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'
import { isolateFromCaller } from './caller-env.ts'
import { fsModuleCacheOptions, fsModuleCacheResolutionKey } from './fs-module-cache.ts'

// vitest's main process, before any worker forks: no worker, and nothing a suite
// spawns, inherits the caller's SlayZone wiring, home or hub port block
// (caller-env.ts). harness-setup.ts repeats it per file.
isolateFromCaller()

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
  plugins: [harnessMocks(), fsModuleCacheResolutionKey(rootDir)],
  test: {
    environment: 'node',
    // run-all.sh passes an explicit file list, which filters within this glob.
    include: ['packages/**/*.test.{ts,tsx,mjs}', 'scripts/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/worktrees/**'],
    globalSetup: [local('harness-global-setup.ts')],
    setupFiles: [local('harness-setup.ts')],
    pool: 'forks',
    isolate: true,
    // One fork per core, not vitest's cores-1: these workers often WAIT (on a hub or
    // computer bin booting, git, a child process, a timer). Not two per core either:
    // the suites they wait on are real hub/computer processes that compute, and in the
    // full `pnpm test:unit` (this lane next to the app lane) two per core drove the
    // 10-core Mac to load ~230 for minutes. Multi-process suites with real wall-clock
    // windows then missed them: historical-supervisor passes at load ~100 and fails at
    // ~215 (reproduced with CPU burners alone). One per core: peak load ~95, the same
    // wall time (296 s vs 307 s).
    maxWorkers: Math.max(2, availableParallelism()),
    // Many suites boot a real hub/computer bin, git, or a fresh migrated DB.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    passWithNoTests: false,
    // Transforms persist between runs (see fs-module-cache.ts).
    ...fsModuleCacheOptions(rootDir, 'harness')
  }
})
