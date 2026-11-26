/**
 * Wires the settings router's host deps (`@slayzone/settings-core/server`'s
 * `setSettingsHostDeps`) to what api owns: the notify bus's `settings-changed`.
 * Imported for its effect by `router.ts`, so every host that composes the app
 * router has it wired.
 *
 * @module api/settings-host-wiring
 */
import { setSettingsHostDeps } from '@slayzone/settings-core/server'
import { emitSettingsChanged } from './app-deps'

setSettingsHostDeps({
  onSettingsWritten: (change) => emitSettingsChanged(change)
})
