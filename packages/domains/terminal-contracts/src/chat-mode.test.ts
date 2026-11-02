import { expect, test } from 'vitest'
import {
  chatModeToCliPermissionMode,
  chatModeToFlags,
  chatOwnsSpawnFlags,
  rawPermissionModeToChatMode,
  stripChatOwnedFlags
} from './chat-mode'
import { chatModesForMode, isValidChatModeForMode } from './chat-mode-catalog'

// Spawn flags verified against Claude Code 2.1.316 (initialize →
// current_permission_mode): `--allow-dangerously-skip-permissions` alone starts
// in `default` and every `--permission-mode` still applies with it;
// `--permission-mode bypassPermissions` alone really bypasses.
test('every Claude chat mode spawns in the CLI mode it names', () => {
  const allow = '--allow-dangerously-skip-permissions'
  expect(chatModeToFlags('ask')).toEqual(['--permission-mode', 'default', allow])
  expect(chatModeToFlags('plan')).toEqual(['--permission-mode', 'plan', allow])
  expect(chatModeToFlags('auto-accept')).toEqual(['--permission-mode', 'acceptEdits', allow])
  expect(chatModeToFlags('auto')).toEqual(['--permission-mode', 'auto', allow])
  expect(chatModeToFlags('bypass')).toEqual(['--permission-mode', 'bypassPermissions'])
})

// 2.1.316: `set_permission_mode bypassPermissions` succeeds on a process
// launched with `--allow-dangerously-skip-permissions`, else `bypass_not_launched`.
test('every Claude chat mode, bypass included, switches live (no restart, no lost turn)', () => {
  expect(chatModeToCliPermissionMode('bypass')).toBe('bypassPermissions')
  expect(chatModeToCliPermissionMode('auto-accept')).toBe('acceptEdits')
})

test('"Ask before edits" is the CLI default mode, both ways (2.1.312 also accepts `manual`)', () => {
  expect(rawPermissionModeToChatMode('default')).toBe('ask')
  expect(rawPermissionModeToChatMode('manual')).toBe('ask')
  expect(chatModeToCliPermissionMode('ask')).toBe('default')
  expect(rawPermissionModeToChatMode('dontAsk')).toBeNull()
})

test('the Claude mode picker offers Ask before edits', () => {
  expect(chatModesForMode('claude-chat')).toEqual(['plan', 'ask', 'auto-accept', 'auto', 'bypass'])
  expect(isValidChatModeForMode('claude-chat', 'ask')).toBe(true)
  expect(isValidChatModeForMode('codex-chat', 'ask')).toBe(false)
})

test('chat owns the permission, model and effort flags of a Claude chat spawn only', () => {
  expect(chatOwnsSpawnFlags('claude-chat')).toBe(true)
  expect(chatOwnsSpawnFlags('codex-chat')).toBe(false)
  expect(chatOwnsSpawnFlags('claude-code')).toBe(false)
})

test("stripChatOwnedFlags keeps a user's extra flags and drops the ones the chat pills own", () => {
  expect(
    stripChatOwnedFlags([
      '--allow-dangerously-skip-permissions',
      '--add-dir',
      '../shared',
      '--permission-mode',
      'plan',
      '--model=opus',
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--dangerously-skip-permissions',
      '--verbose'
    ])
  ).toEqual(['--add-dir', '../shared', '--verbose'])
  expect(stripChatOwnedFlags(['--permission-mode=acceptEdits', '--effort=low'])).toEqual([])
})
