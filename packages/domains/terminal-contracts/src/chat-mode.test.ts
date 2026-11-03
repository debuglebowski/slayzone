import { expect, test } from 'vitest'
import {
  chatModeToCliPermissionMode,
  chatModeToFlags,
  chatOwnsSpawnFlags,
  claudeRefusesBypass,
  rawPermissionModeToChatMode,
  stripChatOwnedFlags
} from './chat-mode'
import {
  chatModesForMode,
  defaultChatModeForMode,
  defaultChatModeSettingKey,
  isValidChatModeForMode,
  resolveDefaultChatMode
} from './chat-mode-catalog'

// Spawn flags verified against Claude Code 2.1.316 (initialize →
// current_permission_mode): `--allow-dangerously-skip-permissions` alone starts
// in `default` and every `--permission-mode` still applies with it;
// `--permission-mode bypassPermissions` alone really bypasses.
test('every Claude chat mode spawns in the CLI mode it names, allowing a live bypass switch', () => {
  const allow = '--allow-dangerously-skip-permissions'
  const ok = { allowBypass: true }
  expect(chatModeToFlags('ask', ok)).toEqual(['--permission-mode', 'default', allow])
  expect(chatModeToFlags('plan', ok)).toEqual(['--permission-mode', 'plan', allow])
  expect(chatModeToFlags('auto-accept', ok)).toEqual(['--permission-mode', 'acceptEdits', allow])
  expect(chatModeToFlags('auto', ok)).toEqual(['--permission-mode', 'auto', allow])
  expect(chatModeToFlags('bypass', ok)).toEqual(['--permission-mode', 'bypassPermissions'])
})

// 2.1.317 `setup()`: `if (mode === 'bypassPermissions' || allowDangerouslySkipPermissions)`
// under uid 0 without IS_SANDBOX=1 → "cannot be used with root/sudo" + exit 1.
// The allow flag on a non-bypass mode killed every chat send on a root computer.
test('where the CLI refuses bypass, no non-bypass mode carries the allow flag', () => {
  const no = { allowBypass: false }
  expect(chatModeToFlags('ask', no)).toEqual(['--permission-mode', 'default'])
  expect(chatModeToFlags('plan', no)).toEqual(['--permission-mode', 'plan'])
  expect(chatModeToFlags('auto-accept', no)).toEqual(['--permission-mode', 'acceptEdits'])
  expect(chatModeToFlags('auto', no)).toEqual(['--permission-mode', 'auto'])
  // Bypass itself is the user's explicit choice: the CLI's own refusal surfaces.
  expect(chatModeToFlags('bypass', no)).toEqual(['--permission-mode', 'bypassPermissions'])
})

test('the CLI refuses bypass for root only, unless it runs in a declared sandbox', () => {
  expect(claudeRefusesBypass({ uid: 0, env: {} })).toBe(true)
  expect(claudeRefusesBypass({ uid: 0, env: { IS_SANDBOX: 'true' } })).toBe(true)
  expect(claudeRefusesBypass({ uid: 0, env: { IS_SANDBOX: '1' } })).toBe(false)
  expect(claudeRefusesBypass({ uid: 501, env: {} })).toBe(false)
  // Windows: no uid, no root guard.
  expect(claudeRefusesBypass({ uid: null, env: {} })).toBe(false)
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

// A user-set default (Settings → Providers) replaces the built-in default for
// tasks that never picked a mode; an invalid or foreign value falls back.
test('resolveDefaultChatMode: valid stored default wins, else the built-in one', () => {
  expect(resolveDefaultChatMode('claude-chat', 'bypass')).toBe('bypass')
  expect(resolveDefaultChatMode('codex-chat', 'full-access')).toBe('full-access')
  expect(resolveDefaultChatMode('claude-chat', null)).toBe(defaultChatModeForMode('claude-chat'))
  expect(resolveDefaultChatMode('claude-chat', 'full-access')).toBe('auto-accept')
  expect(resolveDefaultChatMode('codex-chat', 'bypass')).toBe('auto-accept-edits')
  expect(defaultChatModeSettingKey('claude-chat')).toBe('chat_default_mode:claude-chat')
})
