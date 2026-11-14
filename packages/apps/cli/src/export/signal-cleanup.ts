/**
 * Synchronous cleanup that must run however `slay` ends: normal exit, or SIGINT /
 * SIGTERM / SIGHUP — for which Node emits no 'exit' unless someone handles the
 * signal. On a signal the cleanup runs, then the signal is re-raised so the process
 * still ends the way it was told to. Returns the function that unregisters it.
 */
const SIGNALS: NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP']

export function onExitOrSignal(cleanup: () => void): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    remove()
    cleanup()
    process.kill(process.pid, signal)
  }
  const remove = (): void => {
    process.removeListener('exit', cleanup)
    for (const s of SIGNALS) process.removeListener(s, onSignal)
  }
  process.once('exit', cleanup)
  for (const s of SIGNALS) process.once(s, onSignal)
  return remove
}
