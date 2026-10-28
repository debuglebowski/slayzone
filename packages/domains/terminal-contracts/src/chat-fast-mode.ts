/**
 * Codex Fast Mode — a delivery-speed axis, orthogonal to reasoning effort and
 * collaboration mode.
 *
 * Fast Mode maps onto Codex's `turn/start.serviceTier: 'fast'`: same model,
 * ~1.5× faster delivery via optimized transport, at a higher credit rate.
 * `false` (Normal) omits `serviceTier` so Codex uses its default tier.
 *
 * Only `codex-chat` exposes the lever. Stored in
 * `provider_config.<terminalMode>.chatFastMode`.
 *
 * @module shared/chat-fast-mode
 */

/** Codex `serviceTier` value for Fast Mode. */
export const CODEX_FAST_SERVICE_TIER = 'fast'

/** Value for a freshly created task when nothing has been persisted. */
export const DEFAULT_CHAT_FAST_MODE = false

/**
 * Whether a terminal mode exposes the Fast Mode lever. Only `codex-chat` does.
 */
export function modeSupportsFastMode(mode: string): boolean {
  return mode === 'codex-chat'
}
