import { randomUUID } from 'node:crypto'
import { Command } from 'commander'
import { apiDelete, apiFetch, apiGet, apiPost } from '../api'
import { resolveId } from './tasks/_shared'

/**
 * `slay chat` — drive a task's chat-mode agent (claude-chat, codex-chat) over
 * `/api/chat/:id/*`. Every command targets `--task` (id or prefix; default
 * `$SLAYZONE_TASK_ID`) and its main chat tab, or `--tab` for another chat tab.
 *
 * Exit codes (wait, send --wait): 0 settled/answered, 1 error or agent dead,
 * 2 timeout, 3 the agent is waiting on a prompt (`slay chat prompts`).
 */

export const EXIT_PROMPT = 3

interface TargetOpts {
  task?: string
  tab?: string
}

interface WaitResult {
  outcome: 'idle' | 'prompt' | 'answered' | 'dead' | 'error' | 'timeout'
  status: { state: string; pendingRequestIds: string[] } | null
  queued: number
  error?: string
}

interface PromptView {
  requestId: string
  toolName: string
  kind: 'permission' | 'plan' | 'question' | 'codex-question'
  title: string
  subtitle?: string
  question?: string
  options: Array<{ id: string; label: string; needsFeedback: boolean }>
  questions: Array<{
    key: string
    header?: string
    question: string
    options: string[]
    multiSelect: boolean
    allowsOther: boolean
  }>
  input: unknown
}

const enc = encodeURIComponent

function withTargetOptions(cmd: Command): Command {
  return cmd
    .option('-t, --task <id>', 'Task id or prefix (default: $SLAYZONE_TASK_ID)')
    .option('--tab <id>', "Another chat tab of the task (default: the task's main tab)")
}

async function chatPath(
  opts: TargetOpts,
  sub: string,
  query: Record<string, string | number | boolean | undefined> = {},
  { tabInQuery = true }: { tabInQuery?: boolean } = {}
): Promise<string> {
  const task = await resolveId(opts.task)
  const params = new URLSearchParams()
  if (tabInQuery && opts.tab) params.set('tab', opts.tab)
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v))
  const qs = params.toString()
  return `/api/chat/${enc(task)}/${sub}${qs ? `?${qs}` : ''}`
}

const bodyTab = (opts: TargetOpts) => (opts.tab ? { tab: opts.tab } : {})

/**
 * An agent waiting on its OWN chat turn would wait forever (its turn is open
 * while it runs this command). Refuse when the caller is the chat agent of the
 * very tab it targets.
 */
export function refuseSelfWait(task: string, tab: string | undefined): void {
  const own = process.env.SLAYZONE_TASK_ID
  if (!own || !own.startsWith(task) || (tab && tab !== own)) return
  let mode: unknown
  try {
    mode = (JSON.parse(process.env.SLAYZONE_AGENT_HOOK_CONTEXT ?? '{}') as { mode?: unknown }).mode
  } catch {
    mode = undefined
  }
  const agent = process.env.SLAYZONE_AGENT_ID ?? ''
  const isChatAgent =
    (typeof mode === 'string' && mode.endsWith('-chat')) || agent.endsWith('-chat')
  if (!isChatAgent) return
  console.error(
    'Refusing to wait on your own chat turn: it stays open while this command runs. Target another task (--task) or tab (--tab).'
  )
  process.exit(1)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

export function exitForOutcome(result: WaitResult, json: boolean): never {
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    const pending = result.status?.pendingRequestIds.length ?? 0
    switch (result.outcome) {
      case 'idle':
        console.log(result.queued ? `idle (${result.queued} queued)` : 'idle')
        break
      case 'answered':
        console.log('answered')
        break
      case 'prompt':
        console.log(
          `waiting on ${pending} prompt${pending === 1 ? '' : 's'} — see \`slay chat prompts\``
        )
        break
      case 'timeout':
        console.error(`Timeout: still ${result.status?.state ?? 'unknown'}`)
        break
      case 'dead':
        console.error('The agent is not running')
        break
      case 'error':
        console.error(`Error: ${result.error ?? 'turn failed'}`)
        break
    }
  }
  const code =
    result.outcome === 'idle' || result.outcome === 'answered'
      ? 0
      : result.outcome === 'prompt'
        ? EXIT_PROMPT
        : result.outcome === 'timeout'
          ? 2
          : 1
  process.exit(code)
}

async function waitFor(
  opts: TargetOpts,
  query: { until: string; message?: string; timeout: number }
): Promise<WaitResult> {
  const res = await apiGet<{ ok: true; data: WaitResult }>(await chatPath(opts, 'wait', query))
  return res.data
}

function printPrompt(p: PromptView): void {
  const head = [p.title, p.subtitle].filter(Boolean).join(' — ')
  console.log(`${p.requestId}  [${p.kind}] ${head}`)
  const input = p.input as Record<string, unknown> | null
  if (p.kind === 'permission' && input) {
    const detail = input.command ?? input.file_path ?? input.url ?? input.path
    if (typeof detail === 'string') console.log(`  ${detail}`)
  }
  if (p.kind === 'plan' && input && typeof input.plan === 'string') {
    for (const line of input.plan.trim().split('\n')) console.log(`  │ ${line}`)
  }
  if (p.question) console.log(`  ${p.question}`)
  for (const o of p.options)
    console.log(`    ${o.id.padEnd(18)} ${o.label}${o.needsFeedback ? '  (needs --message)' : ''}`)
  p.questions.forEach((q, i) => {
    console.log(
      `  ${i + 1}. ${q.header ? `[${q.header}] ` : ''}${q.question}${q.multiSelect ? '  (several)' : ''}`
    )
    q.options.forEach((o, j) => console.log(`       ${j + 1}) ${o}`))
    if (q.allowsOther) console.log('       or type your own answer')
  })
}

export function chatCommand(): Command {
  const cmd = new Command('chat')
    .description("Drive a task's chat-mode agent (send, wait, read, answer prompts, …)")
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  withTargetOptions(cmd.command('status'))
    .description('Show where the chat stands: state, open turn, pending prompts, queue')
    .option('--json', 'Output as JSON')
    .action(async (opts: TargetOpts & { json?: boolean }) => {
      const { data } = await apiGet<{ ok: true; data: Record<string, unknown> }>(
        await chatPath(opts, 'status')
      )
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2))
        return
      }
      for (const [k, v] of Object.entries(data)) if (v !== null) console.log(`${k.padEnd(16)} ${v}`)
    })

  withTargetOptions(cmd.command('send [text]'))
    .description('Send a message (queued like the composer: it waits for the running turn)')
    .option('--steer', 'Take it into the running turn now instead of queueing')
    .option('--wait', 'Wait until the agent answered it (or stops on a prompt)')
    .option('--timeout <ms>', 'Timeout for --wait in milliseconds', '600000')
    .option('--json', 'Output as JSON')
    .action(
      async (
        text: string | undefined,
        opts: TargetOpts & { steer?: boolean; wait?: boolean; timeout: string; json?: boolean }
      ) => {
        if (!text) text = await readStdin()
        if (!text.trim()) {
          console.error('Nothing to send')
          process.exit(1)
        }
        const task = await resolveId(opts.task)
        if (opts.wait) refuseSelfWait(task, opts.tab)
        const messageId = randomUUID()
        const { data } = await apiPost<{
          ok: true
          data: {
            messageId: string
            started: boolean
            steered: boolean | null
            steerError?: string
          }
        }>(await chatPath(opts, 'send', {}, { tabInQuery: false }), {
          text,
          messageId,
          ...(opts.steer ? { steer: true } : {}),
          ...bodyTab(opts)
        })
        if (data.steered === false && !opts.json)
          console.error(`Could not steer (${data.steerError ?? 'refused'}); left in the queue`)
        if (!opts.wait) {
          console.log(opts.json ? JSON.stringify(data, null, 2) : data.messageId)
          return
        }
        exitForOutcome(
          await waitFor(opts, {
            until: 'answered',
            message: data.messageId,
            timeout: parseInt(opts.timeout, 10)
          }),
          opts.json === true
        )
      }
    )

  withTargetOptions(cmd.command('wait'))
    .description(
      'Wait until the turn settles (exit 0), the agent asks (3), dies (1) or timeout (2)'
    )
    .option('--until <what>', 'idle (default) or prompt', 'idle')
    .option('--timeout <ms>', 'Timeout in milliseconds', '600000')
    .option('--json', 'Output as JSON')
    .action(async (opts: TargetOpts & { until: string; timeout: string; json?: boolean }) => {
      if (!['idle', 'prompt'].includes(opts.until)) {
        console.error('--until must be idle or prompt')
        process.exit(1)
      }
      refuseSelfWait(await resolveId(opts.task), opts.tab)
      exitForOutcome(
        await waitFor(opts, { until: opts.until, timeout: parseInt(opts.timeout, 10) }),
        opts.json === true
      )
    })

  withTargetOptions(cmd.command('read'))
    .description('Print the conversation as text (what the chat panel shows)')
    .option('--last <n>', 'Only the last N rows')
    .option('--since <row>', 'Only rows after this row number (see --json)')
    .option('-v, --verbose', 'Include thinking, tool results, notices')
    .option('--json', 'Output rows as JSON ({row, role, text, messageId?})')
    .action(
      async (
        opts: TargetOpts & { last?: string; since?: string; verbose?: boolean; json?: boolean }
      ) => {
        const path = await chatPath(opts, 'transcript', {
          last: opts.last,
          since: opts.since,
          verbose: opts.verbose ? 1 : undefined,
          format: opts.json ? 'json' : undefined
        })
        if (opts.json) {
          const { data } = await apiGet<{ ok: true; data: unknown }>(path)
          console.log(JSON.stringify(data, null, 2))
          return
        }
        const res = await apiFetch(path)
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          console.error(body.error ?? `HTTP ${res.status}`)
          process.exit(1)
        }
        process.stdout.write(await res.text())
      }
    )

  withTargetOptions(cmd.command('follow'))
    .description('Stream the conversation as it happens (rows, prompts, state changes)')
    .option('--since <row>', 'Replay rows after this row first (-1 = whole conversation)')
    .option('-v, --verbose', 'Include thinking, tool results, notices')
    .option('--json', 'One JSON event per line')
    .action(async (opts: TargetOpts & { since?: string; verbose?: boolean; json?: boolean }) => {
      const res = await apiFetch(
        await chatPath(opts, 'follow', { since: opts.since, verbose: opts.verbose ? 1 : undefined })
      )
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        console.error(body.error ?? `HTTP ${res.status}`)
        process.exit(1)
      }
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true })
        let sep: number
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          const event = /^event: (.+)$/m.exec(frame)?.[1]
          const raw = /^data: (.*)$/m.exec(frame)?.[1]
          if (!event || raw === undefined) continue
          const data = JSON.parse(raw) as Record<string, unknown>
          if (opts.json) {
            console.log(JSON.stringify({ event, ...data }))
          } else if (event === 'row') {
            const role = data.role as string
            const prefix =
              role === 'user'
                ? '> '
                : role === 'tool'
                  ? '• '
                  : role === 'status'
                    ? '-- '
                    : role === 'thinking'
                      ? '~ '
                      : ''
            console.log(`${prefix}${String(data.text)}\n`)
          } else if (event === 'prompt') {
            console.log('?? the agent asks:')
            printPrompt(data as unknown as PromptView)
            console.log()
          } else if (event === 'state') {
            if (opts.verbose) console.log(`-- state: ${String(data.state)}`)
          }
          if (event === 'exit') {
            if (!opts.json) console.log('-- the agent exited')
            process.exit(0)
          }
        }
      }
    })

  withTargetOptions(cmd.command('prompts'))
    .description('List the prompts the agent waits on, with their option ids / questions')
    .option('--json', 'Output as JSON')
    .action(async (opts: TargetOpts & { json?: boolean }) => {
      const { data } = await apiGet<{ ok: true; data: PromptView[] }>(
        await chatPath(opts, 'prompts')
      )
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2))
        return
      }
      if (data.length === 0) {
        console.log('No pending prompts.')
        return
      }
      data.forEach((p, i) => {
        if (i) console.log()
        printPrompt(p)
      })
    })

  const respond = async (
    requestId: string,
    opts: TargetOpts & { json?: boolean },
    body: { option?: string; message?: string; answers?: Record<string, string | string[]> }
  ) => {
    const { data } = await apiPost<{ ok: true; data: { requestId: string; optionId: string } }>(
      await chatPath(opts, `prompts/${enc(requestId)}`, {}, { tabInQuery: false }),
      { ...body, ...bodyTab(opts) }
    )
    console.log(opts.json ? JSON.stringify(data, null, 2) : `${data.requestId}: ${data.optionId}`)
  }

  withTargetOptions(cmd.command('respond <requestId> <option>'))
    .description(
      'Answer a prompt with an option id from `slay chat prompts` (or allow/deny/always)'
    )
    .option(
      '-m, --message <text>',
      'Feedback: required by feedback rows; with deny the turn goes on'
    )
    .option('--json', 'Output as JSON')
    .action(
      async (
        requestId: string,
        option: string,
        opts: TargetOpts & { message?: string; json?: boolean }
      ) => respond(requestId, opts, { option, ...(opts.message ? { message: opts.message } : {}) })
    )

  for (const [name, option, description] of [
    ['allow', 'allow', 'Allow a prompt once (the card’s Yes; a plan: approve)'],
    ['always', 'always', 'Allow and don’t ask again (the card’s rule/directory row)'],
    ['deny', 'deny', 'Deny a prompt (with --message: tell the agent what to do instead)']
  ] as const) {
    withTargetOptions(cmd.command(`${name} <requestId>`))
      .description(description)
      .option('-m, --message <text>', 'Feedback sent with the answer')
      .option('--json', 'Output as JSON')
      .action(async (requestId: string, opts: TargetOpts & { message?: string; json?: boolean }) =>
        respond(requestId, opts, { option, ...(opts.message ? { message: opts.message } : {}) })
      )
  }

  withTargetOptions(cmd.command('answer <requestId> [answers...]'))
    .description(
      'Answer a question prompt: one answer per question in order, or --answer "<question|header|n>=<label|n|text>"'
    )
    .option(
      '-a, --answer <pair>',
      'key=value (repeatable; several values: repeat the key)',
      collect,
      []
    )
    .option('--decline', 'Decline the question (the turn goes on)')
    .option('--json', 'Output as JSON')
    .action(
      async (
        requestId: string,
        positional: string[],
        opts: TargetOpts & { answer: string[]; decline?: boolean; json?: boolean }
      ) => {
        if (opts.decline) return respond(requestId, opts, { option: 'decline' })
        const answers: Record<string, string | string[]> = {}
        positional.forEach((v, i) => {
          answers[String(i + 1)] = v
        })
        for (const pair of opts.answer) {
          const eq = pair.indexOf('=')
          if (eq <= 0) {
            console.error(`--answer needs key=value: ${pair}`)
            process.exit(1)
          }
          const key = pair.slice(0, eq)
          const value = pair.slice(eq + 1)
          const prev = answers[key]
          answers[key] =
            prev === undefined ? value : [...(Array.isArray(prev) ? prev : [prev]), value]
        }
        if (Object.keys(answers).length === 0) {
          console.error('Give the answers (positional, or --answer key=value), or --decline')
          process.exit(1)
        }
        return respond(requestId, opts, { answers })
      }
    )

  const simple = (
    name: string,
    description: string,
    print: (data: Record<string, unknown>) => string
  ) =>
    withTargetOptions(cmd.command(name))
      .description(description)
      .option('--json', 'Output as JSON')
      .action(async (opts: TargetOpts & { json?: boolean }) => {
        const { data } = await apiPost<{ ok: true; data: Record<string, unknown> }>(
          await chatPath(opts, name, {}, { tabInQuery: false }),
          bodyTab(opts)
        )
        console.log(opts.json ? JSON.stringify(data, null, 2) : print(data))
      })
  simple('interrupt', 'Stop the running turn (the session and queue stay)', (d) =>
    d.interrupted ? 'interrupted' : 'no turn running'
  )
  simple(
    'stop',
    'The panel’s Stop: clear the queue, stop the turn, pop an unanswered last message back',
    (d) => (d.popped ? `stopped; popped: ${String(d.text)}` : 'stopped')
  )
  simple('restart', 'Restart the agent process (the conversation stays)', () => 'restarted')
  simple('kill', 'Kill the agent process (the conversation stays)', () => 'killed')
  simple(
    'reset',
    'Start a fresh conversation in this tab (history and queue cleared)',
    () => 'reset'
  )
  simple(
    'handoff',
    'Continue this chat in the terminal (claude-chat → claude-code), resuming the conversation',
    (d) => `handed off to ${String(d.mode)}`
  )

  const queue = withTargetOptions(cmd.command('queue'))
    .description('List queued messages')
    .option('--json', 'Output as JSON')
    .action(async (opts: TargetOpts & { json?: boolean }) => {
      const { data } = await apiGet<{
        ok: true
        data: Array<{ id: string; text: string; steering?: boolean }>
      }>(await chatPath(opts, 'queue'))
      if (opts.json) console.log(JSON.stringify(data, null, 2))
      else if (data.length === 0) console.log('Queue is empty.')
      else
        for (const m of data)
          console.log(
            `${m.id}  ${m.steering ? '[steering] ' : ''}${m.text.split('\n')[0].slice(0, 100)}`
          )
    })
  withTargetOptions(queue.command('rm <itemId>'))
    .description('Remove a queued message (id prefix supported)')
    .action(async (itemId: string, opts: TargetOpts) => {
      await apiDelete(await chatPath(opts, `queue/${enc(itemId)}`))
      console.log('removed')
    })
  withTargetOptions(queue.command('steer <itemId>'))
    .description('Take a queued message into the running turn now')
    .action(async (itemId: string, opts: TargetOpts) => {
      await apiPost(
        await chatPath(opts, `queue/${enc(itemId)}/steer`, {}, { tabInQuery: false }),
        bodyTab(opts)
      )
      console.log('steered')
    })
  withTargetOptions(queue.command('clear'))
    .description('Remove every queued message')
    .action(async (opts: TargetOpts) => {
      const { data } = await apiDelete<{ ok: true; data: { removed: number } }>(
        await chatPath(opts, 'queue')
      )
      console.log(`removed ${data.removed}`)
    })

  withTargetOptions(cmd.command('set'))
    .description('Change session settings')
    .option('--permission-mode <mode>', 'Permission mode (e.g. default, auto-accept, plan, bypass)')
    .option('--model <model>', 'Model')
    .option('--effort <effort>', 'Reasoning effort')
    .option('--json', 'Output as JSON')
    .action(
      async (
        opts: TargetOpts & {
          permissionMode?: string
          model?: string
          effort?: string
          json?: boolean
        }
      ) => {
        const { data } = await apiPost<{ ok: true; data: Record<string, unknown> }>(
          await chatPath(opts, 'settings', {}, { tabInQuery: false }),
          {
            ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.effort ? { effort: opts.effort } : {}),
            ...bodyTab(opts)
          }
        )
        if (opts.json) console.log(JSON.stringify(data, null, 2))
        else for (const [k, v] of Object.entries(data)) console.log(`${k.padEnd(16)} ${v}`)
      }
    )

  withTargetOptions(cmd.command('fork <messageId>'))
    .description('Fork a new conversation up to that message’s turn (ids: `slay chat read --json`)')
    .option('--json', 'Output as JSON')
    .action(async (messageId: string, opts: TargetOpts & { json?: boolean }) => {
      const { data } = await apiPost<{ ok: true; data: { conversationId: string } }>(
        await chatPath(opts, 'fork', {}, { tabInQuery: false }),
        { messageId, ...bodyTab(opts) }
      )
      console.log(opts.json ? JSON.stringify(data, null, 2) : `forked: ${data.conversationId}`)
    })

  withTargetOptions(cmd.command('rewind <messageId>'))
    .description('Rewind to a message (ids: `slay chat read --json`)')
    .option('--before', 'Rewind to before the message (edit & resend); default: after it')
    .option('--files', 'Also restore the files the agent changed since')
    .option('--files-only', 'Restore only the files, keep the conversation')
    .option('--preview', 'Show what a file restore would change, change nothing')
    .option('--json', 'Output as JSON')
    .action(
      async (
        messageId: string,
        opts: TargetOpts & {
          before?: boolean
          files?: boolean
          filesOnly?: boolean
          preview?: boolean
          json?: boolean
        }
      ) => {
        const { data } = await apiPost<{ ok: true; data: unknown }>(
          await chatPath(opts, 'rewind', {}, { tabInQuery: false }),
          {
            messageId,
            scope: opts.before ? 'before' : 'after',
            conversation: !opts.filesOnly,
            files: opts.files === true || opts.filesOnly === true,
            ...(opts.preview ? { preview: true } : {}),
            ...bodyTab(opts)
          }
        )
        console.log(JSON.stringify(data, null, opts.json ? 2 : 0))
      }
    )

  return cmd
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}
