import { useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { PtyInfo, ChatSessionStateEntry, TerminalState } from '@slayzone/terminal/shared'
import { isAliveTerminalState } from '@slayzone/terminal/shared'
import type { Task } from '@slayzone/task/shared'
import { isTerminalStatus, type ColumnConfig } from '@slayzone/projects/shared'

export interface IdleTask {
  task: Task
  sessionId: string
  mode: string
  lastOutputTime: number
}

interface AgentSessionRow {
  sessionId: string
  taskId: string
  mode: string
  lastOutputTime: number
  state: TerminalState
}

interface UseIdleTasksResult {
  idleTasks: IdleTask[]
  count: number
  refresh: () => Promise<void>
}

const IDLE_AGE_THRESHOLD_MS = 2000
const IDLE_AGE_RECHECK_DELAY_MS = IDLE_AGE_THRESHOLD_MS + 100

export function buildIdleTasks(
  rows: AgentSessionRow[],
  tasks: Task[],
  filterProjectId: string | null,
  now: number = Date.now(),
  columnsByProjectId?: Map<string, ColumnConfig[] | null>
): IdleTask[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  const byTaskId = new Map<string, IdleTask>()

  for (const row of rows) {
    if (row.state !== 'idle') continue
    if (row.mode === 'terminal') continue
    if (now - row.lastOutputTime < IDLE_AGE_THRESHOLD_MS) continue

    const task = tasksById.get(row.taskId)
    if (!task) continue
    if (filterProjectId && task.project_id !== filterProjectId) continue
    const columns = columnsByProjectId?.get(task.project_id) ?? null
    if (isTerminalStatus(task.status, columns)) continue

    const current = byTaskId.get(row.taskId)
    if (!current || row.lastOutputTime > current.lastOutputTime) {
      byTaskId.set(row.taskId, {
        task,
        sessionId: row.sessionId,
        mode: row.mode,
        lastOutputTime: row.lastOutputTime
      })
    }
  }

  return [...byTaskId.values()]
}

function ptyToRow(p: PtyInfo): AgentSessionRow {
  return { sessionId: p.sessionId, taskId: p.taskId, mode: p.mode, lastOutputTime: p.lastOutputTime, state: p.state }
}

function chatToRow(c: ChatSessionStateEntry): AgentSessionRow {
  return { sessionId: c.sessionId, taskId: c.taskId, mode: c.mode, lastOutputTime: c.lastOutputTime, state: c.state }
}

export function useIdleTasks(
  tasks: Task[],
  filterProjectId: string | null,
  columnsByProjectId?: Map<string, ColumnConfig[] | null>
): UseIdleTasksResult {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const ptysQuery = useQuery(trpc.pty.list.queryOptions())
  const chatsQuery = useQuery(trpc.pty.chatList.queryOptions())
  const recheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const rows: AgentSessionRow[] = useMemo(() => [
    ...(ptysQuery.data ?? []).map(ptyToRow),
    ...(chatsQuery.data ?? []).map(chatToRow),
  ], [ptysQuery.data, chatsQuery.data])

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.pty.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.pty.chatList.queryKey() }),
    ])
  }

  useEffect(() => {
    const unsubStateChange = window.api.pty.onStateChange((_sessionId, newState: TerminalState) => {
      void refresh()
      if (newState === 'idle') {
        if (recheckTimerRef.current) clearTimeout(recheckTimerRef.current)
        recheckTimerRef.current = setTimeout(() => void refresh(), IDLE_AGE_RECHECK_DELAY_MS)
      }
    })
    return () => {
      unsubStateChange()
      if (recheckTimerRef.current) clearTimeout(recheckTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const idleTasks: IdleTask[] = useMemo(
    () => buildIdleTasks(rows, tasks, filterProjectId, Date.now(), columnsByProjectId),
    [rows, tasks, filterProjectId, columnsByProjectId]
  )

  return {
    idleTasks,
    count: idleTasks.length,
    refresh
  }
}

/**
 * Pure: derive the set of task ids with a live (non-dead) agent session.
 * Filters out exited PTYs that linger in `pty.list()` during the ~100 ms
 * post-exit cleanup window — see `isAliveTerminalState`.
 */
export function buildActiveSessionTaskIds(
  ptys: Pick<PtyInfo, 'taskId' | 'state'>[],
  chats: Pick<ChatSessionStateEntry, 'taskId' | 'state'>[]
): Set<string> {
  const set = new Set<string>()
  for (const p of ptys) if (isAliveTerminalState(p.state)) set.add(p.taskId)
  for (const c of chats) if (isAliveTerminalState(c.state)) set.add(c.taskId)
  return set
}

/**
 * Returns the set of task ids that currently have a live agent session (PTY
 * or chat). Used for "is this task active" affordances. Dead sessions are
 * excluded so the badge clears as soon as the process exits.
 */
export function useActiveSessionTaskIds(): Set<string> {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const ptysQuery = useQuery(trpc.pty.list.queryOptions())
  const chatsQuery = useQuery(trpc.pty.chatList.queryOptions())

  useEffect(() => {
    const unsub = window.api.pty.onStateChange(() => {
      queryClient.invalidateQueries({ queryKey: trpc.pty.list.queryKey() })
      queryClient.invalidateQueries({ queryKey: trpc.pty.chatList.queryKey() })
    })
    return () => { unsub() }
  }, [queryClient, trpc])

  return useMemo(() => {
    const set = new Set<string>()
    for (const p of (ptysQuery.data ?? [])) set.add(p.taskId)
    for (const c of (chatsQuery.data ?? [])) set.add(c.taskId)
    return set
  }, [ptysQuery.data, chatsQuery.data])
}
