export interface DeviceEmulation {
  name: string
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
  userAgent?: string
  category?: string
}

// --- Multi-device preview ---

export type DeviceSlot = 'desktop' | 'tablet' | 'mobile'
export type GridLayout = 'horizontal' | 'vertical'

export interface DeviceSlotConfig {
  enabled: boolean
  preset: DeviceEmulation
}

export type MultiDeviceConfig = Record<DeviceSlot, DeviceSlotConfig>

export type BrowserTabTheme = 'system' | 'light' | 'dark'

export interface BrowserTab {
  id: string
  url: string
  title: string
  customName?: string
  favicon?: string
  themeMode?: BrowserTabTheme
  multiDeviceMode?: boolean
  multiDeviceConfig?: MultiDeviceConfig
  multiDeviceLayout?: GridLayout
  /** Sticky: set true the first time an agent CLI mutation hits this tab. Never cleared. */
  agentTouched?: boolean
  /** Persisted user-facing lock state. Driven by user toggle + auto-lock on agentTouched transition. */
  locked?: boolean
  /**
   * An ISOLATED tab: opened for a caller that is not the user's own local agent (an
   * agent on another computer). It browses in its own empty, non-persistent browser
   * (`browserPartitionForTab`) — never the user's logins, files or local network —
   * and is the only kind of tab such a caller may use. Fixed at creation.
   */
  isolated?: boolean
}

/** The tabs one non-primary browser panel instance shows (`BrowserTabsState.byPanel`). */
export interface BrowserPanelTabs {
  /** Ids into the flat `tabs` list, in this panel's tab order. */
  tabIds: string[]
  activeTabId: string | null
}

/**
 * `tasks.browser_tabs`: ONE flat list of the task's tabs (tab ids unique per task, so
 * `slay browser --tab` finds any of them) plus, per non-primary browser panel
 * instance, which of them it shows (docs/plans/panel-model.md §1.3). A tab no
 * `byPanel` entry lists belongs to the primary browser; `activeTabId` is the primary's.
 */
export interface BrowserTabsState {
  tabs: BrowserTab[]
  activeTabId: string | null
  byPanel?: Record<string, BrowserPanelTabs>
}
