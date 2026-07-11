import { Command } from 'commander'
import {
  getHubConfigPath,
  normalizeHubUrl,
  removeHubConfig,
  resolveHubTarget,
  writeHubConfig
} from '../hub-config'

export function hubCommand(): Command {
  const cmd = new Command('hub')
    .description('Configure the SlayZone hub connection')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // slay hub set-url <url> [--token <t>]
  cmd
    .command('set-url <url>')
    .description('Point the CLI at a SlayZone hub (writes hub.json, 0600)')
    .option('--token <token>', 'Bearer token sent as Authorization header')
    .action((url: string, opts: { token?: string }) => {
      const normalized = normalizeHubUrl(url)
      if (!normalized) {
        console.error(`Invalid hub URL (expected http(s) URL): ${url}`)
        process.exit(1)
      }
      const configPath = writeHubConfig(normalized, opts.token ?? null)
      console.log(`Hub configured: ${normalized}`)
      console.log(`Config written: ${configPath}`)
      if (process.env.SLAYZONE_HUB_URL) {
        console.error('Note: SLAYZONE_HUB_URL is set and takes precedence over this config.')
      }
    })

  // slay hub status
  cmd
    .command('status')
    .description('Show the configured hub target and probe its /health endpoint')
    .action(async () => {
      const target = resolveHubTarget()
      if (!target) {
        console.log('No hub configured — using local app.')
        return
      }
      const source = process.env.SLAYZONE_HUB_URL ? 'SLAYZONE_HUB_URL env' : getHubConfigPath()
      console.log(`Hub:    ${target.baseUrl}`)
      console.log(`Source: ${source}`)
      console.log(`Token:  ${target.token ? 'set' : 'not set'}`)
      try {
        const headers: Record<string, string> = target.token
          ? { Authorization: `Bearer ${target.token}` }
          : {}
        const res = await fetch(`${target.baseUrl}/health`, {
          headers,
          signal: AbortSignal.timeout(5000)
        })
        if (res.ok) {
          console.log(`Health: ok (HTTP ${res.status})`)
        } else {
          console.error(`Health: failed (HTTP ${res.status})`)
          process.exit(1)
        }
      } catch {
        console.error(`Health: unreachable (could not connect to ${target.baseUrl})`)
        process.exit(1)
      }
    })

  // slay hub logout
  cmd
    .command('logout')
    .description('Remove the stored hub config')
    .action(() => {
      const removed = removeHubConfig()
      console.log(removed ? `Removed: ${getHubConfigPath()}` : 'No hub config to remove.')
      if (process.env.SLAYZONE_HUB_URL) {
        console.error('Note: SLAYZONE_HUB_URL is still set in the environment.')
      }
    })

  return cmd
}
