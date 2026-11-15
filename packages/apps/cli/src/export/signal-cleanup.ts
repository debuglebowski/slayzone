/**
 * Synchronous cleanup that must run however `slay` ends: normal exit, or SIGINT /
 * SIGTERM / SIGHUP — for which Node emits no 'exit' unless someone handles the
 * signal. On a signal the cleanup runs, then the signal is re-raised so the process
 * still ends the way it was told to. Returns the function that unregisters it.
 *
 * A cleanup that throws (an `rmSync` racing a write still in flight on the thread
 * pool: ENOTEMPTY) is reported on stderr and does not stop the rest: thrown inside
 * the handler it would skip every later cleanup and turn "ended by SIGINT" into a
 * crash with exit code 1.
 */
const SIGNALS: NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP']

export function onExitOrSignal(cleanup: () => void): () => void {
  const run = (): void => {
    try {
      cleanup()
    } catch (err) {
      process.stderr.write(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  const onSignal = (signal: NodeJS.Signals): void => {
    remove()
    run()
    process.kill(process.pid, signal)
  }
  const remove = (): void => {
    process.removeListener('exit', run)
    for (const s of SIGNALS) process.removeListener(s, onSignal)
  }
  process.once('exit', run)
  for (const s of SIGNALS) process.once(s, onSignal)
  return remove
}
