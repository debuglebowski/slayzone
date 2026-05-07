export interface LifecycleHandle {
  stop(): Promise<void>
}

export function installSignalHandlers(handle: LifecycleHandle): () => void {
  let shuttingDown = false

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      console.error(`Got ${signal} again — forcing exit`)
      process.exit(1)
    }
    shuttingDown = true
    console.error(`\nReceived ${signal}, shutting down...`)
    const timeout = setTimeout(() => {
      console.error('Shutdown timeout (5s) — forcing exit')
      process.exit(1)
    }, 5000)
    timeout.unref()
    handle.stop().then(
      () => {
        clearTimeout(timeout)
        process.exit(0)
      },
      (err) => {
        clearTimeout(timeout)
        console.error('Shutdown error:', err)
        process.exit(1)
      },
    )
  }

  const onUncaught = (err: Error): void => {
    console.error('Uncaught exception:', err)
    handle.stop().finally(() => process.exit(1))
  }

  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  process.on('uncaughtException', onUncaught)

  return () => {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    process.off('uncaughtException', onUncaught)
  }
}
