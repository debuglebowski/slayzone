/**
 * Spy on taskEvents emissions during a test. Captures payloads in order.
 *
 * Usage:
 *   import { taskEvents } from '@slayzone/task/main'
 *   const spy = spyTaskEvents(taskEvents, 'task:created', 'task:archived')
 *   // ... do stuff ...
 *   expect(spy.calls).toEqual([{ event: 'task:created', payload: { ... } }])
 *   spy.stop()
 */
type AnyEmitter = {
  on: (event: string, listener: (payload: unknown) => void) => unknown
  off: (event: string, listener: (payload: unknown) => void) => unknown
}

export interface EventSpyCall {
  event: string
  payload: unknown
}

export interface EventSpy {
  calls: EventSpyCall[]
  callsFor(event: string): EventSpyCall[]
  reset(): void
  stop(): void
}

export function spyTaskEvents(emitter: AnyEmitter, ...events: string[]): EventSpy {
  const calls: EventSpyCall[] = []
  const listeners = new Map<string, (payload: unknown) => void>()
  for (const event of events) {
    const listener = (payload: unknown) => { calls.push({ event, payload }) }
    listeners.set(event, listener)
    emitter.on(event, listener)
  }
  return {
    calls,
    callsFor(event: string) { return calls.filter((c) => c.event === event) },
    reset() { calls.length = 0 },
    stop() {
      for (const [event, listener] of listeners) emitter.off(event, listener)
      listeners.clear()
    }
  }
}
