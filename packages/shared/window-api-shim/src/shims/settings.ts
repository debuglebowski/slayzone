import { settingsRemote } from '../transport/mojo'

// Electron's settings API was untyped JSON-blob — get returns any, set accepts any.
// SettingsHost mojom is string-keyed KV. Serialize non-string values as JSON so
// the renderer's existing `window.api.settings.get<Foo>('foo')` pattern survives.

export const settingsShim = {
  get: async <T = unknown>(key: string): Promise<T | null> => {
    const remote = await settingsRemote()
    const { value } = await remote.getString(key)
    if (!value) return null
    try {
      return JSON.parse(value) as T
    } catch {
      return value as unknown as T
    }
  },
  set: async <T = unknown>(key: string, value: T): Promise<boolean> => {
    const remote = await settingsRemote()
    const payload = JSON.stringify(value)
    const { ok } = await remote.setString(key, payload)
    return ok
  },
}
