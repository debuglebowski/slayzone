import { Command } from 'commander'
import { apiGet, apiDelete, apiFetch, apiPost } from '../api'

interface ProcessInfo {
  id: string
  taskId: string | null
  label: string
  command: string
  status: string
  pid: number | null
  exitCode: number | null
  startedAt: string
}

interface StartResponse {
  ok: true
  id: string
  pid: number | null
  status: string
}

/** Resolve an id prefix to exactly one process, or exit 1. */
async function resolveProcess(idPrefix: string): Promise<ProcessInfo> {
  const procs = await apiGet<ProcessInfo[]>('/api/processes')
  const matches = procs.filter((p) => p.id.startsWith(idPrefix))
  if (matches.length === 0) {
    console.error(`Process not found: ${idPrefix}`)
    process.exit(1)
  }
  if (matches.length > 1) {
    console.error(
      `Ambiguous id prefix "${idPrefix}". Matches: ${matches.map((p) => p.id.slice(0, 8)).join(', ')}`
    )
    process.exit(1)
  }
  return matches[0]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function parseMs(value: string, flag: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    console.error(`${flag} must be a non-negative number of milliseconds, got "${value}"`)
    process.exit(1)
  }
  return n
}

/**
 * `--wait`: the run counts as up once it has stayed running, under the same pid,
 * for `settleMs`. It exiting (or auto-restarting under a new pid) first is a
 * failure: the last log lines are printed and the CLI exits 1.
 */
async function waitUntilUp(
  id: string,
  pid: number | null,
  settleMs: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + Math.max(timeoutMs, settleMs)
  const upAt = Date.now() + settleMs
  for (;;) {
    const proc = (await apiGet<ProcessInfo[]>('/api/processes')).find((p) => p.id === id)
    const failed = !proc
      ? 'it no longer exists'
      : proc.status !== 'running'
        ? `status is ${proc.status}${proc.exitCode != null ? ` (exit code ${proc.exitCode})` : ''}`
        : pid != null && proc.pid !== pid
          ? `it exited and was auto-restarted (pid ${pid} → ${proc.pid ?? 'none'})`
          : null
    if (failed) {
      console.error(`Process ${id.slice(0, 8)} did not stay up: ${failed}`)
      const data = await apiGet<{ logs: string[] }>(`/api/processes/${id}/logs`).catch(() => null)
      const tail = data?.logs.slice(-20) ?? []
      if (tail.length > 0)
        console.error(`--- last ${tail.length} log lines ---\n${tail.join('\n')}`)
      process.exit(1)
    }
    if (Date.now() >= upAt) return
    if (Date.now() >= deadline) {
      console.error(`Timed out waiting for process ${id.slice(0, 8)}`)
      process.exit(1)
    }
    await sleep(Math.min(250, Math.max(0, upAt - Date.now())))
  }
}

function addStartCommand(
  cmd: Command,
  name: 'start' | 'restart',
  description: string,
  verb: string
): void {
  cmd
    .command(`${name} <id>`)
    .description(description)
    .option('--wait', 'Wait until it stays running (see --settle); exit 1 if it exits first')
    .option('--settle <ms>', 'With --wait: how long it must stay running', '2000')
    .option('--timeout <ms>', 'With --wait: give up after this long', '30000')
    .option('--json', 'Output as JSON')
    .action(async (idPrefix, opts) => {
      const settleMs = parseMs(opts.settle, '--settle')
      const timeoutMs = parseMs(opts.timeout, '--timeout')
      const proc = await resolveProcess(idPrefix)
      const res = await apiPost<StartResponse>(`/api/processes/${proc.id}/${name}`, {})
      if (opts.wait) await waitUntilUp(proc.id, res.pid, settleMs, timeoutMs)
      if (opts.json) {
        console.log(
          JSON.stringify({ id: res.id, label: proc.label, pid: res.pid, status: res.status })
        )
        return
      }
      console.log(`${verb}: ${proc.id.slice(0, 8)}  ${proc.label}  pid ${res.pid ?? '-'}`)
    })
}

export function processesCommand(): Command {
  const cmd = new Command('processes')
    .description('List, inspect, start, stop and restart managed processes')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // slay processes list
  cmd
    .command('list')
    .description('List all processes managed by the running app')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const procs = await apiGet<ProcessInfo[]>('/api/processes')

      if (opts.json) {
        console.log(JSON.stringify(procs, null, 2))
        return
      }

      if (procs.length === 0) {
        console.log('No processes.')
        return
      }

      const idW = 9
      const statusW = 10
      const pidW = 7
      const labelW = 20
      console.log(
        `${'ID'.padEnd(idW)}  ${'STATUS'.padEnd(statusW)}  ${'PID'.padEnd(pidW)}  ${'LABEL'.padEnd(labelW)}  COMMAND`
      )
      console.log(
        `${'-'.repeat(idW)}  ${'-'.repeat(statusW)}  ${'-'.repeat(pidW)}  ${'-'.repeat(labelW)}  ${'-'.repeat(30)}`
      )
      for (const p of procs) {
        const id = p.id.slice(0, 8).padEnd(idW)
        const status = p.status.padEnd(statusW)
        const pid = String(p.pid ?? '-').padEnd(pidW)
        const label = p.label.slice(0, labelW).padEnd(labelW)
        console.log(`${id}  ${status}  ${pid}  ${label}  ${p.command}`)
      }
    })

  // slay processes logs <id>
  cmd
    .command('logs <id>')
    .description('Print log output for a process (id prefix supported)')
    .option('-n, --lines <n>', 'Last N lines', '50')
    .action(async (idPrefix, opts) => {
      const proc = await resolveProcess(idPrefix)
      const data = await apiGet<{ id: string; label: string; logs: string[] }>(
        `/api/processes/${proc.id}/logs`
      )
      const lines = parseInt(opts.lines, 10)
      const output = data.logs.slice(-lines)

      if (output.length === 0) {
        console.log('(no output)')
        return
      }

      console.log(output.join('\n'))
    })

  // slay processes start|restart|stop <id>
  addStartCommand(
    cmd,
    'start',
    'Start a stopped process with its stored command/cwd (id prefix supported)',
    'Started'
  )
  addStartCommand(
    cmd,
    'restart',
    'Stop a process (whole tree) and start it again under the same id (id prefix supported)',
    'Restarted'
  )
  cmd
    .command('stop <id>')
    .description('Stop a process and its whole tree; it stays listed (id prefix supported)')
    .action(async (idPrefix) => {
      const proc = await resolveProcess(idPrefix)
      const res = await apiPost<{ status: string }>(`/api/processes/${proc.id}/stop`, {})
      if (res.status !== 'stopped') {
        console.error(
          `Stop incomplete: ${proc.id.slice(0, 8)}  ${proc.label}  status ${res.status} — part of its tree survived`
        )
        process.exit(1)
      }
      console.log(`Stopped: ${proc.id.slice(0, 8)}  ${proc.label}`)
    })

  // slay processes remove <id>
  cmd
    .command('remove <id>')
    .description('Stop a process (whole tree) and remove it from the list (id prefix supported)')
    .action(async (idPrefix) => {
      const proc = await resolveProcess(idPrefix)
      await apiDelete<{ ok: boolean }>(`/api/processes/${proc.id}`)
      console.log(`Removed: ${proc.id.slice(0, 8)}  ${proc.label}`)
    })

  // slay processes follow <id>
  cmd
    .command('follow <id>')
    .description('Stream logs for a process in real time (id prefix supported)')
    .action(async (idPrefix) => {
      const proc = await resolveProcess(idPrefix)
      const res = await apiFetch(`/api/processes/${proc.id}/follow`)

      if (!res.ok || !res.body) {
        console.error(`Failed to follow process: ${res.status}`)
        process.exit(1)
      }

      const contentType = res.headers.get('content-type') ?? ''

      if (!contentType.includes('event-stream')) {
        // Finished process — plain text dump
        console.log(await res.text())
        return
      }

      // SSE stream
      const decoder = new TextDecoder()
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        const text = decoder.decode(chunk)
        for (const line of text.split('\n')) {
          if (line.startsWith('data: ')) process.stdout.write(line.slice(6) + '\n')
        }
      }
    })

  return cmd
}
