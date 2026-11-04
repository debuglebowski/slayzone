import { Command } from 'commander'
import { apiFetch, apiGet, apiPost } from '../api'
import { resolveId } from './tasks/_shared'
import { EXIT_PROMPT, refuseSelfWait } from './chat'

/**
 * `slay agent` — drive a task's MAIN agent whatever it runs in: a chat tab
 * (`slay chat`) or a terminal (`slay pty`). For orchestrators that should not
 * care which mode a subtask uses. Exit codes as `slay chat wait`:
 * 0 settled, 1 error / not running, 2 timeout, 3 waiting on a prompt (chat).
 */

interface AgentOpts {
  task?: string
}

const enc = encodeURIComponent

async function agentPath(
  opts: AgentOpts,
  sub: string,
  query: Record<string, string | number | undefined> = {}
): Promise<string> {
  const task = await resolveId(opts.task)
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v))
  const qs = params.toString()
  return `/api/agent/${enc(task)}/${sub}${qs ? `?${qs}` : ''}`
}

interface AgentWait {
  kind: 'chat' | 'pty'
  outcome: 'idle' | 'prompt' | 'dead' | 'error' | 'timeout'
  state?: string
  status?: { state: string; pendingRequestIds: string[] } | null
  error?: string
}

function exitFor(result: AgentWait, json: boolean): never {
  if (json) console.log(JSON.stringify(result, null, 2))
  else if (result.outcome === 'idle') console.log('idle')
  else if (result.outcome === 'prompt') console.log('waiting on a prompt — see `slay chat prompts`')
  else if (result.outcome === 'timeout')
    console.error(`Timeout: still ${result.status?.state ?? result.state ?? 'unknown'}`)
  else if (result.outcome === 'dead') console.error('The agent is not running')
  else console.error(`Error: ${result.error ?? 'turn failed'}`)
  process.exit(
    result.outcome === 'idle'
      ? 0
      : result.outcome === 'prompt'
        ? EXIT_PROMPT
        : result.outcome === 'timeout'
          ? 2
          : 1
  )
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

const withTask = (cmd: Command) =>
  cmd.option('-t, --task <id>', 'Task id or prefix (default: $SLAYZONE_TASK_ID)')

export function agentCommand(): Command {
  const cmd = new Command('agent')
    .description(
      "Drive a task's main agent, chat or terminal alike (start, send, wait, read, interrupt)"
    )
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  withTask(cmd.command('status'))
    .description('Show the agent: kind (chat|pty), mode, state, pending prompts')
    .option('--json', 'Output as JSON')
    .action(async (opts: AgentOpts & { json?: boolean }) => {
      const { data } = await apiGet<{ ok: true; data: Record<string, unknown> }>(
        await agentPath(opts, 'status')
      )
      if (opts.json) console.log(JSON.stringify(data, null, 2))
      else for (const [k, v] of Object.entries(data)) console.log(`${k.padEnd(16)} ${v}`)
    })

  withTask(cmd.command('start'))
    .description('Start the agent without sending a message (no-op if already running)')
    .option('--json', 'Output as JSON')
    .action(async (opts: AgentOpts & { json?: boolean }) => {
      const { data } = await apiPost<{ ok: true; data: { kind: string; started: boolean } }>(
        await agentPath(opts, 'start'),
        {}
      )
      if (opts.json) console.log(JSON.stringify(data, null, 2))
      else console.log(data.started ? 'started' : 'already running')
    })

  withTask(cmd.command('send [text]'))
    .description('Send a message (chat: queued; terminal: submitted), starting the agent if needed')
    .option('--steer', 'Chat: take it into the running turn now')
    .option('--wait', 'Then wait until the agent settles')
    .option('--timeout <ms>', 'Timeout for --wait in milliseconds', '600000')
    .option('--json', 'Output as JSON')
    .action(
      async (
        text: string | undefined,
        opts: AgentOpts & { steer?: boolean; wait?: boolean; timeout: string; json?: boolean }
      ) => {
        if (!text) text = await readStdin()
        if (!text.trim()) {
          console.error('Nothing to send')
          process.exit(1)
        }
        if (opts.wait) refuseSelfWait(await resolveId(opts.task), undefined)
        const { data } = await apiPost<{ ok: true; data: Record<string, unknown> }>(
          await agentPath(opts, 'send'),
          { text, ...(opts.steer ? { steer: true } : {}) }
        )
        if (!opts.wait) {
          if (opts.json) console.log(JSON.stringify(data, null, 2))
          return
        }
        // A terminal turn starts asynchronously: give it a beat to leave idle.
        if (data.kind === 'pty') await new Promise((r) => setTimeout(r, 1500))
        const { data: waited } = await apiGet<{ ok: true; data: AgentWait }>(
          await agentPath(opts, 'wait', { timeout: parseInt(opts.timeout, 10) })
        )
        exitFor(waited, opts.json === true)
      }
    )

  withTask(cmd.command('wait'))
    .description('Wait until the agent settles (0), asks (3), dies (1) or timeout (2)')
    .option('--timeout <ms>', 'Timeout in milliseconds', '600000')
    .option('--json', 'Output as JSON')
    .action(async (opts: AgentOpts & { timeout: string; json?: boolean }) => {
      refuseSelfWait(await resolveId(opts.task), undefined)
      const { data } = await apiGet<{ ok: true; data: AgentWait }>(
        await agentPath(opts, 'wait', { timeout: parseInt(opts.timeout, 10) })
      )
      exitFor(data, opts.json === true)
    })

  withTask(cmd.command('read'))
    .description('Print what the agent said: chat transcript, or the terminal buffer')
    .option('--last <n>', 'Only the last N rows (chat) / lines (terminal)')
    .option('-v, --verbose', 'Chat: include thinking, tool results, notices')
    .action(async (opts: AgentOpts & { last?: string; verbose?: boolean }) => {
      const res = await apiFetch(
        await agentPath(opts, 'read', { last: opts.last, verbose: opts.verbose ? 1 : undefined })
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        console.error(body.error ?? `HTTP ${res.status}`)
        process.exit(1)
      }
      process.stdout.write(await res.text())
    })

  withTask(cmd.command('interrupt'))
    .description('Stop the running turn (chat: interrupt; terminal: Ctrl-C)')
    .action(async (opts: AgentOpts) => {
      const { data } = await apiPost<{ ok: true; data: { interrupted: boolean } }>(
        await agentPath(opts, 'interrupt'),
        {}
      )
      console.log(data.interrupted ? 'interrupted' : 'nothing to interrupt')
    })

  return cmd
}
