/**
 * slayzone-runner CLI entrypoint.
 *
 *   SLAYZONE_HUB_URL=wss://hub:8443/fleet \
 *   SLAYZONE_JOIN_TOKEN=... \
 *   slayzone-runner
 *
 * See `config.ts` for the full set of SLAYZONE_* variables and the optional
 * SLAYZONE_RUNNER_CONFIG JSON file.
 */

import { ENV_VARS, loadRunnerConfig } from './config'
import { startRunner } from './main'

function main(): void {
  let config
  try {
    config = loadRunnerConfig()
  } catch (err) {
    process.stderr.write(`slayzone-runner: ${err instanceof Error ? err.message : String(err)}\n`)
    process.stderr.write(
      `usage: ${ENV_VARS.hubUrl}=wss://<hub>/fleet [${ENV_VARS.joinToken}=<token>] slayzone-runner\n`
    )
    process.exitCode = 1
    return
  }

  const log = (message: string, meta?: Record<string, unknown>): void => {
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
    process.stdout.write(`[runner] ${message}${suffix}\n`)
  }

  const handle = startRunner(config, {
    log,
    onShutdown: () => {
      process.exitCode = 0
    }
  })

  // The dialer gives up on fatal auth errors (bad join token, missing creds);
  // exit non-zero so supervisors notice instead of idling forever.
  handle.dialer.events.on('error', ({ fatal }) => {
    if (fatal) process.exitCode = 1
  })

  let stopping = false
  const gracefulStop = (signal: string): void => {
    if (stopping) return
    stopping = true
    log(`received ${signal}, stopping`)
    void handle.stop().then(() => {
      process.exitCode ??= 0
    })
  }
  process.on('SIGINT', () => gracefulStop('SIGINT'))
  process.on('SIGTERM', () => gracefulStop('SIGTERM'))
}

main()
