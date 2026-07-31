declare const __APP_VERSION__: string

// `node:sqlite` is still flagged experimental, so importing it prints an
// ExperimentalWarning to stderr on every invocation. The repo's `bin/slay`
// wrapper passes `--no-warnings`, but npm generates the bin shim for the
// published package and cannot, so suppress precisely THIS warning here —
// filtering by name rather than muting the channel, so any other warning still
// reaches the user.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return
  console.warn(`${warning.name}: ${warning.message}`)
})

import { Command } from 'commander'
import { discoverHubs, findHub } from '@slayzone/platform/hub-discovery'
import { setHubOverride } from './hub-config'
import { getServerPort, hasLocalDatabase } from './db'
import { tasksCommand } from './commands/tasks'
import { projectsCommand } from './commands/projects'
import { processesCommand } from './commands/processes'
import { completionsCommand } from './commands/completions'
import { initCommand } from './commands/init'
import { ptyCommand } from './commands/pty'
import { tagsCommand } from './commands/tags'
import { templatesCommand } from './commands/templates'
import { automationsCommand } from './commands/automations'
import { panelsCommand } from './commands/panels'
import { hubCommand } from './commands/hub'
import { runnerCommand } from './commands/runner'

const program = new Command()
  .name('slay')
  .description('SlayZone CLI')
  .version(__APP_VERSION__)
  .option('--dev', 'Use development database (slayzone.dev.sqlite)')
  .option('--hub <name|port>', 'Target a specific hub on this machine (see `slay hub ls`)')
  .showSuggestionAfterError(true)
  .showHelpAfterError(true)
  // Async on purpose: resolving `--hub` probes the machine's hubs. Commander
  // promise-chains lifecycle hooks under parseAsync, so the action waits for it.
  .hook('preAction', async (thisCommand) => {
    const root = thisCommand.parent ?? thisCommand
    const opts = root.opts<{ dev?: boolean; hub?: string }>()
    if (opts.dev) process.env.SLAYZONE_DEV = '1'
    if (opts.hub !== undefined) await applyHubOverride(opts.hub)
  })

/**
 * Point this invocation at the hub named (or listening on the port) given to
 * `--hub`. Exits when it cannot be found: the operator asked for a SPECIFIC hub,
 * so quietly falling back to the ambient target would send the command somewhere
 * they did not choose.
 */
async function applyHubOverride(nameOrPort: string): Promise<void> {
  // The desktop app's sidecar binds outside the hub block and publishes its port
  // to `settings.server_port`; include it so `--hub app` works like any other
  // name. Best-effort — a hub-only box has no SlayZone DB to read.
  // Probe for the DB file first — getServerPort() → openDb() exits the process
  // when it is absent, which a try/catch cannot intercept.
  let extraPorts: number[] = []
  if (hasLocalDatabase()) {
    try {
      const appPort = getServerPort()
      if (appPort) extraPorts = [appPort]
    } catch {
      /* unreadable DB — the block sweep is enough */
    }
  }
  const hub = await findHub(nameOrPort, { extraPorts })
  if (!hub) {
    const running = await discoverHubs({ extraPorts })
    console.error(`No hub named or listening on "${nameOrPort}".`)
    console.error(
      running.length > 0
        ? `Running hubs: ${running.map((h) => `${h.name} (${h.port})`).join(', ')}`
        : 'No hubs are running on this machine.'
    )
    process.exit(1)
  }
  // Discovery only reaches loopback hubs, so the scheme is always plain http.
  //
  // The token comes from the env channel, which is address-agnostic and only ever
  // set deliberately. Dropping it here (as this did) meant `--hub` silently
  // downgraded to an unauthenticated request — invisible on a loopback hub, which
  // allows every co-located caller before it even looks at the header, and a flat
  // 401 the moment a hub enforces auth. `hub.json`'s token is NOT used: it belongs
  // to whichever hub `hub use`/`hub login` targeted, which need not be this one.
  setHubOverride({
    baseUrl: `http://127.0.0.1:${hub.port}`,
    token: process.env.SLAYZONE_HUB_TOKEN || null
  })
}

program.addCommand(tasksCommand())
program.addCommand(projectsCommand())
program.addCommand(tagsCommand())
program.addCommand(templatesCommand())
program.addCommand(automationsCommand())
program.addCommand(panelsCommand())
program.addCommand(processesCommand())
program.addCommand(completionsCommand())
program.addCommand(initCommand())
program.addCommand(ptyCommand())
program.addCommand(hubCommand())
program.addCommand(runnerCommand())

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
