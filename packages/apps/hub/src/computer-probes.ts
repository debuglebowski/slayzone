/**
 * Terminal settings probes, run where agents start — the caller's computer, as one
 * `exec.run` — never on the hub's own PATH, which says nothing about that machine:
 * whether a terminal mode's binary is installed, and whether a docker / ssh
 * execution context answers. No computer: "connect a computer".
 *
 * @module hub/computer-probes
 */
import type { ExecRunParams, ExecRunResult } from '@slayzone/computer-transport/shared'
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'

const WHICH_TIMEOUT_MS = 10_000
/** As the hub-local probe had: ssh's own ConnectTimeout (5s) fits; a docker whose
 *  daemon is down hangs, and this ends it. */
const CONTEXT_TIMEOUT_MS = 10_000

/**
 * One shell word. Plain names stay bare — `exec.run` is `cmd /c` on a Windows
 * computer, which does not strip single quotes — anything else is POSIX-quoted, so
 * a name can never run something else.
 */
function word(arg: string): string {
  return /^[\w.+\-/\\:@=]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`
}

export interface ComputerProbeDeps {
  computerFor(): Promise<string | null>
  run(computerId: string, params: ExecRunParams): Promise<ExecRunResult>
}

export function createComputerProbes(deps: ComputerProbeDeps) {
  async function run(op: string, params: ExecRunParams): Promise<ExecRunResult> {
    const computerId = await deps.computerFor()
    if (computerId == null) return refuseNoComputer({ op })
    return deps.run(computerId, params)
  }
  return {
    /** `command -v` on POSIX, `where` on Windows (the first that answers). */
    async command(bin: string): Promise<{ found: boolean; path?: string; error?: string }> {
      const w = word(bin)
      const r = await run('terminal_modes.test', {
        command: `command -v ${w} || where ${w}`,
        timeoutMs: WHICH_TIMEOUT_MS
      })
      const path = r.stdout.trim().split(/\r?\n/)[0]
      return r.status === 0 && path
        ? { found: true, path }
        : { found: false, error: r.timedOut ? 'Timed out' : r.stderr.trim() }
    },
    async executionContext(
      file: string,
      args: string[]
    ): Promise<{ success: boolean; error?: string }> {
      const r = await run('pty.test_execution_context', {
        command: [file, ...args].map(word).join(' '),
        timeoutMs: CONTEXT_TIMEOUT_MS
      })
      if (r.timedOut) return { success: false, error: 'Timed out' }
      return r.status === 0
        ? { success: true }
        : { success: false, error: r.stderr.trim() || `exit ${r.status}` }
    }
  }
}
