import fs from 'fs'
import path from 'path'

/**
 * Does `node_modules` hold a usable install for the e2e app?
 *
 * An install run with lifecycle scripts skipped (`pnpm install --ignore-scripts`,
 * or one cut short) re-links node-pty from the store with `spawn-helper` at mode
 * 644 and never runs scripts/postinstall.js, which restores its execute bit. Every
 * pty spawn then fails with `posix_spawnp failed.` (reaching the app only as
 * `computer.pty.spawn` code -32000), and a full run reports ~70 terminal specs
 * failing for one environmental cause. Twice on 2026-10-29 that read as product
 * regressions. Checking up front turns it into one message naming the fix.
 */

/**
 * The builds pnpm skipped, from `node_modules/.modules.yaml` (pnpm writes it as
 * JSON). `null` when that can't be read: pnpm's internal format is not a contract,
 * so an unreadable manifest is "unknown", never "broken".
 */
export function pendingBuildsFrom(modulesYaml: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(modulesYaml)
    const pending = (parsed as { pendingBuilds?: unknown } | null)?.pendingBuilds
    return Array.isArray(pending) && pending.every((p) => typeof p === 'string') ? pending : null
  } catch {
    return null
  }
}

/**
 * Every `spawn-helper` node-pty may exec on this platform, in the order its
 * `loadNativeModule` searches (patches/node-pty@1.1.0.patch keeps that order).
 * Windows uses conpty and has no helper.
 */
export function spawnHelperCandidates(
  nodePtyDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string[] {
  if (platform === 'win32') return []
  return ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`].map((dir) =>
    path.join(nodePtyDir, dir, 'spawn-helper')
  )
}

interface InstallState {
  pendingBuilds: string[] | null
  /** Only helpers that exist on disk. */
  helpers: { path: string; executable: boolean }[]
}

/** Human-readable problems with the install; empty when it is usable. */
export function installProblems(state: InstallState): string[] {
  const problems: string[] = []
  if (state.pendingBuilds && state.pendingBuilds.length > 0) {
    problems.push(
      `pnpm skipped the install scripts of: ${state.pendingBuilds.join(', ')}. ` +
        'Run `pnpm rebuild --pending` at the repo root.'
    )
  }
  for (const helper of state.helpers) {
    if (!helper.executable) {
      problems.push(
        `${helper.path} is not executable, so every pty spawn fails with "posix_spawnp failed". ` +
          'Run `node scripts/postinstall.js` (or `pnpm rebuild --pending`) at the repo root.'
      )
    }
  }
  return problems
}

/** Reads the install under `repoRoot` and throws if it can't run the e2e app. */
export function assertInstallHealthy(repoRoot: string): void {
  const nodeModules = path.join(repoRoot, 'node_modules')
  let modulesYaml = ''
  try {
    modulesYaml = fs.readFileSync(path.join(nodeModules, '.modules.yaml'), 'utf8')
  } catch {
    // No manifest: not a pnpm install we can judge. The helper check still runs.
  }
  const helpers = spawnHelperCandidates(path.join(nodeModules, 'node-pty'))
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ path: p, executable: isExecutable(p) }))
  const problems = installProblems({ pendingBuilds: pendingBuildsFrom(modulesYaml), helpers })
  if (problems.length > 0) {
    throw new Error(
      `[global-setup] node_modules can't run the e2e app:\n  - ${problems.join('\n  - ')}`
    )
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}
