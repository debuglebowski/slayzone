/**
 * Where the app keeps the theme inputs it last read from each hub, so a launch paints
 * in the user's theme before the hub answers. Format, per-hub entries and "unreadable
 * = nothing kept" are `createHubThemeCache`'s (`@slayzone/theme-tokens`); this file is
 * only the storage.
 *
 * A file in the app's cache directory (expo-file-system), not the keychain
 * (expo-secure-store, which holds the hub bearer): theme ids and the light/dark
 * preference are not secret and the hub can always answer them again, so they go where
 * the OS keeps regenerable data. Not backed up; purged only when the device runs low on
 * storage, and then the next launch starts in the default preset, as without this
 * cache. The calls are synchronous, so a save (when the hub's settings load) and the
 * forget at sign-out always land in the order they were made.
 */
import { createHubThemeCache } from '@slayzone/theme-tokens'
import { File, Paths } from 'expo-file-system'

const cacheFile = (): File => new File(Paths.cache, 'hub-themes.json')

export const hubThemeCache = createHubThemeCache({
  read: () => {
    const file = cacheFile()
    return file.exists ? file.textSync() : null
  },
  write: (text) => cacheFile().writeSync(text)
})
