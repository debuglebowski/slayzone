/**
 * The demo's chat agents' conversations: the events a hub saves for a chat tab
 * (`AgentEvent`, the shapes `chat/__fixtures__/hub-chat-session.json` recorded from a
 * real hub), replayed by `chat.getReplay`. And the demo's answer to a message sent in
 * the demo (`demoReply`): no agent runs, so it says what would happen with a real hub.
 */
import type { AgentEvent, TokenUsage } from '@slayzone/terminal-contracts'

const USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0
}

const TOOLS = ['Task', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'TodoWrite', 'WebFetch', 'Write']

/** Builds one conversation's events, with ids unique within it. */
class Conversation {
  readonly events: AgentEvent[] = []
  private n = 0

  constructor(
    private readonly prefix: string,
    private readonly cwd: string
  ) {}

  private id(kind: string): string {
    this.n++
    return `${this.prefix}-${kind}-${this.n}`
  }

  user(text: string): this {
    const id = this.id('msg')
    this.events.push(
      { kind: 'user-message', id, text, content: [{ type: 'text', text }] },
      { kind: 'user-message-delivery', id, state: 'delivered' },
      {
        kind: 'turn-init',
        sessionId: `${this.prefix}-session`,
        model: 'opus',
        cwd: this.cwd,
        tools: TOOLS,
        permissionMode: 'acceptEdits'
      }
    )
    return this
  }

  thinking(text: string): this {
    this.events.push({
      kind: 'assistant-thinking',
      messageId: this.id('think'),
      text,
      hasSignature: true,
      usage: USAGE
    })
    return this
  }

  say(text: string): this {
    this.events.push({ kind: 'assistant-text', messageId: this.id('text'), text, usage: USAGE })
    return this
  }

  tool(name: string, input: unknown, output: string, isError = false): this {
    const id = this.id('toolu')
    this.events.push(
      { kind: 'tool-call', id, name, input, usage: USAGE },
      { kind: 'tool-result', toolUseId: id, isError, rawContent: output, structured: null }
    )
    return this
  }

  done(text: string, durationMs: number, costUsd: number): this {
    this.events.push({
      kind: 'result',
      subtype: 'success',
      isError: false,
      durationMs,
      durationApiMs: Math.round(durationMs * 0.8),
      numTurns: 1,
      totalCostUsd: costUsd,
      stopReason: 'end_turn',
      terminalReason: null,
      text,
      modelUsage: {},
      usage: USAGE,
      permissionDenials: []
    })
    return this
  }
}

const AUTH_SUMMARY = `Done — every \`/api/v2\` route now goes through one middleware.

- **New** \`src/middleware/require-session.ts\`: reads the cookie, loads the session, sets \`req.session\`; answers the same 401 body as before.
- **Mounted** once in \`src/app.ts\`, before the \`/api/v2\` router.
- **Removed** the copy-pasted checks from \`items.ts\`, \`search.ts\` and \`users.ts\` (−54 lines).

All 42 tests pass, including the 401 snapshot. Ready for review.`

/** "Auth refactor": finished, waiting for the user's review (the task is unread). */
export function authConversation(cwd: string): AgentEvent[] {
  return new Conversation('auth', cwd)
    .user(
      'Move the session checks out of the route handlers into one middleware. Keep the 401 body exactly as it is.'
    )
    .thinking(
      'Find every handler that parses the session cookie, then extract one middleware and mount it once.'
    )
    .say("I'll find where the handlers check the session today.")
    .tool(
      'Grep',
      { pattern: 'parseSessionCookie', path: 'src/routes', output_mode: 'files_with_matches' },
      'src/routes/items.ts\nsrc/routes/search.ts\nsrc/routes/users.ts'
    )
    .tool(
      'Read',
      { file_path: `${cwd}/src/routes/items.ts`, limit: 30 },
      [
        "import { Router } from 'express'",
        "import { parseSessionCookie } from '../session'",
        '',
        'export const items = Router()',
        '',
        "items.get('/', async (req, res) => {",
        '  const session = await parseSessionCookie(req)',
        "  if (!session) return res.status(401).json({ error: 'unauthorized' })",
        '  res.json(await listItems(session.userId, req.query))',
        '})'
      ].join('\n')
    )
    .tool(
      'Write',
      {
        file_path: `${cwd}/src/middleware/require-session.ts`,
        content: [
          "import type { RequestHandler } from 'express'",
          "import { parseSessionCookie } from '../session'",
          '',
          'export const requireSession: RequestHandler = async (req, res, next) => {',
          '  const session = await parseSessionCookie(req)',
          "  if (!session) return res.status(401).json({ error: 'unauthorized' })",
          '  req.session = session',
          '  next()',
          '}'
        ].join('\n')
      },
      `File created successfully at: ${cwd}/src/middleware/require-session.ts`
    )
    .tool(
      'Edit',
      {
        file_path: `${cwd}/src/routes/items.ts`,
        old_string: [
          '  const session = await parseSessionCookie(req)',
          "  if (!session) return res.status(401).json({ error: 'unauthorized' })",
          '  res.json(await listItems(session.userId, req.query))'
        ].join('\n'),
        new_string: '  res.json(await listItems(req.session.userId, req.query))'
      },
      `The file ${cwd}/src/routes/items.ts has been updated.`
    )
    .say('Same change in `search.ts` and `users.ts`, then the middleware is mounted once.')
    .tool(
      'Edit',
      {
        file_path: `${cwd}/src/app.ts`,
        old_string: "app.use('/api/v2', v2)",
        new_string: "app.use('/api/v2', requireSession, v2)"
      },
      `The file ${cwd}/src/app.ts has been updated.`
    )
    .tool(
      'Bash',
      { command: 'pnpm test', description: 'Run the test suite' },
      [
        ' ✓ src/routes/items.test.ts (12 tests) 84ms',
        ' ✓ src/routes/search.test.ts (17 tests) 131ms',
        ' ✓ src/routes/users.test.ts (9 tests) 58ms',
        ' ✓ src/middleware/require-session.test.ts (4 tests) 12ms',
        '',
        ' Test Files  4 passed (4)',
        '      Tests  42 passed (42)'
      ].join('\n')
    )
    .say(AUTH_SUMMARY)
    .done(AUTH_SUMMARY, 94_000, 0.41).events
}

const DARK_SUMMARY = `The dashboard has a dark theme now, and it follows the system setting by default.

1. **Tokens** — \`src/theme/tokens.css\` defines both themes; components only use the tokens.
2. **Toggle** — Settings → Appearance: *System* / *Light* / *Dark*, saved per user.
3. **Charts** — not switched yet: they still hard-code their colours.

Should the charts move to the tokens in this task, or in a follow-up?`

/** "Dark mode": the agent finished and asked a question; the user has seen it. */
export function darkModeConversation(cwd: string): AgentEvent[] {
  return new Conversation('dark', cwd)
    .user(
      'Add dark mode: tokens for both themes and a System / Light / Dark toggle in Settings → Appearance.'
    )
    .say("I'll start from the existing colour variables.")
    .tool(
      'Glob',
      { pattern: 'src/**/*.css' },
      'src/theme/tokens.css\nsrc/components/chart.css\nsrc/pages/settings.css'
    )
    .tool(
      'Edit',
      {
        file_path: `${cwd}/src/theme/tokens.css`,
        old_string: ':root {\n  --background: #ffffff;',
        new_string:
          ':root {\n  --background: #ffffff;\n}\n\n:root[data-theme="dark"] {\n  --background: #0b0d12;'
      },
      `The file ${cwd}/src/theme/tokens.css has been updated.`
    )
    .tool(
      'Write',
      {
        file_path: `${cwd}/src/settings/AppearanceToggle.tsx`,
        content:
          "export function AppearanceToggle() {\n  const [theme, setTheme] = useThemePreference()\n  return <Segmented value={theme} options={['System', 'Light', 'Dark']} onChange={setTheme} />\n}"
      },
      `File created successfully at: ${cwd}/src/settings/AppearanceToggle.tsx`
    )
    .tool(
      'Bash',
      { command: 'pnpm build', description: 'Build the dashboard' },
      'vite v7.1.3 building for production...\n✓ 412 modules transformed.\n✓ built in 3.82s'
    )
    .say(DARK_SUMMARY)
    .done(DARK_SUMMARY, 61_000, 0.27).events
}

/** What the demo answers a message sent to one of its chat agents. */
export function demoReply(text: string): string {
  const quoted = text.length > 120 ? `${text.slice(0, 117)}…` : text
  return [
    'This is the **SlayZone demo**: no agent runs here, so nothing was changed.',
    '',
    `Connected to your own hub, the agent would now start on “${quoted}” on your computer — and you could follow every step here, answer its questions and review the result from your phone.`
  ].join('\n')
}
