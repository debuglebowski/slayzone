import path from 'path'
import { nodePtyInstallProblems } from '@slayzone/platform/node-pty-install'

/**
 * Does `node_modules` hold a usable install for the e2e app?
 *
 * An install run with lifecycle scripts skipped leaves node-pty unable to start
 * any process, and a full run then reports ~70 terminal specs failing for one
 * environmental cause — twice on 2026-10-29 that read as product regressions.
 * Checking up front turns it into one message naming the fix. The check itself
 * is shared with the computer and Doctor: `@slayzone/platform/node-pty-install`.
 */

/** Reads the install under `repoRoot` and throws if it can't run the e2e app. */
export function assertInstallHealthy(repoRoot: string): void {
  const problems = nodePtyInstallProblems(path.join(repoRoot, 'node_modules', 'node-pty'))
  if (problems.length > 0) {
    throw new Error(
      `[global-setup] node_modules can't run the e2e app:\n  - ${problems
        .map((p) => `${p.detail} Fix: ${p.fix}`)
        .join('\n  - ')}`
    )
  }
}
