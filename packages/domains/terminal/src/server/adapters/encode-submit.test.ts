/**
 * Tests for adapter.encodeSubmit per-mode wire encoding.
 * Run with: npx tsx packages/domains/terminal/src/main/adapters/encode-submit.test.ts
 */
import { ClaudeAdapter } from './claude-adapter'
import { CodexAdapter } from './codex-adapter'
import { ShellAdapter } from './shell-adapter'
import { defaultEncodeSubmit } from './types'
import { KITTY_SHIFT_ENTER } from '@slayzone/terminal/shared'

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.log(`✗ ${name}`)
    console.error(`  ${e}`)
    process.exitCode = 1
  }
}

function expectEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// --- defaultEncodeSubmit ---

test('default: single line gets CR appended', () => {
  expectEqual(defaultEncodeSubmit('hello'), 'hello\r')
})

test('default: trailing LF stripped, single CR appended', () => {
  expectEqual(defaultEncodeSubmit('hello\n'), 'hello\r')
})

test('default: trailing CRLF stripped', () => {
  expectEqual(defaultEncodeSubmit('hello\r\n'), 'hello\r')
})

test('default: multiple trailing newlines all stripped', () => {
  expectEqual(defaultEncodeSubmit('hello\n\n\n'), 'hello\r')
})

test('default: internal LF passthrough', () => {
  expectEqual(defaultEncodeSubmit('a\nb'), 'a\nb\r')
})

test('default: empty string yields lone CR', () => {
  expectEqual(defaultEncodeSubmit(''), '\r')
})

// --- ClaudeAdapter ---

const claude = new ClaudeAdapter()

test('claude: single line gets CR', () => {
  expectEqual(claude.encodeSubmit('hello'), 'hello\r')
})

test('claude: internal LF becomes Kitty Shift+Enter', () => {
  expectEqual(claude.encodeSubmit('line1\nline2'), `line1${KITTY_SHIFT_ENTER}line2\r`)
})

test('claude: trailing LF stripped before encoding', () => {
  expectEqual(claude.encodeSubmit('line1\nline2\n'), `line1${KITTY_SHIFT_ENTER}line2\r`)
})

test('claude: multiple internal LFs each encoded', () => {
  expectEqual(claude.encodeSubmit('a\nb\nc'), `a${KITTY_SHIFT_ENTER}b${KITTY_SHIFT_ENTER}c\r`)
})

// --- Other adapters bind defaultEncodeSubmit ---

test('codex: uses default encoding', () => {
  const codex = new CodexAdapter()
  expectEqual(codex.encodeSubmit('hello\n'), 'hello\r')
})

test('shell: uses default encoding', () => {
  const shell = new ShellAdapter()
  expectEqual(shell.encodeSubmit('ls -la\n'), 'ls -la\r')
})
