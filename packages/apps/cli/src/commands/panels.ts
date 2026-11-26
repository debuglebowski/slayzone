import { Command } from 'commander'
import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from '../api'
import type { WebPanelDefinition } from '@slayzone/task-contracts/types'
import type { InstancePlacement, TaskLayout } from '@slayzone/task-contracts'
import { resolveId } from './tasks/_shared'

type PanelWithEnabled = WebPanelDefinition & { enabled?: boolean }

export function panelsCommand(): Command {
  const cmd = new Command('panels')
    .description("Manage web panels and a task's panel layout")
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

  // slay panels layout … — the task's panel layout (tabs, groups, columns)
  cmd.addCommand(layoutCommand())

  return cmd
}

// ── slay panels layout … ────────────────────────────────────────────────────

interface LayoutView {
  taskId: string
  layout: TaskLayout
  definitions: Array<{ id: string; name: string; builtin: boolean; enabled: boolean }>
  agentMayChangeLayout: boolean
}

interface LayoutChange {
  taskId: string
  layout: TaskLayout
  instanceId?: string
  existing?: boolean
  parked?: string[]
}

const SPLIT_ZONES = ['left', 'right', 'before', 'after'] as const

/**
 * `--placement`: `column[:<index>]`, `tab:<group-or-panel>[:<index>]`,
 * `split:<group-or-panel>:<left|right|before|after>`, or the JSON object itself.
 * A panel id holds a colon itself (`browser:1a2b3c4d`), so the side / index is the
 * last part.
 */
export function parsePlacement(raw: string): InstancePlacement {
  const text = raw.trim()
  if (text.startsWith('{')) return JSON.parse(text) as InstancePlacement
  const [type, ...rest] = text.split(':')
  if (type === 'column' && rest.length <= 1) {
    if (rest.length === 0 || rest[0] === '') return { type: 'column' }
    if (!/^\d+$/.test(rest[0])) throw new Error(`Bad column index "${rest[0]}" in --placement.`)
    return { type: 'column', index: Number(rest[0]) }
  }
  if (type === 'split' && rest.length >= 2) {
    const zone = rest.at(-1) as (typeof SPLIT_ZONES)[number]
    if (!SPLIT_ZONES.includes(zone))
      throw new Error(`Bad split side "${zone}": use ${SPLIT_ZONES.join(', ')}.`)
    return { type: 'split', slotId: rest.slice(0, -1).join(':'), zone }
  }
  if (type === 'tab' && rest.length >= 1 && rest[0] !== '') {
    const last = rest.at(-1) as string
    if (rest.length >= 2 && /^\d+$/.test(last))
      return { type: 'tab', slotId: rest.slice(0, -1).join(':'), index: Number(last) }
    return { type: 'tab', slotId: rest.join(':') }
  }
  throw new Error(
    `Bad --placement "${raw}": use column[:<index>], tab:<group-or-panel>[:<index>] or split:<group-or-panel>:<side>.`
  )
}

/** The layout as text: columns, their groups, each group's tabs (panel id, kind, name). */
export function formatLayout(view: LayoutView): string {
  const { layout } = view
  const lines = [`Layout: ${layout.layoutId} (rev ${layout.rev})`]
  layout.columns.forEach((column, ci) => {
    const size = column.sizeOverride ?? column.size
    lines.push(`Column ${ci + 1}  ${column.id}  ${size.value}${size.unit}`)
    for (const slot of column.slots) {
      const flags = [slot.name ? `"${slot.name}"` : '', slot.hidden ? 'hidden' : '']
        .filter(Boolean)
        .join(' ')
      lines.push(`  Group ${slot.id}${flags ? `  ${flags}` : ''}`)
      for (const tab of slot.tabs) {
        const inst = layout.instances[tab.instanceId]
        const marks = [
          slot.activeInstanceId === tab.instanceId ? 'active' : '',
          tab.parked ? 'parked' : tab.hidden ? 'hidden' : ''
        ]
          .filter(Boolean)
          .join(', ')
        const name = inst?.name ? ` "${inst.name}"` : ''
        const url = inst?.settings.url
        const artifact = inst?.settings.artifactId
        const extra =
          typeof url === 'string' && url !== ''
            ? `  ${url}`
            : typeof artifact === 'string'
              ? `  artifact ${artifact}`
              : ''
        lines.push(
          `    ${tab.instanceId.padEnd(22)} ${(inst?.kind ?? '?').padEnd(11)}${name}${extra}${marks ? `  (${marks})` : ''}`
        )
      }
    }
  })
  const layouts = view.definitions
    .map((d) => `${d.id}${d.id === layout.layoutId ? '*' : ''}${d.enabled ? '' : ' (off)'}`)
    .join(', ')
  lines.push(`Layouts: ${layouts}`)
  lines.push(`Agents may change the layout: ${view.agentMayChangeLayout ? 'yes' : 'no'}`)
  return lines.join('\n')
}

const withTask = (c: Command): Command =>
  c.option('-t, --task <id>', 'Task id or prefix (default: $SLAYZONE_TASK_ID)')

async function layoutPath(task: string | undefined, sub: string): Promise<string> {
  const id = await resolveId(task)
  return `/api/tasks/${encodeURIComponent(id)}/${sub}`
}

function printChange(change: LayoutChange, json: boolean | undefined, what: string): void {
  if (json) {
    console.log(JSON.stringify(change, null, 2))
    return
  }
  console.log(what)
  if (change.parked && change.parked.length > 0)
    console.log(`Parked (kept, hidden): ${change.parked.join(', ')}`)
}

function failUsage(message: string): never {
  console.error(message)
  process.exit(1)
}

export function layoutCommand(): Command {
  const cmd = new Command('layout')
    .description("Show or change a task's panel layout: tabs in groups, groups in columns")
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  withTask(cmd.command('show'))
    .description('Show the layout: columns, groups, panel ids, and the layouts `apply` takes')
    .option('--json', 'Output as JSON')
    .action(async (opts: { task?: string; json?: boolean }) => {
      const { data } = await apiGet<{ ok: true; data: LayoutView }>(
        await layoutPath(opts.task, 'layout')
      )
      console.log(opts.json ? JSON.stringify(data, null, 2) : formatLayout(data))
    })

  withTask(cmd.command('apply <layout>'))
    .description(
      'Switch to a layout by id or name, or apply a whole layout from a .json file (- = stdin; `show --json` output works). Panels with live state are parked, never lost.'
    )
    .option('--json', 'Output as JSON')
    .action(async (layout: string, opts: { task?: string; json?: boolean }) => {
      let body: Record<string, unknown> = { layoutId: layout }
      if (layout === '-' || layout.endsWith('.json')) {
        const fs = await import('node:fs')
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(fs.readFileSync(layout === '-' ? 0 : layout, 'utf-8')) as Record<
            string,
            unknown
          >
        } catch (err) {
          failUsage(`Could not read the layout: ${err instanceof Error ? err.message : err}`)
        }
        body = { layout: (parsed.layout as Record<string, unknown> | undefined) ?? parsed }
      }
      const { data } = await apiPut<{ ok: true; data: LayoutChange }>(
        await layoutPath(opts.task, 'layout'),
        body
      )
      printChange(data, opts.json, `Applied layout ${data.layout.layoutId}`)
    })

  withTask(cmd.command('open <kind>'))
    .description(
      'Open a panel: agent, terminal, browser, web, editor, artifacts, artifact, git, processes, settings, description, subtasks, details'
    )
    .option(
      '--settings <json>',
      `Panel settings as JSON: {"url":"…"} (web page), {"artifactId":"…"} (artifact), {"provider":"codex"} (agent)`
    )
    .option(
      '--placement <where>',
      'column[:<index>] (default), tab:<group-or-panel>[:<index>], split:<group-or-panel>:<left|right|before|after>'
    )
    .option('--name <name>', 'Tab name')
    .option('--json', 'Output as JSON')
    .action(
      async (
        kind: string,
        opts: {
          task?: string
          settings?: string
          placement?: string
          name?: string
          json?: boolean
        }
      ) => {
        const body: Record<string, unknown> = { kind }
        if (opts.settings !== undefined) {
          try {
            body.settings = JSON.parse(opts.settings)
          } catch {
            failUsage(`--settings is not valid JSON: ${opts.settings}`)
          }
        }
        if (opts.placement !== undefined) {
          try {
            body.placement = parsePlacement(opts.placement)
          } catch (err) {
            failUsage(err instanceof Error ? err.message : String(err))
          }
        }
        if (opts.name !== undefined) body.name = opts.name
        const { data } = await apiPost<{ ok: true; data: LayoutChange }>(
          await layoutPath(opts.task, 'panels'),
          body
        )
        printChange(
          data,
          opts.json,
          data.existing ? `Showed panel ${data.instanceId}` : `Opened panel ${data.instanceId}`
        )
      }
    )

  withTask(cmd.command('hide <instanceId>'))
    .description("Hide a panel in place (its whole group when it is the group's last shown tab)")
    .option('--json', 'Output as JSON')
    .action(async (instanceId: string, opts: { task?: string; json?: boolean }) => {
      const { data } = await apiPatch<{ ok: true; data: LayoutChange }>(
        await layoutPath(opts.task, `panels/${encodeURIComponent(instanceId)}`),
        { hidden: true }
      )
      printChange(data, opts.json, `Hid panel ${instanceId}`)
    })

  withTask(cmd.command('close <instanceId>'))
    .description(
      'Close a panel. The first panel of a kind (terminal, browser, editor, diff, …) only hides.'
    )
    .option('--json', 'Output as JSON')
    .action(async (instanceId: string, opts: { task?: string; json?: boolean }) => {
      const { data } = await apiDelete<{ ok: true; data: LayoutChange }>(
        await layoutPath(opts.task, `panels/${encodeURIComponent(instanceId)}`)
      )
      const gone = !data.layout.instances[instanceId]
      printChange(data, opts.json, gone ? `Closed panel ${instanceId}` : `Hid panel ${instanceId}`)
    })

  return cmd
}
