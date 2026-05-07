import { parseConfig, isHelpRequested, isVersionRequested, HELP_TEXT } from './config'
import { startServer } from './boot'
import { installSignalHandlers } from './lifecycle'
import { LockHeldError } from './lockfile'
import { getServerVersion } from './version'
import { registerCoreRest } from './rest'
import { registerMcpTools } from './mcp/tools'

export async function main(): Promise<void> {
  if (isHelpRequested()) {
    process.stdout.write(HELP_TEXT)
    process.exit(0)
  }
  if (isVersionRequested()) {
    process.stdout.write(getServerVersion() + '\n')
    process.exit(0)
  }

  const config = parseConfig()
  try {
    const handle = await startServer({
      config,
      registerCoreRest,
      registerMcpTools,
    })
    installSignalHandlers({ stop: handle.stop })
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(err.message)
      process.exit(1)
    }
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`Port ${config.port} is already in use. Set --port <n> or SLAYZONE_PORT.`)
      process.exit(1)
    }
    console.error('Failed to start server:', err)
    process.exit(1)
  }
}

// Auto-invoke when run as the bin entry. The bundled cli.js is what npm
// puts on PATH as `slayzone-server`; importers of @slayzone/server (Electron
// embedded host) call startServer() directly and never load this file.
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
