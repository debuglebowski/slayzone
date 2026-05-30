/**
 * Tests for ClaudeAdapter activity detection
 * Run with: npx tsx packages/domains/terminal/src/main/adapters/claude-adapter.test.ts
 */
import { ClaudeAdapter } from './claude-adapter'

const adapter = new ClaudeAdapter()

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.log(`✗ ${name}`)
    console.error(`  ${e}`)
    process.exitCode = 1
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toEqual(expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
      }
    }
  }
}

console.log('\nClaudeAdapter config\n')

test('hookDriven is true — Enter does NOT optimistically flip to running', () => {
  // Claude is fully hook-driven (UserPromptSubmit/Stop). The optimistic
  // Enter → 'running' flip is suppressed: a local slash command (/status)
  // fires no hook and Infinity leaves no silence-timer to undo a wrong flip →
  // the spinner would stick on 'running' forever. Hooks are the sole 'running'
  // signal. transitionOnInput stays at the TUI default (idle-clock semantics
  // unchanged); hookDriven is what suppresses the flip.
  expect(adapter.hookDriven).toBe(true)
  expect(adapter.transitionOnInput !== false).toBe(true)
})

test('idleTimeoutMs is Infinity — no silence-timer fallback (hook-driven)', () => {
  // Hook events (Stop, Notification, SessionEnd) drive running→idle;
  // detectActivity catches the user-interrupt marker. There is no time-based
  // fallback — it only ever misfired (a long Bash run tripped a false
  // running→idle mid-turn). Infinity makes the inactivity checker skip this
  // adapter (shouldFlipToIdle: `now - t >= Infinity` is always false).
  expect(adapter.idleTimeoutMs).toBe(Infinity)
})

console.log('\nClaudeAdapter.detectActivity\n')

test('detectActivity ignores spinner/completion text — hooks are the source of truth', () => {
  // Legacy bullet/spinner regex was retired in favor of Claude Code hooks
  // (see rest-api/agent-hook.ts + notify.sh). detectActivity must return
  // null for these spinner-style outputs so the state machine is hook-driven.
  expect(adapter.detectActivity('· Thinking...', 'unknown')).toBe(null)
  expect(adapter.detectActivity('✻ Clauding...', 'unknown')).toBe(null)
  expect(adapter.detectActivity('·\x1b[1CBefuddling…', 'unknown')).toBe(null)
  expect(adapter.detectActivity('✻ Cooked for 56s', 'unknown')).toBe(null)
  expect(adapter.detectActivity('· Cogitated for 4m 24s', 'unknown')).toBe(null)
  expect(adapter.detectActivity('Some random text', 'unknown')).toBe(null)
})

test('detectActivity matches the user-interrupt marker → idle', () => {
  // Claude does NOT fire the Stop hook when the user presses ESC during the
  // pure thinking phase. The TUI prints `⎿  Interrupted · What should Claude
  // do instead?` after the interrupt — that line is the evidence-based signal
  // that claude actually stopped. Match anchors on the ⎿ box-drawing glyph
  // (U+23BF) + literal "Interrupted" so generic uses of the word elsewhere
  // (e.g. user prompt content, log files) don't false-trigger.
  expect(adapter.detectActivity('⎿  Interrupted · What should Claude do instead?', 'unknown'))
    .toBe('idle')
  // ANSI-wrapped marker still matches (claude colors the glyph red).
  expect(adapter.detectActivity('\x1b[38;2;153;153;153m  ⎿  Interrupted · What\x1b[39m', 'unknown'))
    .toBe('idle')
  // Word "Interrupted" alone (no ⎿ glyph) does NOT match — avoids false
  // positives from user prompt content or unrelated log output.
  expect(adapter.detectActivity('the build was Interrupted by ctrl-c', 'unknown')).toBe(null)
  expect(adapter.detectActivity('Interrupted', 'unknown')).toBe(null)
})

console.log('\nClaudeAdapter.detectError\n')

test('detectError flags the unrecoverable resume failure (SESSION_NOT_FOUND)', () => {
  // `claude --resume <id>` against a session claude no longer has prints this.
  // It produces no distinct exit signal, so output detection is the only hook.
  const result = adapter.detectError('No conversation found with session ID: abc-123')
  expect(result?.code).toBe('SESSION_NOT_FOUND')
  expect(result?.recoverable).toBe(false)
})

test('detectError ignores replayed tool-error history on resume', () => {
  // `claude --resume` replays the prior transcript to the TTY. A historical
  // tool_result (is_error:true) renders as a line starting "Error: ...". That
  // is in-band agent content, NOT a CLI crash — the old generic `^Error:`
  // matcher flipped the freshly-resumed agent to 'error' on every reopen
  // (confirmed: tool failure "Error: Exit code 1\nTask not found: …"). Real
  // claude crashes are caught by non-zero exit code (shell_fallback), not here.
  expect(adapter.detectError('Error: Exit code 1\nTask not found: 6f2f6f88')).toBe(null)
  // ANSI-wrapped replay still ignored.
  expect(adapter.detectError('\x1b[31mError: something the tool printed\x1b[0m')).toBe(null)
  // Mid-line "Error:" (e.g. inside normal prose / logs) never matched anyway.
  expect(adapter.detectError('the command returned Error: boom')).toBe(null)
})

console.log('\nClaudeAdapter.detectPrompt\n')

test('detects Y/n as permission prompt', () => {
  const result = adapter.detectPrompt('Allow? [Y/n]')
  expect(result?.type).toBe('permission')
})

test('detects numbered menu as input prompt', () => {
  const data = `Choose:
❯ 1. Option A
  2. Option B`
  const result = adapter.detectPrompt(data)
  expect(result?.type).toBe('input')
})

test('detects question', () => {
  const result = adapter.detectPrompt('What file should I edit?')
  expect(result?.type).toBe('question')
})

console.log('\nDone\n')
