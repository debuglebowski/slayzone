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

test('transitionOnInput is not explicitly false (TUI default → Enter flips to running)', () => {
  // Claude is hook-driven with no silence-timer fallback. The TUI default
  // keeps the Enter → 'running' flip for instant feedback before the
  // UserPromptSubmit hook lands; an explicit `false` would drop that.
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
