import { Command } from 'commander'
import { apiGet, apiPost, apiDelete, apiFetch } from '../api'
import { openDb } from '../db'

interface PtyInfo {
  sessionId: string
  taskId: string
  tabId: string
  label: string | null
  mode: string
  state: string
  createdAt: number
  lastOutputTime: number
}

function resolveSession(sessions: PtyInfo[], idPrefix: string): PtyInfo {
  const matches = sessions.filter(s => s.sessionId.startsWith(idPrefix))
  if (matches.length === 0) {
    console.error(`PTY session not found: ${idPrefix}`)
    process.exit(1)
  }
  if (matches.length > 1) {
    console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${matches.map(s => s.sessionId).join(', ')}`)
    process.exit(1)
  }
  return matches[0]
}

function encodedId(sessionId: string): string {
  return encodeURIComponent(sessionId)
}

function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  return `${hr}h${min % 60}m`
}

async function waitForState(sessionId: string, state: string, timeout: number): Promise<void> {
  const res = await apiFetch(`/api/pty/${encodedId(sessionId)}/wait?state=${state}&timeout=${timeout}`)
  if (res.ok) return
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string; state?: string }
  if (res.status === 408) {
    console.error(`Timeout: session still "${body.state}" after ${timeout}ms`)
    process.exit(2)
  }
  if (res.status === 410) {
    console.error('Session died while waiting')
    process.exit(1)
  }
  console.error(body.error ?? `Failed to wait: HTTP ${res.status}`)
  process.exit(1)
}

export function ptyCommand(): Command {
  const cmd = new Command('pty')
    .description('List and interact with PTY sessions')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // slay pty list
  cmd
    .command('list')
    .description('List all active PTY sessions')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const sessions = await apiGet<PtyInfo[]>('/api/pty')

      if (opts.json) {
        console.log(JSON.stringify(sessions, null, 2))
        return
      }

      if (sessions.length === 0) {
        console.log('No PTY sessions.')
        return
      }

      const idW = 24
      const taskW = 12
      const titleW = 20
      const modeW = 14
      const stateW = 10
      console.log(`${'SESSION'.padEnd(idW)}  ${'TASK'.padEnd(taskW)}  ${'TITLE'.padEnd(titleW)}  ${'MODE'.padEnd(modeW)}  ${'STATE'.padEnd(stateW)}  AGE`)
      console.log(`${'-'.repeat(idW)}  ${'-'.repeat(taskW)}  ${'-'.repeat(titleW)}  ${'-'.repeat(modeW)}  ${'-'.repeat(stateW)}  ${'-'.repeat(6)}`)
      const now = Date.now()
      for (const s of sessions) {
        const id = s.sessionId.padEnd(idW)
        const task = s.taskId.slice(0, taskW).padEnd(taskW)
        const title = (s.label ?? '').slice(0, titleW).padEnd(titleW)
        const mode = s.mode.slice(0, modeW).padEnd(modeW)
        const state = s.state.padEnd(stateW)
        const age = formatAge(now - s.createdAt)
        console.log(`${id}  ${task}  ${title}  ${mode}  ${state}  ${age}`)
      }
    })

  // slay pty buffer <id>
  cmd
    .command('buffer <id>')
    .description('Dump the terminal buffer for a PTY session (id prefix supported)')
    .action(async (idPrefix) => {
      const sessions = await apiGet<PtyInfo[]>('/api/pty')
      const session = resolveSession(sessions, idPrefix)
      const res = await apiFetch(`/api/pty/${encodedId(session.sessionId)}/buffer`)
      if (!res.ok) {
        console.error(`Failed to get buffer: ${res.status}`)
        process.exit(1)
      }
      process.stdout.write(await res.text())
    })

  // slay pty follow <id>
  cmd
    .command('follow <id>')
    .description('Stream PTY output in real time (id prefix supported)')
    .option('--full', 'Replay existing buffer before streaming live output')
    .action(async (idPrefix, opts) => {
      const sessions = await apiGet<PtyInfo[]>('/api/pty')
      const session = resolveSession(sessions, idPrefix)
      const query = opts.full ? '?full=true' : ''
      const res = await apiFetch(`/api/pty/${encodedId(session.sessionId)}/follow${query}`)

      if (!res.ok || !res.body) {
        console.error(`Failed to follow PTY: ${res.status}`)
        process.exit(1)
      }

      const decoder = new TextDecoder()
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        const text = decoder.decode(chunk)
        for (const line of text.split('\n')) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6)
            try {
              process.stdout.write(JSON.parse(payload) as string)
            } catch {
              process.stdout.write(payload)
            }
          } else if (line.startsWith('event: exit')) {
            process.exit(0)
          }
        }
      }
    })

  // slay pty type <id> <data>  (alias: write)
  cmd
    .command('type <id> <data>')
    .alias('write')
    .description('Send raw bytes to PTY stdin — no newline, no encoding (id prefix supported)')
    .action(async (idPrefix, data) => {
      const sessions = await apiGet<PtyInfo[]>('/api/pty')
      const session = resolveSession(sessions, idPrefix)
      await apiPost<{ ok: boolean }>(`/api/pty/${encodedId(session.sessionId)}/write`, { data })
    })

  // Key helper subcommands — each sends a specific control sequence
  const KEYS: Record<string, string> = {
    'arrow-up': '\x1b[A',
    'arrow-down': '\x1b[B',
    'arrow-right': '\x1b[C',
    'arrow-left': '\x1b[D',
    tab: '\t',
    'shift-tab': '\x1b[Z',
    backspace: '\x7f',
    escape: '\x1b',
    cancel: '\x03',
  }
  for (const [name, seq] of Object.entries(KEYS)) {
    cmd
      .command(`${name} <id>`)
      .description(`Send ${name} key to PTY stdin (id prefix supported)`)
      .action(async (idPrefix: string) => {
        const sessions = await apiGet<PtyInfo[]>('/api/pty')
        const session = resolveSession(sessions, idPrefix)
        await apiPost<{ ok: boolean }>(`/api/pty/${encodedId(session.sessionId)}/write`, { data: seq })
      })
  }

  // slay pty submit <id> [text]
  cmd
    .command('submit <id> [text]')
    .description('Submit text to PTY — adapter handles per-mode encoding (id prefix supported)')
    .option('--wait', 'Wait for idle state before sending (default for AI modes)')
    .option('--no-wait', 'Send immediately without waiting')
    .option('--timeout <ms>', 'Timeout for --wait in milliseconds', '60000')
    .action(async (idPrefix, text: string | undefined, opts: { wait?: boolean; timeout: string }) => {
      const sessions = await apiGet<PtyInfo[]>('/api/pty')
      // Cold-task fallback: if prefix doesn't match a live session, try
      // resolving it as a task id — server auto-spawns the main PTY on submit.
      const liveMatches = sessions.filter(s => s.sessionId.startsWith(idPrefix))
      let sessionId: string
      let mode: string
      if (liveMatches.length >= 1) {
        const session = resolveSession(sessions, idPrefix)
        sessionId = session.sessionId
        mode = session.mode
      } else {
        const taskId = await resolveTaskIdPrefix(idPrefix)
        sessionId = `${taskId}:${taskId}`
        // Cold task → mode unknown client-side; server reads from task row.
        // Default to 'terminal' for the wait decision below.
        mode = 'terminal'
      }

      // Default: wait for AI modes (anything that's not the plain shell)
      const shouldWait = opts.wait ?? mode !== 'terminal'

      // Read from stdin if no text argument
      if (!text) {
        const chunks: Buffer[] = []
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
        text = Buffer.concat(chunks).toString('utf-8')
      }

      if (shouldWait) {
        await waitForState(sessionId, 'idle', parseInt(opts.timeout, 10))
      }

      // Per-mode wire encoding (Kitty Shift+Enter, plain CR, etc.) lives in the
      // adapter on the server. CLI just hands over the raw text.
      await apiPost<{ ok: boolean }>(`/api/pty/${encodedId(sessionId)}/submit`, { text })
    })

  // slay pty wait <id>
  cmd
    .command('wait <id>')
    .description('Wait for a PTY session to reach a specific state (id prefix supported)')
    .option('--state <state>', 'Target state to wait for', 'idle')
    .option('--timeout <ms>', 'Timeout in milliseconds', '60000')
    .option('--json', 'Output as JSON')
    .action(async (idPrefix, opts: { state: string; timeout: string; json?: boolean }) => {
      const sessions = await apiGet<PtyInfo[]>('/api/pty')
      const session = resolveSession(sessions, idPrefix)
      const res = await apiFetch(`/api/pty/${encodedId(session.sessionId)}/wait?state=${opts.state}&timeout=${opts.timeout}`)
      const body = await res.json().catch(() => ({})) as { state?: string; waited?: boolean; error?: string }

      if (opts.json) {
        console.log(JSON.stringify({ ok: res.ok, ...body }, null, 2))
        if (!res.ok) process.exit(res.status === 408 ? 2 : 1)
        return
      }

      if (res.ok) {
        console.log(body.waited ? `Reached "${body.state}"` : `Already "${body.state}"`)
      } else if (res.status === 408) {
        console.error(`Timeout: still "${body.state}" after ${opts.timeout}ms`)
        process.exit(2)
      } else if (res.status === 410) {
        console.error('Session died while waiting')
        process.exit(1)
      } else {
        console.error(body.error ?? `HTTP ${res.status}`)
        process.exit(1)
      }
    })

  // slay pty respawn <task-id>
  cmd
    .command('respawn <task-id>')
    .description('Respawn a task\'s main PTY (kill + remount). Task must be open in app. Task-id prefix supported')
    .action(async (taskIdPrefix: string) => {
      // Resolve task id via active sessions when possible (gives prefix matching).
      // Falls back to raw value so respawning a task with no live PTY still works.
      const sessions = await apiGet<PtyInfo[]>('/api/pty')
      const matches = [...new Set(sessions.filter(s => s.taskId.startsWith(taskIdPrefix)).map(s => s.taskId))]
      let taskId = taskIdPrefix
      if (matches.length === 1) {
        taskId = matches[0]
      } else if (matches.length > 1) {
        console.error(`Ambiguous task-id prefix "${taskIdPrefix}". Matches: ${matches.join(', ')}`)
        process.exit(1)
      }
      await apiPost<{ ok: boolean }>('/api/pty/respawn', { taskId })
      console.log(`Respawn requested: ${taskId}`)
    })

  // slay pty start <task-id>
  cmd
    .command('start <task-id>')
    .description("Start a task's main PTY (idempotent — no-op if alive). Task-id prefix supported")
    .option('--no-wait', 'Return immediately without waiting for the PTY to spawn')
    .option('--timeout <ms>', 'Wait timeout in milliseconds', '5000')
    .action(async (taskIdPrefix: string, opts: { wait?: boolean; timeout: string }) => {
      // Resolve prefix from tasks table — `pty start` works on cold tasks
      // (no live session) so the live-session prefix match used by other verbs
      // wouldn't find anything.
      const taskId = await resolveTaskIdPrefix(taskIdPrefix)
      const timeoutMs = opts.wait === false ? 0 : parseInt(opts.timeout, 10)
      const r = await apiPost<{ ok: boolean; alreadyAlive?: boolean; sessionId?: string }>(
        '/api/pty/start',
        { taskId, timeoutMs }
      )
      if (r.alreadyAlive) console.log(`Already alive: ${r.sessionId}`)
      else console.log(`Started: ${r.sessionId}`)
    })

  // slay pty kill <id>
  cmd
    .command('kill <id>')
    .description('Kill a PTY session (id prefix supported)')
    .action(async (idPrefix) => {
      const sessions = await apiGet<PtyInfo[]>('/api/pty')
      const session = resolveSession(sessions, idPrefix)
      await apiDelete<{ ok: boolean }>(`/api/pty/${encodedId(session.sessionId)}`)
      console.log(`Killed: ${session.sessionId}`)
    })

  // slay pty rename <id> <label>
  cmd
    .command('rename <id> <label>')
    .description('Rename a terminal tab. Empty string clears the title.')
    .action(async (idPrefix: string, label: string) => {
      const sessions = await apiGet<PtyInfo[]>('/api/pty')
      const session = resolveSession(sessions, idPrefix)
      if (!session.tabId) {
        console.error(`Session has no associated tab: ${session.sessionId}`)
        process.exit(1)
      }
      const { tab } = await apiPost<{ tab: { id: string; label: string | null } }>(
        '/api/tabs/rename',
        { id: session.tabId, label }
      )
      console.log(`Renamed ${session.sessionId} → ${tab.label === null ? '(cleared)' : tab.label}`)
    })

  // slay pty create <task-id>
  cmd
    .command('create <task-id>')
    .description('Create a new terminal tab (new group) for a task. Auto-opens task in app')
    .option('--mode <mode>', 'Terminal mode (terminal, claude-code, codex, ...)', 'terminal')
    .option('--label <label>', 'Tab label')
    .option('--no-wait', 'Return immediately without waiting for the PTY to spawn')
    .option('--timeout <ms>', 'Wait timeout in milliseconds', '5000')
    .action(async (taskId: string, opts: { mode: string; label?: string; wait?: boolean; timeout: string }) => {
      const body: Record<string, string> = { taskId, mode: opts.mode }
      if (opts.label) body.label = opts.label
      const result = await apiPost<{ tab: { id: string }; sessionId: string }>('/api/tabs/create', body)

      if (opts.wait !== false) {
        await waitForSession(result.sessionId, parseInt(opts.timeout, 10))
      }
      console.log(result.sessionId)
    })

  // slay pty split <session-id-or-tab-id>
  cmd
    .command('split <id>')
    .description('Split: add a new pane to the same group as the target tab/session (id prefix supported)')
    .option('--no-wait', 'Return immediately without waiting for the PTY to spawn')
    .option('--timeout <ms>', 'Wait timeout in milliseconds', '5000')
    .action(async (idPrefix: string, opts: { wait?: boolean; timeout: string }) => {
      // Accept either full session id (taskId:tabId) or tab id alone. If a colon
      // is present, strip everything before it (= taskId) — splitTabRow only
      // needs the tab id since it derives task + group from the row.
      let tabId = idPrefix.includes(':') ? idPrefix.split(':').slice(1).join(':') : idPrefix

      // Resolve prefix via active sessions when possible.
      const sessions = await apiGet<PtyInfo[]>('/api/pty')
      const matches = sessions.filter(s => {
        const parts = s.sessionId.split(':')
        const t = parts.length > 1 ? parts.slice(1).join(':') : parts[0]
        return t.startsWith(tabId)
      })
      if (matches.length === 1) {
        const parts = matches[0].sessionId.split(':')
        tabId = parts.length > 1 ? parts.slice(1).join(':') : parts[0]
      } else if (matches.length > 1) {
        console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${matches.map(s => s.sessionId).join(', ')}`)
        process.exit(1)
      }

      const result = await apiPost<{ tab: { id: string }; sessionId: string }>('/api/tabs/split', { tabId })

      if (opts.wait !== false) {
        await waitForSession(result.sessionId, parseInt(opts.timeout, 10))
      }
      console.log(result.sessionId)
    })

  return cmd
}

async function resolveTaskIdPrefix(prefix: string): Promise<string> {
  const db = openDb()
  const rows = db.query<{ id: string }>(
    `SELECT id FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': prefix }
  )
  db.close()
  if (rows.length === 0) {
    console.error(`Task not found: ${prefix}`)
    process.exit(1)
  }
  if (rows.length > 1) {
    console.error(`Ambiguous task-id prefix "${prefix}". Matches: ${rows.map(r => r.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }
  return rows[0].id
}

async function waitForSession(sessionId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const sessions = await apiGet<PtyInfo[]>('/api/pty')
    if (sessions.some(s => s.sessionId === sessionId)) return
    await new Promise(r => setTimeout(r, 100))
  }
  console.error(`Timeout: PTY session ${sessionId} did not appear within ${timeoutMs}ms`)
  process.exit(2)
}
