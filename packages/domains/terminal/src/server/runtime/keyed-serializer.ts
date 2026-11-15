/**
 * Runs one task at a time per key; later ones for the same key wait their turn,
 * other keys run freely. A failed task never blocks the next (its caller still sees
 * its rejection). Bounded: a key's entry goes when its last task settles.
 *
 * Used by pty-store so a tab's start (`pty.create`) and the hub's adoption of that
 * tab's running agent (`attach`) never interleave (review H2).
 */
export interface KeyedSerializer {
  <T>(key: string, task: () => Promise<T>): Promise<T>
  /** Keys with a task queued or running (tests). */
  size(): number
}

export function createKeyedSerializer(): KeyedSerializer {
  const tails = new Map<string, Promise<unknown>>()
  const run = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const prior = tails.get(key) ?? Promise.resolve()
    const current = prior.then(
      () => task(),
      () => task()
    )
    tails.set(key, current)
    const cleanup = (): void => {
      if (tails.get(key) === current) tails.delete(key)
    }
    current.then(cleanup, cleanup)
    return current
  }
  return Object.assign(run, { size: () => tails.size })
}
