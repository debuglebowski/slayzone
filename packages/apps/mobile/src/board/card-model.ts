/**
 * What a board card shows beyond its title, as plain data — desktop's `KanbanCard`:
 * the agent dot (`agentDotOf`, desktop's `TerminalProgressDot` + the amber "needs you"
 * cue), the subtask ring (done/total; done = a completed column), the task's tags in
 * its own order, Blocked, overdue (a due date before today on a task not finished).
 * Plus the attention counts the header's 🔔 and the project switcher show.
 */
import { todayISO } from '@slayzone/tasks/board'
import type { TerminalState } from '@slayzone/terminal-contracts'
import { ALIVE_STATES } from '@slayzone/terminal/terminal-state'
import {
  isCompletedStatus,
  isTerminalStatus,
  resolveColumns,
  type WorkflowCategory
} from '@slayzone/workflow'
import { agentGroup } from '../agents/agent-status'
import { mergeHubAgents, taskAgentSessions, taskIdOfSession } from '../agents/hub-agents'
import { type BoardProject, type BoardTask, type HubFeed, rowKey } from '../hub-board'

/** Desktop's agent dot: amber = waits for you, green = running (dim: subagents), sky = idle. */
export type AgentDot = 'attention' | 'running' | 'background' | 'idle' | 'error' | 'hibernated'

export function agentDotOf(state: TerminalState | undefined, unread: boolean): AgentDot | null {
  if (!state) return null
  if (agentGroup(state, unread) === 'waiting') return 'attention'
  switch (state) {
    case 'starting':
    case 'running':
      return 'running'
    case 'background':
      return 'background'
    case 'idle':
      return 'idle'
    case 'error':
      return 'error'
    case 'hibernated':
      return 'hibernated'
    case 'dead':
      return null
  }
}

/** Most active first (as the agents list ranks a task's sessions). */
const ACTIVITY: Readonly<Record<TerminalState, number>> = {
  running: 0,
  background: 1,
  starting: 2,
  idle: 3,
  error: 4,
  hibernated: 5,
  dead: 6
}

/** The state of a task's busiest session; undefined = it has none. */
export function taskAgentState(feed: HubFeed, taskId: string): TerminalState | undefined {
  const sessions = taskAgentSessions(feed.agents.state, taskId)
  sessions.sort(
    (a, b) =>
      ACTIVITY[a.state] - ACTIVITY[b.state] ||
      Number(b.tabId === taskId) - Number(a.tabId === taskId)
  )
  return sessions[0]?.state
}

/** Tasks with an alive session (running, background, idle): desktop's `useActiveTaskIds`,
 * the list's "Activity" grouping. */
export function aliveTaskIds(feed: HubFeed): Set<string> {
  const ids = new Set<string>()
  for (const [sessionId, state] of Object.entries(feed.agents.state.byId)) {
    if (ALIVE_STATES.has(state)) ids.add(taskIdOfSession(sessionId))
  }
  return ids
}

export function taskAgentDot(feed: HubFeed, task: BoardTask): AgentDot | null {
  return agentDotOf(taskAgentState(feed, task.id), Boolean(task.needs_attention))
}

export interface CardTag {
  id: string
  name: string
  color: string
  textColor: string
}

export interface CardModel {
  dot: AgentDot | null
  /** null = no subtasks. */
  subtasks: { done: number; total: number } | null
  tags: CardTag[]
  blocked: boolean
  overdue: boolean
}

export function cardModel(
  feed: HubFeed,
  task: BoardTask,
  project: BoardProject | undefined,
  today: string = todayISO()
): CardModel {
  const data = feed.board.data
  const columns = project?.columns_config
  const subs = data ? data.tasks.filter((t) => t.parent_id === task.id && !t.archived_at) : []
  const allTags = new Map(
    ((data?.tags ?? []) as Array<{ id: string; name: string; color: string; text_color: string }>)
      .filter((t) => t && typeof t.id === 'string')
      .map((t) => [t.id, t])
  )
  const tags: CardTag[] = []
  for (const id of data?.taskTags[task.id] ?? []) {
    const tag = allTags.get(id)
    if (tag) tags.push({ id, name: tag.name, color: tag.color, textColor: tag.text_color })
  }
  return {
    dot: taskAgentDot(feed, task),
    subtasks:
      subs.length > 0
        ? {
            done: subs.filter((t) => isCompletedStatus(t.status, columns)).length,
            total: subs.length
          }
        : null,
    tags,
    blocked: data?.blockedTaskIds.includes(task.id) ?? false,
    overdue: Boolean(
      task.due_date && task.due_date < today && !isTerminalStatus(task.status, columns)
    )
  }
}

/** Agents waiting for the user, per project: by `rowKey(hubId, projectId)`. */
export function projectWaitingCounts(feeds: readonly HubFeed[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of mergeHubAgents(feeds)) {
    if (row.group !== 'waiting') continue
    const key = rowKey(row.hubId, row.task.project_id)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** The 🔔 count: agents of every hub waiting for the user. */
export function waitingAgentCount(feeds: readonly HubFeed[]): number {
  return mergeHubAgents(feeds).filter((r) => r.group === 'waiting').length
}

export interface StatusLook {
  label: string
  category: WorkflowCategory
  /** The column's workflow tone (`gray`, `blue` …; theme.ts paints it). */
  tone: string
}

/** A status as desktop draws it: its column's label, category (the icon) and tone. */
export function statusCategoryOf(status: string, project: BoardProject | undefined): StatusLook {
  const column = resolveColumns(project?.columns_config).find((c) => c.id === status)
  if (!column) return { label: status, category: 'unstarted', tone: 'gray' }
  return { label: column.label, category: column.category, tone: column.color }
}
