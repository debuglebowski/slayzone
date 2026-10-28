import type { ComponentType } from 'react'

/**
 * Tabs ProjectSettingsDialog embeds from features built ON TOP of projects
 * (settings' tag editor). Projects owns this contract; the composing app injects
 * the real components once via registerProjectSettingsTabs() — so projects never
 * imports those features.
 */

export interface TagsSettingsTabProps {
  projectId: string
}

export interface ProjectSettingsTabs {
  TagsSettingsTab: ComponentType<TagsSettingsTabProps>
}

let registered: ProjectSettingsTabs | null = null

/**
 * Called ONCE by the composing app at module scope, before its first render.
 * Re-registering the same object is a no-op; a different one throws.
 */
export function registerProjectSettingsTabs(tabs: ProjectSettingsTabs): void {
  if (registered && registered !== tabs) {
    throw new Error('registerProjectSettingsTabs: project settings tabs are already registered')
  }
  registered = tabs
}

/** The app-registered tabs. Throws if the app never called registerProjectSettingsTabs. */
export function getProjectSettingsTabs(): ProjectSettingsTabs {
  if (!registered) {
    throw new Error('getProjectSettingsTabs: the app must call registerProjectSettingsTabs first')
  }
  return registered
}
