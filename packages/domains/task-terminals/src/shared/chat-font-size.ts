/** Bounds for a chat's font size, px — the same range the terminal allows. */
export const CHAT_FONT_SIZE_MIN = 8
export const CHAT_FONT_SIZE_MAX = 32

/** A whole px size inside the bounds; null for anything that is not a number. */
export function clampChatFontSize(size: unknown): number | null {
  if (typeof size !== 'number' || !Number.isFinite(size)) return null
  return Math.min(CHAT_FONT_SIZE_MAX, Math.max(CHAT_FONT_SIZE_MIN, Math.round(size)))
}
