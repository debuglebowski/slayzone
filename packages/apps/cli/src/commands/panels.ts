import { Command } from 'commander'
import { apiGet, apiPost, apiPatch, apiDelete } from '../api'
import type { WebPanelDefinition } from '@slayzone/task/shared/types'

type PanelWithEnabled = WebPanelDefinition & { enabled?: boolean }

export function panelsCommand(): Command {
  const cmd = new Command('panels')
    .description('Manage web panels')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // slay panels list
  cmd
    .command('list')
    .description('List web panels')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      // GET /api/panels returns the merged webPanels list; each row carries an
      // `enabled` flag (task-view visibility) computed server-side.
      const { data: webPanels } = await apiGet<{ ok: true; data: PanelWithEnabled[] }>(
        '/api/panels'
      )

      if (opts.json) {
        // Preserve the historic --json shape (bare WebPanelDefinition list, no
        // `enabled` field, which was never part of it).
        console.log(
          JSON.stringify(
            webPanels.map(({ enabled: _enabled, ...p }) => p),
            null,
            2
          )
        )
        return
      }

      if (webPanels.length === 0) {
        console.log('No web panels configured.')
        return
      }

      const idW = 12
      const nameW = 20
      const urlW = 35
      console.log(
        `${'ID'.padEnd(idW)}  ${'NAME'.padEnd(nameW)}  ${'URL'.padEnd(urlW)}  ${'KEY'.padEnd(4)}  ON`
      )
      console.log(
        `${'-'.repeat(idW)}  ${'-'.repeat(nameW)}  ${'-'.repeat(urlW)}  ${'-'.repeat(4)}  ${'-'.repeat(2)}`
      )
      for (const wp of webPanels) {
        const id = wp.id.slice(0, 12).padEnd(idW)
        const name = wp.name.slice(0, nameW).padEnd(nameW)
        const url = wp.baseUrl.slice(0, urlW).padEnd(urlW)
        const shortcut = (wp.shortcut ? wp.shortcut.toUpperCase() : '').padEnd(4)
        const enabled = wp.enabled !== false ? '✓' : '✗'
        console.log(`${id}  ${name}  ${url}  ${shortcut}  ${enabled}`)
      }
    })

  // slay panels create
  cmd
    .command('create <name> <url>')
    .description('Create a custom web panel')
    .option('-s, --shortcut <letter>', 'Keyboard shortcut (single letter)')
    .option('--block-handoff', 'Block desktop app handoff')
    .option('--protocol <protocol>', 'Handoff protocol (requires --block-handoff)')
    .action(async (name: string, rawUrl: string, opts) => {
      if (!name.trim()) {
        console.error('Panel name is required.')
        process.exit(1)
      }

      if (opts.protocol && !opts.blockHandoff) {
        console.error('--protocol requires --block-handoff')
        process.exit(1)
      }

      // POST /api/panels owns url normalization, shortcut validation, and
      // handoff-protocol inference; it returns the created panel.
      const { data: panel } = await apiPost<{ ok: true; data: WebPanelDefinition }>('/api/panels', {
        name,
        url: rawUrl,
        shortcut: opts.shortcut,
        blockHandoff: opts.blockHandoff || undefined,
        protocol: opts.protocol
      })
      console.log(`Created panel: ${panel.id}  ${panel.name}  ${panel.baseUrl}`)
    })

  // slay panels delete
  cmd
    .command('delete <id-or-name>')
    .description('Delete a web panel')
    .action(async (idOrName: string) => {
      const { data: panel } = await apiDelete<{ ok: true; data: { id: string; name: string } }>(
        `/api/panels/${encodeURIComponent(idOrName)}`
      )
      console.log(`Deleted panel: ${panel.id}  ${panel.name}`)
    })

  // slay panels enable
  cmd
    .command('enable <id-or-name>')
    .description('Enable a web panel in task view')
    .action(async (idOrName: string) => {
      const { data: panel } = await apiPatch<{ ok: true; data: { id: string; name: string } }>(
        `/api/panels/${encodeURIComponent(idOrName)}`,
        { enabled: true }
      )
      console.log(`Enabled panel: ${panel.id}  ${panel.name}`)
    })

  // slay panels disable
  cmd
    .command('disable <id-or-name>')
    .description('Disable a web panel in task view')
    .action(async (idOrName: string) => {
      const { data: panel } = await apiPatch<{ ok: true; data: { id: string; name: string } }>(
        `/api/panels/${encodeURIComponent(idOrName)}`,
        { enabled: false }
      )
      console.log(`Disabled panel: ${panel.id}  ${panel.name}`)
    })

  return cmd
}
