/** Insert the row returned by a creation request into its board mirror. */
export function insertCreatedRow<T extends { id: string }>(
  rows: T[],
  created: T,
  at: 'start' | 'end'
): T[] {
  // A subscription/focus/reconnect refresh can deliver this row before the
  // mutation callback. Keep that newer row and its server ordering intact.
  if (rows.some((row) => row.id === created.id)) return rows
  return at === 'start' ? [created, ...rows] : [...rows, created]
}
