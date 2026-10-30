import type { Task } from '@slayzone/task-contracts'
import type { Project } from '@slayzone/projects-contracts'
import { plainMainTerminalCwd } from '../shared/main-terminal'

/**
 * Tasks whose tab should show their main terminal BEFORE the task page has loaded
 * (`TerminalFirstShell` as the page's Suspense fallback). For a task created to be
 * typed into right away (a new temporary task), the page's data fetch and first
 * render are not on the path to a live agent any more.
 *
 * Only a task whose terminal cwd needs nothing async (`plainMainTerminalCwd`) is
 * accepted: the fallback must spawn exactly what the page would.
 */
export interface TerminalFirstEntry {
  task: Task
  project: Project
  cwd: string
}

/** A mark older than this is not the open that mounted this pane. */
const TERMINAL_FIRST_TTL_MS = 30_000

/**
 * The task page mounts only once the pane's agent is up (or after this long): its
 * first render is a long main-thread task, and run alongside the agent's first
 * screen it delays that screen — and the user's echoed keys — by its whole length.
 */
export const TERMINAL_FIRST_HOLD_MAX_MS = 1500

const entries = new Map<
  string,
  TerminalFirstEntry & { at: number; holding: boolean; holdTimer: ReturnType<typeof setTimeout> }
>()
const listeners = new Set<() => void>()
const notify = (): void => {
  for (const l of listeners) l()
}

/** Mark `task` to open terminal-first. False when its terminal needs the page. */
export function markTerminalFirst(task: Task, project: Project | null | undefined): boolean {
  const cwd = plainMainTerminalCwd(task, project)
  if (!cwd || !project) return false
  const prev = entries.get(task.id)
  if (prev) clearTimeout(prev.holdTimer)
  entries.set(task.id, {
    task,
    project,
    cwd,
    at: Date.now(),
    holding: true,
    holdTimer: setTimeout(() => markTerminalFirstReady(task.id), TERMINAL_FIRST_HOLD_MAX_MS)
  })
  notify()
  return true
}

/** The pane's agent is up: the task page may mount now. */
export function markTerminalFirstReady(taskId: string): void {
  const e = entries.get(taskId)
  if (!e || !e.holding) return
  clearTimeout(e.holdTimer)
  entries.set(taskId, { ...e, holding: false })
  notify()
}

/** Whether the task page should wait for the terminal-first pane's agent. */
export function isTerminalFirstHolding(taskId: string): boolean {
  return getTerminalFirst(taskId) !== null && entries.get(taskId)!.holding
}

export function getTerminalFirst(taskId: string): TerminalFirstEntry | null {
  const e = entries.get(taskId)
  if (!e) return null
  return Date.now() - e.at <= TERMINAL_FIRST_TTL_MS ? e : null
}

/** The page has taken over (or the pane is gone): show the plain shell from now on. */
export function clearTerminalFirst(taskId: string): void {
  const e = entries.get(taskId)
  if (!e) return
  clearTimeout(e.holdTimer)
  entries.delete(taskId)
  notify()
}

export function subscribeTerminalFirst(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test seam. */
export function __resetTerminalFirstForTest(): void {
  for (const e of entries.values()) clearTimeout(e.holdTimer)
  entries.clear()
  listeners.clear()
}
