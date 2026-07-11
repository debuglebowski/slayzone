/**
 * Minimal typed event emitter used by the fleet gateway and dialer. Kept
 * dependency-free on purpose — @slayzone/fleet only depends on ws + zod.
 *
 * @module fleet/shared/events
 */

export type EventMap = Record<string, unknown>

export type Listener<T> = (payload: T) => void

export class TypedEventEmitter<E extends EventMap> {
  private readonly listeners = new Map<keyof E, Set<Listener<never>>>()
  private readonly onListenerError?: (event: keyof E, err: unknown) => void

  constructor(onListenerError?: (event: keyof E, err: unknown) => void) {
    this.onListenerError = onListenerError
  }

  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as Listener<never>)
    return () => this.off(event, listener)
  }

  off<K extends keyof E>(event: K, listener: Listener<E[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>)
  }

  /** Promise for the next occurrence of `event`. */
  once<K extends keyof E>(event: K): Promise<E[K]> {
    return new Promise((resolve) => {
      const unsubscribe = this.on(event, (payload) => {
        unsubscribe()
        resolve(payload)
      })
    })
  }

  /** A throwing listener never breaks the emitter or its siblings. */
  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of [...set]) {
      try {
        ;(listener as Listener<E[K]>)(payload)
      } catch (err) {
        this.onListenerError?.(event, err)
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }
}
