/**
 * Chat permission/operating mode shared by main + client. Stored in
 * `provider_config.<terminalMode>.chatMode`. Maps onto `claude --permission-mode`
 * (verified against Claude Code 2.1.312). `ask` is the CLI's `default` mode:
 * chat answers its prompts with approval cards. `dontAsk` (deny anything that
 * would prompt) is not exposed.
 */
export type ChatMode = 'plan' | 'ask' | 'auto-accept' | 'auto' | 'bypass'

/**
 * Map a raw `claude` CLI permission mode (as observed in `system/init.permissionMode`)
 * to our exposed `ChatMode`. Returns null for unmapped values (`dontAsk`) so
 * callers can decide whether to leave existing state untouched. Subprocess is
 * the source of truth: this mapper translates its raw value into our enum.
 * `manual` is 2.1.312's help-text name for `default` (the wire reports `default`).
 */
export function rawPermissionModeToChatMode(raw: string | null | undefined): ChatMode | null {
  switch (raw) {
    case 'plan':
      return 'plan'
    case 'default':
    case 'manual':
      return 'ask'
    case 'acceptEdits':
      return 'auto-accept'
    case 'auto':
      return 'auto'
    case 'bypassPermissions':
      return 'bypass'
    default:
      return null
  }
}

/**
 * Inverse: produce CLI flags for a Claude `ChatMode`. Non-Claude modes
 * (codex-chat carries its policy over the JSON-RPC protocol, not flags)
 * yield no flags — that backend ignores `providerFlags` entirely.
 *
 * `bypass` uses `--permission-mode bypassPermissions`: the older
 * `--allow-dangerously-skip-permissions` only ALLOWS bypass and starts the CLI
 * in `default`.
 */
export function chatModeToFlags(mode: string): string[] {
  switch (mode) {
    case 'plan':
      return ['--permission-mode', 'plan']
    case 'ask':
      return ['--permission-mode', 'default']
    case 'auto-accept':
      return ['--permission-mode', 'acceptEdits']
    case 'auto':
      return ['--permission-mode', 'auto']
    case 'bypass':
      return ['--permission-mode', 'bypassPermissions']
    default:
      return []
  }
}

/**
 * Map our ChatMode to the raw CLI permission_mode string used by the SDK's
 * `control_request {subtype:'set_permission_mode', mode}`. Returns null for
 * `bypass`: switching INTO bypass mid-session needs a process spawned with a
 * bypass flag, so it requires a restart instead.
 */
export function chatModeToCliPermissionMode(mode: string): string | null {
  switch (mode) {
    case 'plan':
      return 'plan'
    case 'ask':
      return 'default'
    case 'auto-accept':
      return 'acceptEdits'
    case 'auto':
      return 'auto'
    default:
      // `bypass` (Claude flag-only) and any non-Claude mode → no live
      // `set_permission_mode` equivalent; caller falls back accordingly.
      return null
  }
}

/**
 * True when the chat pills (mode, model, effort) own those spawn flags: the
 * flag-driven chat provider (Claude). A task's own flags for such a mode are
 * extras appended after them, and terminal-mode default flags are never
 * seeded into its provider_config.
 */
export function chatOwnsSpawnFlags(mode: string): boolean {
  return mode === 'claude-chat'
}

/** Flags the chat pills set, with whether they take a value. */
const CHAT_OWNED_FLAGS: Record<string, boolean> = {
  '--permission-mode': true,
  '--model': true,
  '--effort': true,
  '--dangerously-skip-permissions': false,
  '--allow-dangerously-skip-permissions': false
}

/**
 * Drop the flags the chat pills own from a task's extra flags (both
 * `--flag value` and `--flag=value`), keeping everything else in order.
 */
export function stripChatOwnedFlags(flags: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    const eq = flag.indexOf('=')
    const name = eq === -1 ? flag : flag.slice(0, eq)
    const takesValue = CHAT_OWNED_FLAGS[name]
    if (takesValue === undefined) {
      out.push(flag)
      continue
    }
    if (takesValue && eq === -1) i++
  }
  return out
}
