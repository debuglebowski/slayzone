import { Command } from 'commander'
import { apiGet, apiPost } from '../api'

function resolveTaskId(): string {
  const id = process.env.SLAYZONE_TASK_ID
  if (!id) {
    console.error('$SLAYZONE_TASK_ID is not set. Run this from a task terminal.')
    process.exit(1)
  }
  return id
}

interface TabRow {
  idx: number
  id: string
  title: string
  url: string
  active: boolean
  registered: boolean
}

async function fetchTabs(taskId: string): Promise<TabRow[]> {
  const { tabs } = await apiGet<{ tabs: TabRow[] }>(`/api/browser/tabs?taskId=${taskId}`)
  return tabs
}

/**
 * Resolve `--tab` value to a tabId.
 *  - All-digits → 0-based index, looked up in /api/browser/tabs.
 *  - Otherwise → opaque tabId, passed through.
 *  - undefined → undefined (server falls back to active tab).
 */
async function resolveTabId(taskId: string, value: string | undefined): Promise<string | undefined> {
  if (value == null) return undefined
  if (!/^\d+$/.test(value)) return value
  const idx = parseInt(value, 10)
  const tabs = await fetchTabs(taskId)
  const match = tabs.find(t => t.idx === idx)
  if (!match) {
    const list = tabs.map(t => `  ${t.idx}: ${t.id}${t.title ? ` — ${t.title}` : ''}`).join('\n')
    console.error(`Tab index ${idx} not found. Available tabs:\n${list || '  (none)'}`)
    process.exit(1)
  }
  return match.id
}

interface CommonOpts { panel?: 'visible' | 'hidden'; tab?: string }

/** Add `--panel` and `--tab` to a subcommand. Commander does not propagate parent options to children. */
function withCommonOpts(c: Command, defaultPanel: 'visible' | 'hidden'): Command {
  return c
    .option('--panel <state>', `Panel visibility: visible or hidden (default: ${defaultPanel})`)
    .option('--tab <idOrIdx>', 'Target tab by 0-based index or opaque tab id (defaults to active tab)')
}

function panel(opts: CommonOpts, fallback: 'visible' | 'hidden'): 'visible' | 'hidden' {
  return opts.panel ?? fallback
}

export function browserCommand(): Command {
  const cmd = new Command('browser')
    .description('Control task browser tabs. Defaults to active tab; use --tab to target another.')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  cmd
    .command('tabs')
    .description('List browser tabs for the current task')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const taskId = resolveTaskId()
      const tabs = await fetchTabs(taskId)
      if (opts.json) {
        console.log(JSON.stringify(tabs, null, 2))
        return
      }
      if (tabs.length === 0) {
        console.log('No browser tabs.')
        return
      }
      for (const t of tabs) {
        const flag = t.active ? '*' : ' '
        const reg = t.registered ? '' : ' (not loaded)'
        const title = t.title ? ` ${t.title}` : ''
        console.log(`${flag} ${t.idx}: ${t.id}${title}  ${t.url}${reg}`)
      }
    })

  withCommonOpts(cmd.command('url'), 'hidden')
    .description('Print current URL')
    .action(async (opts: CommonOpts) => {
      const taskId = resolveTaskId()
      const tabId = await resolveTabId(taskId, opts.tab)
      const qs = new URLSearchParams({ taskId, panel: panel(opts, 'hidden') })
      if (tabId) qs.set('tabId', tabId)
      const { url } = await apiGet<{ url: string }>(`/api/browser/url?${qs}`)
      console.log(url)
    })

  withCommonOpts(cmd.command('navigate <url>'), 'visible')
    .description('Navigate browser to URL')
    .action(async (url: string, opts: CommonOpts) => {
      const taskId = resolveTaskId()
      const tabId = await resolveTabId(taskId, opts.tab)
      const result = await apiPost<{ ok: boolean; url: string }>('/api/browser/navigate', { taskId, url, panel: panel(opts, 'visible'), tabId })
      console.log(result.url)
    })

  withCommonOpts(cmd.command('click <selector>'), 'hidden')
    .description('Click element by CSS selector')
    .action(async (selector: string, opts: CommonOpts) => {
      const taskId = resolveTaskId()
      const tabId = await resolveTabId(taskId, opts.tab)
      const result = await apiPost<{ ok: boolean; tag?: string; text?: string }>('/api/browser/click', { taskId, selector, panel: panel(opts, 'hidden'), tabId })
      console.log(`Clicked: <${result.tag}>${result.text ? ` "${result.text}"` : ''}`)
    })

  withCommonOpts(cmd.command('type <selector> <text>'), 'hidden')
    .description('Type text into input by CSS selector')
    .action(async (selector: string, text: string, opts: CommonOpts) => {
      const taskId = resolveTaskId()
      const tabId = await resolveTabId(taskId, opts.tab)
      await apiPost('/api/browser/type', { taskId, selector, text, panel: panel(opts, 'hidden'), tabId })
      console.log('OK')
    })

  withCommonOpts(cmd.command('eval <code>'), 'hidden')
    .description('Execute JavaScript in browser and print result')
    .action(async (code: string, opts: CommonOpts) => {
      const taskId = resolveTaskId()
      const tabId = await resolveTabId(taskId, opts.tab)
      const { result } = await apiPost<{ ok: boolean; result: unknown }>('/api/browser/eval', { taskId, code, panel: panel(opts, 'hidden'), tabId })
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
    })

  withCommonOpts(cmd.command('content'), 'hidden')
    .description('Get page text content and interactive elements')
    .option('--json', 'Output as JSON')
    .action(async (opts: CommonOpts & { json?: boolean }) => {
      const taskId = resolveTaskId()
      const tabId = await resolveTabId(taskId, opts.tab)
      const qs = new URLSearchParams({ taskId, panel: panel(opts, 'hidden') })
      if (tabId) qs.set('tabId', tabId)
      const result = await apiGet<{ url: string; title: string; text: string; interactive: unknown[] }>(
        `/api/browser/content?${qs}`
      )
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      console.log(`URL:   ${result.url}`)
      console.log(`Title: ${result.title}`)
      console.log()
      console.log(result.text.slice(0, 10000))
      if (result.interactive.length > 0) {
        console.log(`\n--- Interactive elements (${result.interactive.length}) ---`)
        console.log(JSON.stringify(result.interactive, null, 2))
      }
    })

  withCommonOpts(cmd.command('screenshot'), 'hidden')
    .description('Capture screenshot to file')
    .option('-o, --output <path>', 'Output file path')
    .action(async (opts: CommonOpts & { output?: string }) => {
      const taskId = resolveTaskId()
      const tabId = await resolveTabId(taskId, opts.tab)
      const { path } = await apiPost<{ ok: boolean; path: string }>('/api/browser/screenshot', { taskId, panel: panel(opts, 'hidden'), tabId })
      if (opts.output) {
        const { copyFileSync } = await import('fs')
        copyFileSync(path, opts.output)
        console.log(opts.output)
      } else {
        console.log(path)
      }
    })

  return cmd
}
