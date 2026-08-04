/**
 * Which leftover processes the e2e global setup may kill.
 *
 * The reaper finds candidates by `pgrep`ing bundle paths — but a TEST run and
 * the developer's live `pnpm dev` app run the SAME bundles from the SAME paths,
 * so a path match cannot tell them apart. Matching `runner/dist/bin.cjs`
 * therefore SIGTERM'd the supervised dev app's local runner, which owns every
 * agent pty on the machine: one `pnpm test:e2e` invocation killed every running
 * agent, each pane showing "Process exited with code 1" at the same instant.
 *
 * The discriminator is the process ENVIRONMENT. `fixtures/electron.ts` launches
 * every e2e app with `PLAYWRIGHT=1`, and the sidecar + local runner it spawns
 * inherit it (both supervisors pass `{...process.env}` to the child). A dev-run
 * process never carries it, so requiring the marker reaps exactly the leftovers
 * the reaper was written for and nothing else.
 *
 * Selection fails CLOSED — an unreadable environment is left alone. A missed
 * orphan costs a warning line; a killed dev runner costs every running agent.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Marker every Playwright-launched process (and its children) carries. */
const E2E_MARKER = /(?:^|\s)PLAYWRIGHT=/

export type StaleCandidate = { pid: number; command: string }

/** Parse `pgrep -af <pattern>` output ("<pid> <full command line>" per line). */
export function parsePgrepOutput(out: string): StaleCandidate[] {
  const candidates: StaleCandidate[] = []
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const space = line.indexOf(' ')
    const pid = Number.parseInt(space === -1 ? line : line.slice(0, space), 10)
    if (!Number.isInteger(pid) || pid <= 0) continue
    candidates.push({ pid, command: space === -1 ? '' : line.slice(space + 1) })
  }
  return candidates
}

/**
 * Read a process's environment as one blob. Linux exposes it directly; macOS
 * needs `ps eww`, which prints `KEY=VALUE` pairs after the command. Throws when
 * the process is gone or not ours — which callers treat as "do not kill".
 */
export function readProcessEnviron(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').join(' ')
  } catch {
    return execFileSync('ps', ['eww', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  }
}

/**
 * Narrow pgrep candidates to processes belonging to a PREVIOUS TEST RUN.
 * `exclude` carries the reaper's own pid/ppid, which must never be killed even
 * though they legitimately carry the marker.
 */
export function selectTestRunPids(
  candidates: readonly StaleCandidate[],
  readEnviron: (pid: number) => string,
  exclude: readonly number[]
): number[] {
  const skip = new Set(exclude)
  const pids: number[] = []
  for (const { pid } of candidates) {
    if (skip.has(pid)) continue
    let environ: string
    try {
      environ = readEnviron(pid)
    } catch {
      continue // fail closed: unknown provenance is never killed
    }
    if (E2E_MARKER.test(environ)) pids.push(pid)
  }
  return pids
}
