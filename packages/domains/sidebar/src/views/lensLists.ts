import type { Task } from '@slayzone/task-contracts'
import type { TerminalState } from '@slayzone/terminal-contracts'

/**
 * Where a task's agent stands, from the user's point of view. `needs-you`: the task
 * is flagged unread (the agent finished or asked before the user looked) or the agent
 * errored. `running`: working (or starting, or only background subagents left).
 * `idle`: alive and waiting at its prompt. `none`: no live agent.
 */
export type AgentBucket = 'needs-you' | 'running' | 'idle' | 'none'

export const AGENT_BUCKETS: ReadonlyArray<{ key: AgentBucket; label: string }> = [
  { key: 'needs-you', label: 'Needs you' },
  { key: 'running', label: 'Running' },
  { key: 'idle', label: 'Idle' },
  { key: 'none', label: 'No agent' }
]

export function agentBucket(task: Task, mainState: TerminalState | undefined): AgentBucket {
  if (task.needs_attention || mainState === 'error') return 'needs-you'
  if (mainState === 'running' || mainState === 'background' || mainState === 'starting')
    return 'running'
  if (mainState === 'idle') return 'idle'
  return 'none'
}

export interface ListGroup<K extends string = string> {
  key: K
  label: string
  tasks: Task[]
}

/** Tasks bucketed by agent state, in bucket order; empty buckets left out. */
export function groupByAgent(
  tasks: readonly Task[],
  stateOf: (taskId: string) => TerminalState | undefined
): ListGroup<AgentBucket>[] {
  const byBucket = new Map<AgentBucket, Task[]>()
  for (const t of tasks) {
    const b = agentBucket(t, stateOf(t.id))
    const list = byBucket.get(b) ?? []
    list.push(t)
    byBucket.set(b, list)
  }
  return AGENT_BUCKETS.flatMap(({ key, label }) => {
    const list = byBucket.get(key)
    return list ? [{ key, label, tasks: list }] : []
  })
}

export type RecentBucket = 'today' | 'yesterday' | 'week' | 'earlier' | 'never'

const RECENT_LABELS: Record<RecentBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  earlier: 'Earlier',
  never: 'No activity yet'
}

/**
 * Tasks newest interaction first (`last_interaction_at`; never-touched last, newest
 * created first), bucketed by local day.
 */
export function groupByRecent(tasks: readonly Task[], now: Date): ListGroup<RecentBucket>[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 24 * 60 * 60 * 1000
  const bucketOf = (t: Task): RecentBucket => {
    const at = t.last_interaction_at
    if (at == null) return 'never'
    if (at >= startOfToday) return 'today'
    if (at >= startOfToday - day) return 'yesterday'
    if (at >= startOfToday - 6 * day) return 'week'
    return 'earlier'
  }
  const sorted = [...tasks].sort((a, b) => {
    const av = a.last_interaction_at
    const bv = b.last_interaction_at
    if (av != null && bv != null && av !== bv) return bv - av
    if (av == null && bv != null) return 1
    if (bv == null && av != null) return -1
    return (b.created_at ?? '').localeCompare(a.created_at ?? '')
  })
  const groups: ListGroup<RecentBucket>[] = []
  for (const t of sorted) {
    const key = bucketOf(t)
    let g = groups.find((x) => x.key === key)
    if (!g) {
      g = { key, label: RECENT_LABELS[key], tasks: [] }
      groups.push(g)
    }
    g.tasks.push(t)
  }
  return groups
}

/**
 * The "Needs you" strip: tasks waiting for the user — flagged unread / errored first,
 * then agents idle at their prompt. From every project; archived and done left out.
 */
export function needsYouTasks(
  tasks: readonly Task[],
  stateOf: (taskId: string) => TerminalState | undefined,
  doneTaskIds?: ReadonlySet<string>
): Task[] {
  const attention: Task[] = []
  const idle: Task[] = []
  for (const t of tasks) {
    if (t.archived_at || doneTaskIds?.has(t.id)) continue
    const b = agentBucket(t, stateOf(t.id))
    if (b === 'needs-you') attention.push(t)
    else if (b === 'idle') idle.push(t)
  }
  return [...attention, ...idle]
}
