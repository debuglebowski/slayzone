/**
 * Chat permission/operating mode shared by main + client. Stored in
 * `provider_config.<terminalMode>.chatMode`. The full set of CLI permission
 * modes accepted by `claude --permission-mode <X>` is wider — `default` and
 * `dontAsk` are deliberately not exposed here because chat has no interactive
 * prompt mechanism, so those values would either hang or no-op.
 */
export type ChatMode = 'plan' | 'auto-accept' | 'auto' | 'bypass'

/**
 * Map a raw `claude` CLI permission mode (as observed in `system/init.permissionMode`)
 * to our exposed `ChatMode`. Returns null for unmapped values (`default`, `dontAsk`)
 * so callers can decide whether to leave existing state untouched. Subprocess is the
 * source of truth: this mapper translates its raw value into our enum.
 */
export function rawPermissionModeToChatMode(raw: string | null | undefined): ChatMode | null {
  switch (raw) {
    case 'plan':
      return 'plan'
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
 */
export function chatModeToFlags(mode: string): string[] {
  switch (mode) {
    case 'plan':
      return ['--permission-mode', 'plan']
    case 'auto-accept':
      return ['--permission-mode', 'acceptEdits']
    case 'auto':
      return ['--permission-mode', 'auto']
    case 'bypass':
      return ['--allow-dangerously-skip-permissions']
    default:
      return []
  }
}

/**
 * Map our ChatMode to the raw CLI permission_mode string used by the SDK's
 * `control_request {subtype:'set_permission_mode', mode}`. Returns null for
 * `bypass` because that mode is enabled via the separate
 * `--allow-dangerously-skip-permissions` flag (no in-flight control equivalent),
 * so it requires a process restart instead.
 */
export function chatModeToCliPermissionMode(mode: string): string | null {
  switch (mode) {
    case 'plan':
      return 'plan'
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
