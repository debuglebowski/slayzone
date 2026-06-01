import { EventEmitter } from 'node:events'

/**
 * Minimal typed wrapper over Node's `EventEmitter`. `TEventMap` maps each event
 * name to the tuple of its listener arguments.
 *
 * This is the foundation of the per-domain streaming pattern: a domain owns a
 * `TypedEmitter` instance, main-process code emits on it, and a tRPC
 * `subscription` router wraps it in an `observable`. Reused by every streaming
 * router (agent-turns, then chat / pty / menus / notify).
 *
 * Lives in a platform **subpath** export (`@slayzone/platform/events`), never
 * the main barrel, so the `node:events` import stays out of the renderer bundle.
 */
export class TypedEmitter<
  TEventMap extends Record<string, unknown[]>
> extends EventEmitter {
  on<K extends keyof TEventMap & string>(
    event: K,
    listener: (...args: TEventMap[K]) => void
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  off<K extends keyof TEventMap & string>(
    event: K,
    listener: (...args: TEventMap[K]) => void
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void)
  }

  once<K extends keyof TEventMap & string>(
    event: K,
    listener: (...args: TEventMap[K]) => void
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void)
  }

  emit<K extends keyof TEventMap & string>(event: K, ...args: TEventMap[K]): boolean {
    return super.emit(event, ...args)
  }
}
