/**
 * The 🔔 sheet's rows, as plain data — desktop's agent status panel: every hub's agents
 * (`mergeHubAgents`: waiting for you first, then errors, running, paused, done), for all
 * projects or one project of one hub.
 */
import { agentStateLabel, AGENT_GROUP_TITLES } from '../agents/agent-status'
import { type AgentRow, mergeHubAgents } from '../agents/hub-agents'
import type { HubFeed } from '../hub-board'
import type { ProjectRef } from '../projects/hub-projects'

export function attentionRows(feeds: readonly HubFeed[], scope: ProjectRef | null): AgentRow[] {
  const rows = mergeHubAgents(feeds)
  if (!scope) return rows
  return rows.filter((r) => r.hubId === scope.hubId && r.task.project_id === scope.projectId)
}

/** `Website · Waiting for you` (with several hubs, the hub too). */
export function attentionSubtitle(row: AgentRow, showHub: boolean): string {
  const state = row.group === 'waiting' ? AGENT_GROUP_TITLES.waiting : agentStateLabel(row.state)
  return [row.project?.name ?? 'Unknown project', showHub ? row.hubLabel : null, state]
    .filter(Boolean)
    .join(' · ')
}
