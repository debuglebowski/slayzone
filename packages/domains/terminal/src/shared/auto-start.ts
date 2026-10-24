/**
 * Agent startup — when a task's main agent starts by itself (plans/agent-startup-mode.md).
 *
 * One hub setting picks the behaviour; one function applies it. Every place that
 * decides whether to start an agent (the task view's Start gate, chat auto-start,
 * task create reserving a pre-booted agent, the warm pool, boot restore) calls the
 * helpers here, so they cannot drift — a drift would boot an agent no tab adopts,
 * or show a Start button for an agent that is meant to be running.
 */

/** Settings key (hub-scoped): `manual` | `auto` | `instant`. */
export const AGENT_STARTUP_SETTING = 'terminal_agent_startup'

/**
 * - `manual`: every agent waits for the Start button.
 * - `auto`: an agent that was running when the app closed starts again, and a new
 *   task starts at once; an agent that was stopped (by the user, idle timeout, crash
 *   or exit) waits for the Start button.
 * - `instant`: every agent starts when its task opens.
 */
export type AgentStartupMode = 'manual' | 'auto' | 'instant'

export const AGENT_STARTUP_MODES: readonly AgentStartupMode[] = ['manual', 'auto', 'instant']

export const DEFAULT_AGENT_STARTUP_MODE: AgentStartupMode = 'auto'

/**
 * How a tab's agent last ended, persisted as `terminal_tabs.agent_state`.
 * - `new`: never started; written by task create, so only tasks created after the
 *   setting existed get it (a lazily created row defaults to `stopped`).
 * - `running`: alive, or alive when the app shut down (shutdown keeps it).
 * - `auto_stopped`: closed by the idle timeout.
 * - `stopped`: ended any other way — killed by the user, crashed, or exited.
 */
export type AgentState = 'new' | 'running' | 'auto_stopped' | 'stopped'

export const AGENT_STATES: readonly AgentState[] = ['new', 'running', 'auto_stopped', 'stopped']

export function parseAgentStartupMode(raw: string | null | undefined): AgentStartupMode {
  return (AGENT_STARTUP_MODES as readonly string[]).includes(raw ?? '')
    ? (raw as AgentStartupMode)
    : DEFAULT_AGENT_STARTUP_MODE
}

export function parseAgentState(raw: string | null | undefined): AgentState {
  return (AGENT_STATES as readonly string[]).includes(raw ?? '') ? (raw as AgentState) : 'stopped'
}

/**
 * Whether opening a task starts its main agent without the Start gate. Temporary
 * tasks always do (scratch terminals are "always live").
 */
export function agentStartsOnOpen(input: {
  mode: AgentStartupMode
  state: AgentState
  isTemporary: boolean
}): boolean {
  if (input.isTemporary) return true
  switch (input.mode) {
    case 'instant':
      return true
    case 'auto':
      return input.state === 'running' || input.state === 'new'
    case 'manual':
      return false
  }
}

/** Whether the warm pool keeps a pre-booted agent ready. */
export function warmPoolEnabled(mode: AgentStartupMode): boolean {
  return mode !== 'manual'
}

/** Whether boot reopens (in the background) the tasks whose agent was running at shutdown. */
export function restoresRunningAgentsOnBoot(mode: AgentStartupMode): boolean {
  return mode !== 'manual'
}

/**
 * The mode the Start gate's "Don't show this again" switches to: one step more
 * automatic than the current one.
 */
export function nextAgentStartupMode(mode: AgentStartupMode): AgentStartupMode {
  return mode === 'manual' ? 'auto' : 'instant'
}
