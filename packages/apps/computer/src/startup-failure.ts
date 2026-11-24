/**
 * Runs a computer process's `main`, so a startup failure ends the process with its
 * reason recorded — never as an unhandled rejection. Before (`void main()`), 0.41.1
 * connector workers died every ~30s with only a bare `RpcDisposedError: computer-local
 * closed: local connection closed` stack in the journal: nothing in computer.log, and
 * nothing told their supervisor why.
 *
 * Same outcome as before (exit 1), now with: the stack on stderr, a `startup failed`
 * line in `<stateDir>/logs/computer.log`, and — for a worker — a `fatal` message its
 * upgrade supervisor already logs.
 */
import { appendComputerLogSync } from './file-log'

/** The subset of `process` {@link runMain} uses (a fake in tests). */
export interface StartupProcess {
  pid: number
  exitCode?: number | string | null | undefined
  connected?: boolean
  send?: (message: unknown, callback: () => void) => boolean
  exit(code: number): void
  stderr: { write(text: string): unknown }
}

export async function runMain(
  main: () => Promise<void>,
  opts: {
    /** Where computer.log is; may throw before config is resolved. */
    stateDir: () => string
    tag: string
    proc?: StartupProcess
  }
): Promise<void> {
  const proc = opts.proc ?? (process as unknown as StartupProcess)
  try {
    await main()
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    const detail = err instanceof Error ? (err.stack ?? reason) : reason
    proc.stderr.write(`[${opts.tag}] startup failed: ${detail}\n`)
    try {
      appendComputerLogSync(
        opts.stateDir(),
        `[${opts.tag} ${proc.pid}] startup failed ${JSON.stringify({ error: detail })}`
      )
    } catch {
      /* No log directory yet: stderr has it. */
    }
    proc.exitCode = 1
    let exited = false
    const exit = (): void => {
      if (exited) return
      exited = true
      proc.exit(1)
    }
    if (proc.send && proc.connected) {
      // A worker's supervisor learns why, then the exit it relaunches on.
      proc.send({ type: 'fatal', error: reason }, exit)
      setTimeout(exit, 1000).unref()
    } else exit()
  }
}
