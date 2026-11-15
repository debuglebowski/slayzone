/**
 * Shared by the copy dialog's lazy ignored-file tree on every side (renderer, hub,
 * computer): the expiry marker of an index id, and the presets' glob syntax.
 */

/** The marker an unknown, foreign or expired ignored-tree id fails with (in the message). */
export const IGNORED_TREE_EXPIRED = 'IGNORED_TREE_EXPIRED'

/** Whether `err` is {@link IGNORED_TREE_EXPIRED} — by its message, so it survives any transport. */
export function isIgnoredTreeExpired(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return message.includes(IGNORED_TREE_EXPIRED)
}

/**
 * The copy presets' glob syntax (`*` within a segment, `**` across segments, `?` one
 * character). One implementation for the preset match over ignored files and for
 * `copyIgnoredFiles`' glob paths.
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\0/g, '.*')
  return new RegExp(`^${escaped}$`)
}
