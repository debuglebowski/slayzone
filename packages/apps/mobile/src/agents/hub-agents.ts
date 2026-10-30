/**
 * Every signed-in hub's agents in one list, as plain data. Each hub's feed carries its
 * agent sessions (`HubAgentSessions`: the shared terminal-state rules applied to that
 * hub's pushes and snapshots, `use-hub-agent-sessions.ts`) beside its board; a row
 * joins a task's sessions with the task's board row (title, unread).
 *
 * Session ids are `<task id>:<tab id>`; a task's main tab has the task's id, so its
 * main session is `<task id>:<task id>`. Rows are keyed by hub AND task (hubs may
 * share task ids, see `hub-board.ts`).
 */
import type { TerminalState } from '@slayzone/terminal-contracts'
import { EMPTY_TERMINAL_STATE, type TerminalStateData } from '@slayzone/terminal/terminal-state'
import type { BoardProject, BoardTask, HubFeed } from '../hub-board'
import { rowKey } from '../hub-board'
import { AGENT_GROUP_ORDER, AGENT_GROUP_TITLES, type AgentGroup, agentGroup } from './agent-status'

/** One hub's agent sessions. */
export interface HubAgentSessions {
  /** Per session: state, the 💤 marker, background-job counts (shared rules). */
  state: TerminalStateData
  /** The first snapshot (`pty.sessionList` + the hibernated set) is in. */
  loaded: boolean
  /** Why the last snapshot failed; null = it didn't. */
  error: string | null
}

export const NO_AGENT_SESSIONS: HubAgentSessions = {
  state: EMPTY_TERMINAL_STATE,
  loaded: false,
  error: null
}

export const taskIdOfSession = (sessionId: string): string => {
  const at = sessionId.indexOf(':')
  return at === -1 ? sessionId : sessionId.slice(0, at)
}

export const tabIdOfSession = (sessionId: string): string => {
  const at = sessionId.indexOf(':')
  return at === -1 ? sessionId : sessionId.slice(at + 1)
}

export const sessionIdOf = (taskId: string, tabId: string): string => `${taskId}:${tabId}`

/** One of a task's agent sessions. */
export interface TaskAgentSession {
  sessionId: string
  tabId: string
  state: TerminalState
  backgroundJobs: number
}

/** The sessions of `taskId` this hub knows of, in the order it learned them. */
export function taskAgentSessions(state: TerminalStateData, taskId: string): TaskAgentSession[] {
  const out: TaskAgentSession[] = []
  for (const [sessionId, sessionState] of Object.entries(state.byId)) {
    if (taskIdOfSession(sessionId) !== taskId) continue
    out.push({
      sessionId,
      tabId: tabIdOfSession(sessionId),
      state: sessionState,
      backgroundJobs: state.jobsById[sessionId] ?? 0
    })
  }
  return out
}

/** One task's agents in the merged list. */
export interface AgentRow {
  /** Unique across hubs. */
  key: string
  hubId: string
  hubLabel: string
  task: BoardTask
  project: BoardProject | undefined
  /** The session the row shows: the task's most active one (see `mergeHubAgents`). */
  sessionId: string
  state: TerminalState
  group: AgentGroup
  /** The task's `needs_attention`. */
  unread: boolean
  /** Background jobs still running across the task's sessions. */
  backgroundJobs: number
}

/** Most active first: what a task "is doing" is what its busiest agent does. */
const ACTIVITY: Readonly<Record<TerminalState, number>> = {
  running: 0,
  background: 1,
  starting: 2,
  idle: 3,
  error: 4,
  hibernated: 5,
  dead: 6
}

/**
 * Every task with an agent session on any hub, one row per task: what needs the
 * user first (`AGENT_GROUP_ORDER`), then hubs in sign-in order, then each hub's
 * board order. A task shows its most active session (the main tab's on a tie); a
 * session whose task is not on the board (yet) is left out — it has no title to show.
 */
export function mergeHubAgents(feeds: readonly HubFeed[]): AgentRow[] {
  const rows: Array<AgentRow & { order: number }> = []
  let order = 0
  for (const { hub, board, agents } of feeds) {
    const data = board.data
    if (!data) continue
    const byTask = new Map<string, TaskAgentSession[]>()
    for (const [sessionId, state] of Object.entries(agents.state.byId)) {
      const taskId = taskIdOfSession(sessionId)
      const list = byTask.get(taskId) ?? []
      list.push({
        sessionId,
        tabId: tabIdOfSession(sessionId),
        state,
        backgroundJobs: agents.state.jobsById[sessionId] ?? 0
      })
      byTask.set(taskId, list)
    }
    if (byTask.size === 0) continue
    const projects = new Map<string, BoardProject>()
    for (const p of data.projects) if (p) projects.set(p.id, p)
    for (const task of data.tasks) {
      order++
      const own = byTask.get(task.id)
      if (!own) continue
      const shown = [...own].sort(
        (a, b) =>
          ACTIVITY[a.state] - ACTIVITY[b.state] ||
          Number(b.tabId === task.id) - Number(a.tabId === task.id)
      )[0]
      const unread = Boolean(task.needs_attention)
      rows.push({
        key: rowKey(hub.id, task.id),
        hubId: hub.id,
        hubLabel: hub.label,
        task,
        project: projects.get(task.project_id),
        sessionId: shown.sessionId,
        state: shown.state,
        group: agentGroup(shown.state, unread),
        unread,
        backgroundJobs: own.reduce((n, s) => n + s.backgroundJobs, 0),
        order
      })
    }
  }
  const rank = (g: AgentGroup): number => AGENT_GROUP_ORDER.indexOf(g)
  rows.sort((a, b) => rank(a.group) - rank(b.group) || a.order - b.order)
  return rows.map(({ order: _order, ...row }) => row)
}

export interface AgentGroupRows {
  group: AgentGroup
  title: string
  rows: AgentRow[]
}

/** Rows (already in group order) under their group titles; empty groups left out. */
export function groupAgentRows(rows: readonly AgentRow[]): AgentGroupRows[] {
  const groups: AgentGroupRows[] = []
  for (const row of rows) {
    const last = groups.at(-1)
    if (last && last.group === row.group) last.rows.push(row)
    else groups.push({ group: row.group, title: AGENT_GROUP_TITLES[row.group], rows: [row] })
  }
  return groups
}
