/**
 * The 🔔 sheet's rows, as plain data — desktop's agent status panel: every hub's agents
 * (`mergeHubAgents`: ready for review first, then errors, running, paused, done), for
 * all projects or one project of one hub; in sections per group (`attentionSections`),
 * and whether the hubs' agents are in yet (`attentionLoad`) — "No agents" only when
 * they are.
 */
import { type AgentGroup, agentStateLabel, AGENT_GROUP_TITLES } from '../agents/agent-status'
import { type AgentRow, mergeHubAgents } from '../agents/hub-agents'
import type { HubFeed } from '../hub-board'
import type { ProjectRef } from '../projects/hub-projects'

export function attentionRows(feeds: readonly HubFeed[], scope: ProjectRef | null): AgentRow[] {
  const rows = mergeHubAgents(feeds)
  if (!scope) return rows
  return rows.filter((r) => r.hubId === scope.hubId && r.task.project_id === scope.projectId)
}

/** `Website · Ready for review` (with several hubs, the hub too). */
export function attentionSubtitle(row: AgentRow, showHub: boolean): string {
  const state = row.group === 'waiting' ? AGENT_GROUP_TITLES.waiting : agentStateLabel(row.state)
  return [row.project?.name ?? 'Unknown project', showHub ? row.hubLabel : null, state]
    .filter(Boolean)
    .join(' · ')
}

/** The rows of one group, under its title. */
export interface AttentionSection {
  group: AgentGroup
  title: string
  rows: AgentRow[]
}

/** `rows` (already in group order, `mergeHubAgents`) under a header per group. */
export function attentionSections(rows: readonly AgentRow[]): AttentionSection[] {
  const sections: AttentionSection[] = []
  for (const row of rows) {
    const last = sections.at(-1)
    if (last?.group === row.group) last.rows.push(row)
    else sections.push({ group: row.group, title: AGENT_GROUP_TITLES[row.group], rows: [row] })
  }
  return sections
}

export type AttentionLoad =
  | { kind: 'ready' }
  | { kind: 'loading' }
  /** A hub's board or agents could not be read (and were never read). */
  | { kind: 'error'; message: string }

/**
 * Whether every hub's agents can be listed: its board (titles) and its agent sessions
 * are in. A failure is reported over a hub still loading (the user can act on it).
 */
export function attentionLoad(feeds: readonly HubFeed[]): AttentionLoad {
  let loading = false
  for (const { hub, board, agents } of feeds) {
    const boardError = board.data === undefined ? board.error : null
    const agentsError = agents.loaded ? null : agents.error
    const error = boardError ?? agentsError
    if (error) return { kind: 'error', message: `${hub.label}: ${error}` }
    if (board.data === undefined || !agents.loaded) loading = true
  }
  return loading ? { kind: 'loading' } : { kind: 'ready' }
}
