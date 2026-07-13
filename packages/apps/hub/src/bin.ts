import { startServer } from './server.js'
import type { ServerHandle } from './index.js'

async function main(): Promise<void> {
  const handle: ServerHandle = await startServer()

  process.stdout.write(
    `[slayzone-server] listening on http://${handle.host}:${handle.port} ` +
      `(data=${handle.dataRoot} db=${handle.dbPath})\n`
  )

  let shuttingDown = false
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    process.stdout.write(`[slayzone-server] shutting down (${reason})\n`)
    try {
      await handle.stop()
      process.exit(0)
    } catch (err) {
      process.stderr.write(
        `[slayzone-server] shutdown error: ${err instanceof Error ? err.stack : String(err)}\n`
      )
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // Parent-death detection: when launched by the Electron supervisor, the
  // side-car self-terminates the instant its parent dies — clean exit OR
  // kill -9. Standalone runs (SLAYZONE_SUPERVISED unset) skip this so a closed
  // shell stdin does not kill a manually-run server.
  if (process.env.SLAYZONE_SUPERVISED === '1') {
    // (a) stdin pipe: the supervisor holds the write end open. Any parent
    //     death closes the pipe → 'close'/'end' fires here.
    process.stdin.on('close', () => void shutdown('parent-pipe-closed'))
    process.stdin.on('end', () => void shutdown('parent-pipe-closed'))
    process.stdin.resume()
    // (b) ppid poll backstop: reparent to init/launchd → ppid becomes 1.
    const originalPpid = process.ppid
    setInterval(() => {
      if (process.ppid === 1 || process.ppid !== originalPpid) {
        void shutdown('parent-reparented')
      }
    }, 2_000).unref()
  }
}

main().catch((err) => {
  process.stderr.write(
    `[slayzone-server] fatal: ${err instanceof Error ? err.stack : String(err)}\n`
  )
  process.exit(1)
})
