import { useEffect, useState } from 'react'
import { clearSettingsReopen, peekSettingsReopen } from './settings-reopen'

/**
 * The Settings tab a save asked to reopen after reloading the window
 * (`requestSettingsReopen`), or null — for seeding the open state.
 *
 * Read once per mount while rendering, dropped once that mount commits. A render
 * React throws away (StrictMode's double render, an interrupted render) therefore
 * cannot lose the request, and a later remount finds it gone — so it opens
 * Settings exactly once, like the mount-effect consume it replaces.
 */
export function useSettingsReopenTab(): string | null {
  const [tab] = useState(peekSettingsReopen)
  useEffect(() => {
    clearSettingsReopen()
  }, [])
  return tab
}
