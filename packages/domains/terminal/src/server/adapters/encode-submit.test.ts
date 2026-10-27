/**
 * Tests for adapter.encodeSubmit per-mode wire encoding.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/domains/terminal/src/server/adapters/encode-submit.test.ts
 */
import { expect, test } from 'vitest'
import { ClaudeAdapter } from './claude-adapter'
import { CodexAdapter } from './codex-adapter'
import { ShellAdapter } from './shell-adapter'
import { defaultEncodeSubmit } from './types'
import { KITTY_SHIFT_ENTER } from '@slayzone/terminal/shared'

// --- defaultEncodeSubmit ---

test('default: single line gets CR appended', () => {
  expect(defaultEncodeSubmit('hello')).toBe('hello\r')
})

test('default: trailing LF stripped, single CR appended', () => {
  expect(defaultEncodeSubmit('hello\n')).toBe('hello\r')
})

test('default: trailing CRLF stripped', () => {
  expect(defaultEncodeSubmit('hello\r\n')).toBe('hello\r')
})

test('default: multiple trailing newlines all stripped', () => {
  expect(defaultEncodeSubmit('hello\n\n\n')).toBe('hello\r')
})

test('default: internal LF passthrough', () => {
  expect(defaultEncodeSubmit('a\nb')).toBe('a\nb\r')
})

test('default: empty string yields lone CR', () => {
  expect(defaultEncodeSubmit('')).toBe('\r')
})

// --- ClaudeAdapter ---

const claude = new ClaudeAdapter()

test('claude: single line gets CR', () => {
  expect(claude.encodeSubmit('hello')).toBe('hello\r')
})

test('claude: internal LF becomes Kitty Shift+Enter', () => {
  expect(claude.encodeSubmit('line1\nline2')).toBe(`line1${KITTY_SHIFT_ENTER}line2\r`)
})

test('claude: trailing LF stripped before encoding', () => {
  expect(claude.encodeSubmit('line1\nline2\n')).toBe(`line1${KITTY_SHIFT_ENTER}line2\r`)
})

test('claude: multiple internal LFs each encoded', () => {
  expect(claude.encodeSubmit('a\nb\nc')).toBe(`a${KITTY_SHIFT_ENTER}b${KITTY_SHIFT_ENTER}c\r`)
})

// --- Other adapters bind defaultEncodeSubmit ---

test('codex: uses default encoding', () => {
  const codex = new CodexAdapter()
  expect(codex.encodeSubmit('hello\n')).toBe('hello\r')
})

test('shell: uses default encoding', () => {
  const shell = new ShellAdapter()
  expect(shell.encodeSubmit('ls -la\n')).toBe('ls -la\r')
})
