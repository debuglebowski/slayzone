/**
 * Tests for CodexAdapter activity detection
 * Run with: npx tsx packages/domains/terminal/src/main/adapters/codex-adapter.test.ts
 */
import { CodexAdapter } from './codex-adapter'

const adapter = new CodexAdapter()

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
    }
  }
}

console.log('\nCodexAdapter.detectActivity (hook-driven; only approval modal → idle)\n')

test('"esc to interrupt" → null (working is hook-driven via UserPromptSubmit/PreToolUse)', () => {
  const data = '• Planning typecheck and minor updates (3m 37s • esc to interrupt)'
  expect(adapter.detectActivity(data, 'unknown')).toBe(null)
})

test('"esc to interrupt" with ANSI codes → null', () => {
  const data = '\x1b[1m• Planning\x1b[0m (1m 2s • \x1b[2mesc to interrupt\x1b[0m)'
  expect(adapter.detectActivity(data, 'unknown')).toBe(null)
})

test('alternative interrupt-hint phrases → null', () => {
  expect(adapter.detectActivity('Escape to cancel', 'unknown')).toBe(null)
  expect(adapter.detectActivity('Ctrl+C to stop', 'unknown')).toBe(null)
})

test('plain output → null', () => {
  expect(adapter.detectActivity('Some random text', 'unknown')).toBe(null)
})

test('whitespace-only output → null', () => {
  expect(adapter.detectActivity('   \n\r  ', 'working')).toBe(null)
})

console.log('\nCodexAdapter.detectActivity (modal → idle)\n')

const EXEC_MODAL = [
  'Allow Electron-as-Node to load native better-sqlite3 outside sandbox for DB test diagnosis?',
  '  1. Yes',
  "  2. Yes, and don't ask again for commands that start with `ELECTRON_RUN_AS_NODE=1 npx electron`",
  '  3. No, and tell Codex what to do differently'
].join('\n')

const PATCH_MODAL = [
  'Would you like to make the following edits?',
  '  1. Yes, proceed',
  "  2. Yes, and don't ask again for these files",
  '  3. No, and tell Codex what to do differently'
].join('\n')

const PERMS_MODAL = [
  'Would you like to grant these permissions?',
  '  1. Yes, grant these permissions for this turn',
  '  2. Yes, grant these permissions for this session',
  '  3. No, continue without permissions'
].join('\n')

const TRUST_MODAL = [
  'Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.',
  '  1. Yes, continue',
  '  2. No, quit'
].join('\n')

const MCP_MODAL = [
  'context7 needs your approval.',
  '  1. Yes, provide the requested info',
  '  2. No, but continue without it'
].join('\n')

test('exec approval modal → idle', () => {
  expect(adapter.detectActivity(EXEC_MODAL, 'working')).toBe('idle')
})

test('patch approval modal → idle', () => {
  expect(adapter.detectActivity(PATCH_MODAL, 'working')).toBe('idle')
})

test('permissions modal → idle', () => {
  expect(adapter.detectActivity(PERMS_MODAL, 'working')).toBe('idle')
})

test('trust directory modal → idle', () => {
  expect(adapter.detectActivity(TRUST_MODAL, 'working')).toBe('idle')
})

test('MCP elicitation modal → idle', () => {
  expect(adapter.detectActivity(MCP_MODAL, 'working')).toBe('idle')
})

test('approval modal → idle even with an interrupt hint present', () => {
  const data = `${EXEC_MODAL}\n• Editing files (5s • esc to interrupt)`
  expect(adapter.detectActivity(data, 'unknown')).toBe('idle')
})

test('plain output without modal markers → null', () => {
  expect(adapter.detectActivity('  1. one\n  2. two\n  3. three', 'unknown')).toBe(null)
})

console.log('\nCodexAdapter config\n')

test('transitionOnInput is default (TUI adapter — Enter flips to running)', () => {
  // Hook-driven like ClaudeAdapter, no silence-timer fallback. TUI default
  // keeps the Enter → 'running' flip for instant feedback before the
  // UserPromptSubmit hook lands.
  expect(adapter.transitionOnInput !== false).toBe(true)
})

test('idleTimeoutMs is Infinity — no silence-timer fallback (hook-driven)', () => {
  // Hooks drive running→idle; the approval-modal check in detectActivity
  // covers lagging hooks. No time-based fallback — Infinity makes the
  // inactivity checker skip this adapter.
  expect(adapter.idleTimeoutMs).toBe(Infinity)
})

console.log('\nCodexAdapter.detectPrompt\n')

test('exec modal returns permission prompt', () => {
  const p = adapter.detectPrompt(EXEC_MODAL)
  expect(p?.type).toBe('permission')
})

test('patch modal returns permission prompt', () => {
  const p = adapter.detectPrompt(PATCH_MODAL)
  expect(p?.type).toBe('permission')
})

test('permissions modal returns permission prompt', () => {
  const p = adapter.detectPrompt(PERMS_MODAL)
  expect(p?.type).toBe('permission')
})

test('trust modal returns permission prompt', () => {
  const p = adapter.detectPrompt(TRUST_MODAL)
  expect(p?.type).toBe('permission')
})

test('MCP modal returns permission prompt', () => {
  const p = adapter.detectPrompt(MCP_MODAL)
  expect(p?.type).toBe('permission')
})

test('detectPrompt handles ANSI sequences in modal', () => {
  const ansi = `\x1b[3m${EXEC_MODAL.split('\n')[0]}\x1b[23m\n\x1b[39;48;2;65;69;76m  2. Yes, and don't ask again for commands that start with \`x\`\x1b[0m\n  3. No, and tell Codex what to do differently`
  expect(adapter.detectPrompt(ansi)?.type).toBe('permission')
})

test('detectPrompt ignores plain output', () => {
  expect(adapter.detectPrompt('Just running some command output')).toBe(null)
})

test('detectPrompt ignores numbered list without modal title/deny', () => {
  // Numbered list of TODOs etc. — must not false-positive
  expect(adapter.detectPrompt('Steps:\n  1. compile\n  2. test\n  3. ship')).toBe(null)
})

test('detectPrompt ignores working indicator alone', () => {
  expect(adapter.detectPrompt('• Planning (3m 37s • esc to interrupt)')).toBe(null)
})

console.log('\nCodexAdapter.detectError\n')

test('detects stale codex resume session as SESSION_NOT_FOUND', () => {
  const result = adapter.detectError(
    'ERROR: No saved session found with ID 019c7a76-280a-7dc0-8af6-affe6cf174b2'
  )
  expect(result?.code).toBe('SESSION_NOT_FOUND')
})

test('detects generic codex error line', () => {
  const result = adapter.detectError('ERROR: Something went wrong')
  expect(result?.code).toBe('CLI_ERROR')
  expect(result?.message).toBe('Something went wrong')
})

console.log('\nCodexAdapter.detectConversationId\n')

test('extracts UUID from real /status box-drawing output', () => {
  const data = `╭────────────────────────────────────────────────────────────────────────────────╮
│  >_ OpenAI Codex (v0.118.0)                                                    │
│                                                                                │
│  Model:                gpt-5.4 (reasoning high, summaries auto)                │
│  Directory:            ~/dev/projects/slayzone                                 │
│  Permissions:          Custom (workspace-write, on-request)                    │
│  Session:              019d5014-bedf-7363-a87f-f476d22053d4                    │
│                                                                                │
│  5h limit:             [█████████████████░░░] 84% left (resets 01:23 on 3 Apr) │
╰────────────────────────────────────────────────────────────────────────────────╯`
  expect(adapter.detectConversationId(data)).toBe('019d5014-bedf-7363-a87f-f476d22053d4')
})

test('extracts UUID from plain Session: line', () => {
  expect(adapter.detectConversationId('Session: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  )
})

test('extracts UUID from rollout filename format', () => {
  expect(
    adapter.detectConversationId('rollout-1234567890-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
  ).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
})

test('falls back to bare UUID when label is mangled by TUI artifacts', () => {
  // Real TUI output may have cursor positioning between label and UUID
  const data = '\rSession:\r\n019d5014-bedf-7363-a87f-f476d22053d4\r\n'
  expect(adapter.detectConversationId(data)).toBe('019d5014-bedf-7363-a87f-f476d22053d4')
})

test('returns null when no session ID present', () => {
  expect(adapter.detectConversationId('Model: gpt-5.4\nDirectory: ~/dev\n')).toBe(null)
})

test('handles ANSI codes in session line', () => {
  const data = '\x1b[1mSession:\x1b[0m  019d5014-bedf-7363-a87f-f476d22053d4'
  expect(adapter.detectConversationId(data)).toBe('019d5014-bedf-7363-a87f-f476d22053d4')
})

console.log('\nDone\n')
