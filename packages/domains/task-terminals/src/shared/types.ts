import type { AgentState, TerminalMode } from '@slayzone/terminal-contracts'

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
   * How this tab's agent last ended (`terminal_tabs.agent_state`): `new` (never
   * started), `running` (alive, or alive when the app shut down), `auto_stopped`
   * (closed by the idle timeout) or `stopped` (any other exit). With the
   * `terminal_agent_startup` setting it decides whether opening the task starts the
   * agent — see `agentStartsOnOpen`.
   */
  agentState: AgentState
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
