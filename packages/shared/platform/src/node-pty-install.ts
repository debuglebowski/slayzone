import fs from 'node:fs'
import path from 'node:path'

/**
 * Can node-pty start processes from this install?
 *
 * An install run with lifecycle scripts skipped (`pnpm install --ignore-scripts`,
 * or one cut short) re-links node-pty from the store with `spawn-helper` at mode
 * 644 and never runs scripts/postinstall.js, which restores its execute bit. Every
 * pty spawn then fails with `posix_spawnp failed.`: the computer couldn't start any
 * agent, and an e2e run reports ~70 terminal specs failing for one environmental
 * cause. Read three times on 2026-10-29 as a product bug.
 *
 * Shared by everything that needs the verdict: the e2e global setup (refuses to
 * run), the computer (explains a failed spawn) and Doctor (`pty.doctor`).
 *
 * @module platform/node-pty-install
 */

/** One way the install can't start processes, shaped as a Doctor row. */
export interface NodePtyInstallProblem {
  /** Unique per problem kind — Doctor keys its rows by it. */
  check: string
  detail: string
  /** A shell command that repairs it. */
  fix: string
}

export interface NodePtyInstallState {
  /** Directory holding the pnpm manifest's `node_modules`; null without a manifest. */
  repoRoot: string | null
  pendingBuilds: string[] | null
  /** Only helpers that exist on disk. */
  helpers: { path: string; executable: boolean }[]
}

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

/**
 * The on-disk path of a file inside a packaged app's `app.asar`: an executable
 * can't run from inside the archive, so electron-builder unpacks it and node-pty
 * execs the unpacked copy (the same rewrite as its `unixTerminal.js`).
 */
export function unpackedAsarPath(file: string): string {
  return file
    .replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')
    .replace(/node_modules\.asar(?!\.unpacked)/, 'node_modules.asar.unpacked')
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** What is wrong with the install; empty when it is usable. One entry per kind. */
export function installProblems(state: NodePtyInstallState): NodePtyInstallProblem[] {
  const problems: NodePtyInstallProblem[] = []
  if (state.repoRoot !== null && state.pendingBuilds && state.pendingBuilds.length > 0) {
    problems.push({
      check: 'Install scripts ran',
      detail: `pnpm skipped the install scripts of: ${state.pendingBuilds.join(', ')}.`,
      fix: `cd ${shellQuote(state.repoRoot)} && pnpm rebuild --pending`
    })
  }
  const broken = state.helpers.filter((h) => !h.executable).map((h) => h.path)
  if (broken.length > 0) {
    problems.push({
      check: 'spawn-helper executable',
      detail:
        `${broken.join(', ')} ${broken.length === 1 ? 'is' : 'are'} not executable, so every ` +
        'terminal fails to start ("posix_spawnp failed").',
      fix: `chmod +x ${broken.map(shellQuote).join(' ')}`
    })
  }
  return problems
}

/**
 * Read the install around `nodePtyDir` (the `node-pty` package directory). The
 * pnpm manifest is looked up in the `node_modules` holding it — a hoisted install,
 * as this workspace's is.
 */
export function readNodePtyInstall(nodePtyDir: string): NodePtyInstallState {
  const nodeModules = path.dirname(nodePtyDir)
  let pendingBuilds: string[] | null = null
  let repoRoot: string | null = null
  try {
    pendingBuilds = pendingBuildsFrom(
      fs.readFileSync(path.join(nodeModules, '.modules.yaml'), 'utf8')
    )
    repoRoot = path.dirname(nodeModules)
  } catch {
    // No manifest: not a pnpm install we can judge (a packaged app, an npm
    // install). The helper check still runs.
  }
  const helpers = spawnHelperCandidates(nodePtyDir)
    .map(unpackedAsarPath)
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ path: p, executable: isExecutable(p) }))
  return { repoRoot, pendingBuilds, helpers }
}

/** {@link installProblems} of the install around `nodePtyDir`, read off disk. */
export function nodePtyInstallProblems(nodePtyDir: string): NodePtyInstallProblem[] {
  return installProblems(readNodePtyInstall(nodePtyDir))
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}
