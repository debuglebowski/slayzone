/**
 * The demo's terminal agent (Codex, on "Search endpoint"): what its terminal printed so
 * far, as the chunks a hub's pty buffer holds (`pty.attach`), and what the demo writes
 * back when the user types into it — no process runs, so typed input is echoed and
 * answered with a note instead of reaching an agent.
 */

/** The size the session runs at (the phone never resizes it). */
export const DEMO_TERMINAL_SIZE = { cols: 64, rows: 26 } as const

const ESC = '\x1b['
const reset = `${ESC}0m`
const bold = (s: string) => `${ESC}1m${s}${reset}`
const dim = (s: string) => `${ESC}2m${s}${reset}`
const green = (s: string) => `${ESC}32m${s}${reset}`
const yellow = (s: string) => `${ESC}33m${s}${reset}`
const orange = (s: string) => `${ESC}38;5;208m${s}${reset}`
const cyan = (s: string) => `${ESC}36m${s}${reset}`

const line = (s = '') => `${s}\r\n`

/** The recorded output, one chunk per burst the agent printed. */
export function searchTerminalChunks(folder: string): string[] {
  return [
    line(`${green('●')} ${bold('OpenAI Codex')} ${dim('v0.1')}`) +
      line(`  ${dim(folder)}`) +
      line(dim('─'.repeat(44))) +
      line(),
    line(`${orange('›')} add full-text search to /api/v2/search`) + line(),
    line(`${green('Codex')} ${dim('Indexing schema and building search handler…')}`) + line(),
    line(`${dim('$')} psql -f migrations/0042_search_trgm.sql`) +
      line(dim('CREATE EXTENSION')) +
      line(dim('CREATE INDEX')) +
      line(),
    line(`${yellow('src/routes/search.ts')} ${dim('— created')}`) +
      line(`${yellow('src/utils/indexer.ts')} ${dim('— created')}`) +
      line(`${yellow('src/routes/index.ts')}  ${dim('— +2 −0')}`) +
      line(),
    line(`${green('✓')} Full-text search with trigram index`) + line(),
    line(`${orange('›')} add ranking tests, exact title match first`) + line(),
    line(`${yellow('src/routes/search.test.ts')} ${dim('— +64 −3')}`) + line(),
    line(`${dim('$')} pnpm vitest run src/routes/search.test.ts`) +
      line(` ${green('✓')} ranks an exact title match first`) +
      line(` ${green('✓')} falls back to trigram similarity`) +
      line(` ${green('✓')} answers 400 for an empty query`) +
      line(` ${green('✓')} round-trips the cursor`),
    line(`${cyan('◐')} Running the rest of the suite… ${dim('(esc to interrupt)')}`)
  ]
}

/** The prompt line typed input is echoed on. */
export const TERMINAL_PROMPT = `\r\n${orange('›')} `

/** What the demo prints when a line typed into the terminal is submitted. */
export function terminalNote(): string {
  return `\r\n${dim('(demo) No agent runs in the demo — on your own hub this goes to Codex.')}\r\n`
}

export const TERMINAL_INTERRUPTED = `\r\n${yellow('■')} Interrupted\r\n`
export const TERMINAL_STOPPED = `\r\n${dim('[process exited]')}\r\n`
export const TERMINAL_STARTED = `\r\n${green('●')} ${bold('OpenAI Codex')} ${dim('resumed')}\r\n`
