/** An observable loader acquired by effect setup, never by rendering retained state. */
interface ObservableLoader<Value> {
  subscribe(listener: () => void): () => void
  getSnapshot(): Value
  dispose(): void
}

export function createLoaderLifetime<Value, Loader extends ObservableLoader<Value>>(
  empty: Value,
  create: (signal: AbortSignal) => Loader,
  start?: (loader: Loader) => void
) {
  const idle: { loader: Loader | null; value: Value } = { loader: null, value: empty }
  let snapshot = idle
  let active: { loader: Loader; controller: AbortController; unsubscribe: () => void } | null = null
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    activate() {
      if (active) return
      const controller = new AbortController(),
        loader = create(controller.signal)
      const owned = { loader, controller, unsubscribe: () => undefined as void }
      active = owned
      owned.unsubscribe = loader.subscribe(() => {
        if (active !== owned) return
        snapshot = { loader, value: loader.getSnapshot() }
        emit()
      })
      snapshot = { loader, value: loader.getSnapshot() }
      emit()
      start?.(loader)
    },
    deactivate() {
      const previous = active
      active = null
      snapshot = idle
      if (!previous) return
      previous.unsubscribe()
      previous.loader.dispose()
      // This signal belongs to the captured scoped client, never a mutable current client.
      previous.controller.abort()
      emit()
    }
  }
}
