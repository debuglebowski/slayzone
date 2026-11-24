import type { TRPCLink } from '@trpc/client'
import type { AnyTRPCRouter } from '@trpc/server'
import { observable } from '@trpc/server/observable'

/** Where a device-only value is kept: `localStorage` in a shell, a map in tests. */
export interface DeviceSettingsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface DeviceSettingsLinkOpts {
  /** Is `key` one of this device's own preferences (fonts, theme, terminal rendering …)? */
  isDeviceKey: (key: string) => boolean
  storage: DeviceSettingsStorage
}

const PREFIX = 'slayzone:device-setting:'

type Envelope = { result?: { data?: unknown } }

/**
 * Device-only preferences (plans/settings-by-scope.md, phase 4) on the app's own hub
 * connection. A device key's value is read from this device's storage, so two
 * computers signed in to the same hub keep their own fonts, theme and terminal
 * rendering:
 *
 * - `settings.get`: the device's value; with none yet, the hub's value, which then
 *   becomes this device's own (the one-time copy that moves existing values over).
 * - `settings.set`: stored on the device AND written to the hub as before, so older
 *   app versions keep reading it and every window still gets the hub's change event.
 * - `settings.getAll`: the hub's map with this device's values laid over it.
 *
 * Every other operation passes through untouched.
 */
export function deviceSettingsLink<TRouter extends AnyTRPCRouter>(
  opts: DeviceSettingsLinkOpts
): TRPCLink<TRouter> {
  const read = (key: string): string | null => {
    try {
      return opts.storage.getItem(PREFIX + key)
    } catch {
      return null
    }
  }
  const write = (key: string, value: string): void => {
    try {
      opts.storage.setItem(PREFIX + key, value)
    } catch {
      /* storage full or unavailable: the hub still has the value */
    }
  }
  return () =>
    ({ op, next }) =>
      observable((observer) => {
        const input = (op.input ?? {}) as { key?: unknown; value?: unknown }
        const key = typeof input.key === 'string' ? input.key : null

        if (op.path === 'settings.get' && key && opts.isDeviceKey(key)) {
          const own = read(key)
          if (own !== null) {
            observer.next({ result: { type: 'data', data: own } } as never)
            observer.complete()
            return
          }
          const sub = next(op).subscribe({
            next(value) {
              const data = (value as Envelope).result?.data
              if (typeof data === 'string') write(key, data)
              observer.next(value)
            },
            error: (err) => observer.error(err),
            complete: () => observer.complete()
          })
          return () => sub.unsubscribe()
        }

        if (op.path === 'settings.set' && key && opts.isDeviceKey(key)) {
          if (typeof input.value === 'string') write(key, input.value)
          return next(op).subscribe(observer)
        }

        if (op.path === 'settings.getAll') {
          const sub = next(op).subscribe({
            next(value) {
              const envelope = value as Envelope
              const data = envelope.result?.data
              if (!data || typeof data !== 'object') return observer.next(value)
              const merged: Record<string, unknown> = { ...(data as Record<string, unknown>) }
              for (const [k, hubValue] of Object.entries(merged)) {
                if (!opts.isDeviceKey(k)) continue
                const own = read(k)
                if (own !== null) merged[k] = own
                else if (typeof hubValue === 'string') write(k, hubValue)
              }
              observer.next({ ...envelope, result: { ...envelope.result, data: merged } } as never)
            },
            error: (err) => observer.error(err),
            complete: () => observer.complete()
          })
          return () => sub.unsubscribe()
        }

        return next(op).subscribe(observer)
      })
}
