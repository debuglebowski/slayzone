/**
 * Copy-on-write scoped to ONE reducer call (one event, or a whole batch of them).
 *
 * The chat reducer is pure: it never changes an array or Map of the state it is
 * given. Copying the timeline for every appended row made replay quadratic (a
 * 50,000-event session spent 3.9 s copying). Inside a call, an array or Map the
 * call created itself can't be seen by anyone else yet — so the first write to
 * a container copies it once and marks the copy as owned, and every later write
 * in the same call changes the owned copy in place. When the call returns, the
 * marks are dropped: the next call copies again before its first write.
 *
 * Rules for reducer code: write through {@link writable} / {@link writableMap} /
 * {@link appended} only, and after writing never read the container through a
 * state from before the write (it may be the same, changed object).
 */

/** What the running call copied (one Set, reused: emptied when the call ends). */
const owned = new Set<object>()
let depth = 0
/** Array elements + Map entries copied so far (the linear-replay guard reads it). */
let copiedSlots = 0

/** How many array elements and Map entries were copied so far, ever. */
export function copiedSlotCount(): number {
  return copiedSlots
}

/**
 * Start one reducer call: containers it copies are owned until the matching
 * {@link endReducerCall} (call it in a `finally`). Nested calls join the outer one.
 */
export function beginReducerCall(): void {
  depth++
}

/** End the call {@link beginReducerCall} started: nothing is owned any more. */
export function endReducerCall(): void {
  if (--depth === 0) owned.clear()
}

/** `arr` itself when this call owns it, else an owned copy. */
export function writable<T>(arr: readonly T[]): T[] {
  if (owned.has(arr)) return arr as T[]
  copiedSlots += arr.length
  const copy = arr.slice()
  if (depth > 0) owned.add(copy)
  return copy
}

/** `map` itself when this call owns it, else an owned copy. */
export function writableMap<K, V>(map: ReadonlyMap<K, V>): Map<K, V> {
  if (owned.has(map)) return map as Map<K, V>
  copiedSlots += map.size
  const copy = new Map(map)
  if (depth > 0) owned.add(copy)
  return copy
}

/** `arr` with `items` appended (in place when owned). */
export function appended<T>(arr: readonly T[], ...items: T[]): T[] {
  if (owned.has(arr)) {
    const out = arr as T[]
    for (const item of items) out.push(item)
    return out
  }
  // One copy with room for the new rows.
  copiedSlots += arr.length
  const out = arr.concat(items)
  if (depth > 0) owned.add(out)
  return out
}

/** A new array this call owns (e.g. built by a prepend). */
export function owning<T>(arr: T[]): T[] {
  if (depth > 0) owned.add(arr)
  return arr
}
