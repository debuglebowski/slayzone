/**
 * What Enter does while the `/` menu is open, for a provider that runs its own
 * slash commands (`native-commands` policy). Pure — see `useAutocomplete`.
 *
 * 1. The user arrowed to an entry → that entry.
 * 2. The typed token is exactly an entry's name → that entry (not whatever
 *    fuzzy match is highlighted).
 * 3. Nothing typed yet, or the top entry's name starts with the token → the
 *    top entry (`/comp` + Enter completes to `/compact`).
 * 4. Otherwise → pass the draft through as typed; the CLI answers commands it
 *    doesn't know itself.
 */
export type EnterResolution = { kind: 'entry'; index: number } | { kind: 'passthrough' }

export function resolveEnter(args: {
  query: string
  /** Entry names in menu order (null for entries without a name). */
  names: Array<string | null>
  selectedIndex: number
  /** True once the user moved the selection with the keyboard for this match. */
  navigated: boolean
}): EnterResolution {
  const { query, names, selectedIndex, navigated } = args
  if (navigated && selectedIndex < names.length) return { kind: 'entry', index: selectedIndex }
  const q = query.toLowerCase()
  const exact = names.findIndex((n) => n !== null && n.toLowerCase() === q)
  if (exact >= 0) return { kind: 'entry', index: exact }
  if (names.length > 0 && (q === '' || (names[0] ?? '').toLowerCase().startsWith(q))) {
    return { kind: 'entry', index: q === '' ? Math.min(selectedIndex, names.length - 1) : 0 }
  }
  return { kind: 'passthrough' }
}
