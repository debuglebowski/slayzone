// The fork's client host (D3, task 557ebb72): theme mode, labs flags and shortcut
// overrides persist in the shell's Mojo key-value store (SettingsHost), this device's
// own — like the desktop's client.config.json. No native menu, app zoom or updater is
// wired to the renderer here: those methods are inert and their events never fire.
import { createStorageClientHost, type ElectronClientHost } from '@slayzone/platform/client-host'
import { settingsRemote } from '../transport/mojo'

export const clientHostShim: ElectronClientHost = createStorageClientHost({
  kv: {
    get: async (key) => {
      try {
        const { value } = await (await settingsRemote()).getString(key)
        return value || null
      } catch {
        return null
      }
    },
    set: async (key, value) => {
      await (await settingsRemote()).setString(key, value)
    }
  },
  systemTheme: () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark'
})
