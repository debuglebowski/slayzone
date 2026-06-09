// In-memory tabs shim — TerminalContainer and useTaskTerminals call this
// surface on mount to discover the main terminal tab. The sidecar doesn't
// have a `tabs` namespace yet; that's a bigger lift (per-task tab rows,
// group/position management, split-pane semantics). For the tests we need
// the main-tab discovery path and tab-create/split/rename/delete so the
// terminal-core specs (29/30/35) can assert on non-main tabs.
//
// Session-id invariant: main tab's id == taskId so
// `getMainSessionId(taskId) === `${taskId}:${taskId}`` (the helper Terminal.tsx
// and Electron tests both rely on).

import type { TerminalMode } from '@slayzone/terminal/shared'
import type {
  TerminalTab,
  CreateTerminalTabInput,
  UpdateTerminalTabInput,
} from '@slayzone/task-terminals/shared'

const tabsByTask = new Map<string, TerminalTab[]>()
const counters = new Map<string, number>()

function nowIso(): string {
  return new Date().toISOString()
}

function nextId(taskId: string): string {
  const next = (counters.get(taskId) ?? 0) + 1
  counters.set(taskId, next)
  return `tab-${taskId}-${next}`
}

function listFor(taskId: string): TerminalTab[] {
  return tabsByTask.get(taskId) ?? []
}

function replaceList(taskId: string, list: TerminalTab[]): void {
  tabsByTask.set(taskId, list)
}

function findById(tabId: string): { task: string; tab: TerminalTab } | null {
  for (const [taskId, list] of tabsByTask.entries()) {
    const match = list.find((t) => t.id === tabId)
    if (match) return { task: taskId, tab: match }
  }
  return null
}

export const tabsShim = {
  ensureMain: async (taskId: string, defaultMode: TerminalMode): Promise<TerminalTab> => {
    const existing = listFor(taskId)
    const main = existing.find((t) => t.isMain)
    if (main) return main
    const tab: TerminalTab = {
      id: taskId,
      taskId,
      groupId: taskId,
      label: null,
      mode: defaultMode,
      isMain: true,
      position: 0,
      createdAt: nowIso(),
      wasSpawned: false,
      hibernated: false,
    }
    replaceList(taskId, [...existing, tab])
    return tab
  },

  list: async (taskId: string): Promise<TerminalTab[]> => {
    return [...listFor(taskId)]
  },

  create: async (input: CreateTerminalTabInput): Promise<TerminalTab> => {
    const existing = listFor(input.taskId)
    const id = nextId(input.taskId)
    const tab: TerminalTab = {
      id,
      taskId: input.taskId,
      groupId: id,
      label: input.label ?? null,
      mode: input.mode ?? 'terminal',
      isMain: false,
      position: existing.length,
      createdAt: nowIso(),
      wasSpawned: false,
      hibernated: false,
    }
    replaceList(input.taskId, [...existing, tab])
    return tab
  },

  split: async (tabId: string): Promise<TerminalTab | null> => {
    const found = findById(tabId)
    if (!found) return null
    const newId = nextId(found.task)
    const newTab: TerminalTab = {
      id: newId,
      taskId: found.task,
      groupId: found.tab.groupId,
      label: null,
      mode: found.tab.mode,
      isMain: false,
      position: listFor(found.task).length,
      createdAt: nowIso(),
      wasSpawned: false,
      hibernated: false,
    }
    replaceList(found.task, [...listFor(found.task), newTab])
    return newTab
  },

  delete: async (tabId: string): Promise<boolean> => {
    const found = findById(tabId)
    if (!found) return false
    replaceList(
      found.task,
      listFor(found.task).filter((t) => t.id !== tabId),
    )
    return true
  },

  update: async (input: UpdateTerminalTabInput): Promise<TerminalTab | null> => {
    const found = findById(input.id)
    if (!found) return null
    const updated: TerminalTab = {
      ...found.tab,
      label: input.label !== undefined ? input.label : found.tab.label,
      mode: input.mode ?? found.tab.mode,
      position: input.position ?? found.tab.position,
    }
    const list = listFor(found.task).map((t) => (t.id === input.id ? updated : t))
    replaceList(found.task, list)
    return updated
  },

  move: async (_input: unknown): Promise<boolean> => true,
}
