import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import type { PtyInfo, ChatSessionStateEntry, TerminalState } from '@slayzone/terminal/shared'
import type { Task } from '@slayzone/task/shared'
import { isTerminalStatus, type ColumnConfig } from '@slayzone/projects/shared'

export interface IdleTask {
  task: Task
  sessionId: string
  mode: string
  lastOutputTime: number
}

/**
 * Minimal shape for a session that may be idle. Both PTY (`pty.list()`) and
 * chat (`chat.list()`) return rows that satisfy this — chat sessions live in
 * a different transport but expose the same idle semantics.
 */
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
    // Defensive: a done task should have its agent killed by `onTaskReachedTerminal`,
    // but if a session leaks through (e.g. legacy sessions, race) suppress it here.
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
  const [rows, setRows] = useState<AgentSessionRow[]>([])
  const recheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    const [ptys, chats] = await Promise.all([
      getTrpcVanillaClient().pty.list.query(),
      getTrpcVanillaClient().pty.chatList.query()
    ])
    setRows([...ptys.map(ptyToRow), ...chats.map(chatToRow)])
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    // pty:state-change carries both PTY and chat transitions (chat-transport-manager
    // broadcasts on the same channel via session-registry).
    const unsubStateChange = window.api.pty.onStateChange((_sessionId, newState: TerminalState) => {
      refresh()
      // Threshold means a freshly-idle session won't appear yet — recheck once threshold passes.
      if (newState === 'idle') {
        if (recheckTimerRef.current) clearTimeout(recheckTimerRef.current)
        recheckTimerRef.current = setTimeout(refresh, IDLE_AGE_RECHECK_DELAY_MS)
      }
    })
    return () => {
      unsubStateChange()
      if (recheckTimerRef.current) clearTimeout(recheckTimerRef.current)
    }
  }, [refresh])

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
 * Returns the set of task ids that currently have any agent session (PTY or chat),
 * regardless of state. Useful for "is this task active" affordances.
 */
export function useActiveSessionTaskIds(): Set<string> {
  const [taskIds, setTaskIds] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    const [ptys, chats] = await Promise.all([
      getTrpcVanillaClient().pty.list.query(),
      getTrpcVanillaClient().pty.chatList.query()
    ])
    const set = new Set<string>()
    for (const p of ptys) set.add(p.taskId)
    for (const c of chats) set.add(c.taskId)
    setTaskIds(set)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const unsub = window.api.pty.onStateChange(() => { refresh() })
    return () => { unsub() }
  }, [refresh])

  return taskIds
}
