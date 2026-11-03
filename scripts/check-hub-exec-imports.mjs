#!/usr/bin/env node
// Hub exec guard (T-06). A hub with SLAYZONE_HUB_ENABLE_PROCESSES=0 must never start a
// process on its own machine: every place that can is refused in code
// (`assertHubProcessesEnabled` / `assertHubLocalExecEnabled`). This guard keeps that
// list closed — a NEW import of a process-spawning module anywhere in the hub bundle
// fails here until it is either routed to a computer or refused and allowlisted below.
//
// It reads esbuild's metafile for the hub entry (same entry and externals as
// packages/apps/hub/build.mjs) instead of grepping directories, so it follows the
// bundle graph: any package the hub pulls in counts, `require` and dynamic `import`
// count, `import type` does not, and a third-party dependency that shells out shows up
// under its node_modules path. An allowlist entry that no longer imports one fails too,
// so the list cannot rot.
//
// Usage: node scripts/check-hub-exec-imports.mjs  (part of `pnpm lint:server-boundary`)
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const HUB = join(ROOT, 'packages/apps/hub')
// The hub's own esbuild — the one that builds the bundle this checks.
const { build } = createRequire(join(HUB, 'package.json'))('esbuild')

/** Modules that start a process (or a pty). */
const EXEC_MODULE =
  /^(node:)?(child_process|cluster)$|^(execa|cross-spawn|node-pty|@lydell\/node-pty|shelljs|zx|tinyexec|nano-spawn|spawn-rx|foreground-child)(\/|$)/

/**
 * Hub-bundled files allowed to import one, each with why it is safe on a hub with
 * processes switched off. Repo-relative paths.
 */
const ALLOWLIST = {
  // Refused by assertHubProcessesEnabled (T-04/T-05).
  'packages/shared/platform/src/process-tree.ts':
    'Windows taskkill in killPidTree; bundled via the @slayzone/platform barrel, never called by the hub (background processes run on computers)',
  'packages/domains/terminal/src/server/runtime/pty-backend.ts':
    'node-pty for localPtyBackend; refuses (T-04), required on first spawn only (T-30)',
  'packages/domains/terminal/src/server/runtime/pty-manager.ts':
    'spawns go through getPtyBackend(); docker/ssh probe refuses (T-04)',
  'packages/domains/terminal/src/server/runtime/chat-proc-handle.ts':
    'in-process chat agent; refuses (T-04)',
  'packages/domains/terminal/src/server/runtime/chat-transport-manager.ts':
    'in-process chat agent; refuses (T-04)',
  // Refused by assertHubLocalExecEnabled, "connect a computer" (T-06).
  'packages/domains/terminal/src/server/shell-env.ts':
    'login-shell PATH and which probes; refuse (T-06)',
  'packages/shared/platform/src/login-shell-path.ts':
    'login-shell PATH probe; the hub runs it only through shell-env getEnrichedPathAsync, which refuses (T-06)',
  'packages/domains/terminal/src/server/files-scan.ts':
    '@file autocomplete git ls-files; refuses (T-06)',
  'packages/domains/terminal/src/server/runtime/pty-store.ts':
    'terminal-mode which probe; refuses (T-06)',
  'packages/apps/hub/src/shell-native.ts': 'open/xdg-open/explorer; refuse (T-06)',
  'packages/shared/db-migrations/src/migrations.ts':
    'v122 git backfill over existing agent_turns rows; skipped with processes off (T-06)',
  // Not reachable as exec on a hub.
  'packages/shared/platform/src/cli-install.ts':
    'desktop CLI installer; the hub calls only checkCliInstalled (fs probe) and stubs appInstallCli'
}

const result = await build({
  absWorkingDir: HUB,
  entryPoints: ['src/bin.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['better-sqlite3', 'bufferutil', 'utf-8-validate', 'node-pty'],
  write: false,
  outfile: 'dist/exec-guard.cjs',
  metafile: true,
  logLevel: 'silent'
})

const repoPath = (input) => relative(ROOT, join(HUB, input)).replaceAll('\\', '/')

/** file → exec modules it imports */
const importers = new Map()
for (const [input, info] of Object.entries(result.metafile.inputs)) {
  for (const imp of info.imports) {
    // `path` is the resolved file for a bundled package; `original` is the specifier.
    const spec = imp.original ?? imp.path
    if (!EXEC_MODULE.test(spec)) continue
    const file = repoPath(input)
    if (!importers.has(file)) importers.set(file, new Set())
    importers.get(file).add(spec)
  }
}

let fail = false
for (const [file, mods] of [...importers].sort()) {
  if (ALLOWLIST[file]) continue
  if (!fail) {
    console.log('A process-spawning module is imported by hub-bundled code outside the allowlist.')
    console.log('Route the work to a computer, or refuse it with assertHubLocalExecEnabled /')
    console.log('assertHubProcessesEnabled and add the file to scripts/check-hub-exec-imports.mjs')
    console.log('with a one-line reason:')
  }
  fail = true
  console.log(`  ${file} -> ${[...mods].join(', ')}`)
}
const stale = Object.keys(ALLOWLIST).filter((file) => !importers.has(file))
if (stale.length > 0) {
  fail = true
  console.log(
    'Allowlisted in scripts/check-hub-exec-imports.mjs but no longer imports one (remove):'
  )
  for (const file of stale) console.log(`  ${file}`)
}

if (fail) process.exit(1)
console.log(
  `Hub exec-import guard passed (${importers.size} hub-bundled file(s) import a process module, all allowlisted).`
)
