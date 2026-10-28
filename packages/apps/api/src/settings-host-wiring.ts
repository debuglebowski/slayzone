/**
 * Wires the settings router's host deps (`@slayzone/settings-core/server`'s
 * `setSettingsHostDeps`) to what api owns: the theme members of the bridged
 * `AppDeps` (resolved per call, so whichever `AppDeps` the host set is used) and
 * the notify bus's `settings-changed`. Imported for its effect by `router.ts`, so
 * every host that composes the app router has it wired.
 *
 * @module api/settings-host-wiring
 */
import { setSettingsHostDeps } from '@slayzone/settings-core/server'
import { emitSettingsChanged, getAppDeps } from './app-deps'

setSettingsHostDeps({
  themeGetEffective: () => getAppDeps().themeGetEffective(),
  themeGetSource: () => getAppDeps().themeGetSource(),
  themeSet: (pref) => getAppDeps().themeSet(pref),
  onSettingsWritten: (change) => emitSettingsChanged(change)
})
