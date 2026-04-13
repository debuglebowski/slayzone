/**
 * Map the `notesLineSpacing` user setting to a `.mk-doc` variant.
 *
 * - `compact` setting → `compact` variant (14px, tight everything).
 * - `normal` setting → `normal` argument, defaulting to `page` (full Notion layout).
 *   Task sidebar inline description passes `'inline'` so normal-mode still uses
 *   tight chrome but page typography.
 */
export function noteVariant(
  spacing: 'compact' | 'normal',
  normal: 'page' | 'inline' = 'page',
): 'page' | 'compact' | 'inline' {
  return spacing === 'compact' ? 'compact' : normal
}
