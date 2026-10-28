/**
 * The diagnostics tail of an app quit: flush the write queue, THEN close the
 * diagnostics worker, inside one deadline.
 *
 * Both steps are async (the DB is a worker thread). Run unawaited, the close
 * overtook the flush and the queue's tail — the `app.will-quit.complete` canary
 * among it — was lost. The deadline keeps a wedged worker from holding the quit
 * open; on timeout the caller exits anyway and the process exit reaps the worker.
 */
export async function drainDiagnosticsForQuit(deps: {
  /** `stopDiagnostics`: flushes the queue and stops retention. */
  stop: () => Promise<void>
  closeDb: () => Promise<void>
  timeoutMs: number
}): Promise<'drained' | 'timed-out'> {
  const drain = (async () => {
    // A failed flush must not skip the close; diagnostics never escalate.
    await deps.stop().catch(() => {
      // Diagnostics never escalate: the close below must still run.
    })
    await deps.closeDb().catch(() => {
      // Diagnostics never escalate: a failed close must not block the quit.
    })
    return 'drained' as const
  })()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), deps.timeoutMs)
  })
  const result = await Promise.race([drain, deadline])
  clearTimeout(timer)
  return result
}
