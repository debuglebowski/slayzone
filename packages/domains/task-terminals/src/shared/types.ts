import type { TerminalMode } from '@slayzone/terminal/shared'

export interface TerminalTab {
  id: string // UUID or "main"
  taskId: string
  groupId: string // tabs with same groupId render side-by-side
  label: string | null
  mode: TerminalMode
  isMain: boolean
  position: number
  createdAt: string
  /**
   * True when this tab's subprocess (PTY for xterm, chat child_process for chat)
   * was last known to be alive. Set on spawn, cleared on user kill / natural exit.
   * NOT cleared on app shutdown — so next boot auto-restarts warm agents.
   */
  wasSpawned: boolean
  /**
   * True when the idle-close (hibernation) feature auto-closed this agent while
   * idle. Distinct from `wasSpawned` (which hibernation clears): persists the
   * "sleeping 💤 / Reopen" status across reload + restart so a stale agent stays
   * visibly distinct from a never-started one. Cleared on (re)spawn.
   */
  hibernated: boolean
}

export interface TerminalGroup {
  id: string // = groupId
  tabs: TerminalTab[] // sorted by position
  isMain: boolean // true if contains the main tab
}

export interface CreateTerminalTabInput {
  taskId: string
  mode?: TerminalMode
  label?: string
}

export interface UpdateTerminalTabInput {
  id: string
  label?: string | null
  mode?: TerminalMode
  position?: number
}
