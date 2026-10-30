/**
 * The desktop logic later phases reuse, imported the way the app imports it — through
 * the packages' DOM-free subpaths — in React Native's test environment (jest-expo:
 * no `document`, no DOM events). A module that touches the DOM at import time fails
 * here, and so does any runtime import of a desktop-only package: each is mocked to
 * throw when loaded. (Type-only imports are erased and never load.)
 */
import type { PermissionRequestEvent } from '@slayzone/terminal-contracts'
import type { Task } from '@slayzone/task-contracts'
import {
  applyFilters,
  columnToCreateTaskDraft,
  defaultFilterState,
  groupTasksBy,
  PRIORITY_LABELS,
  patchBoardRows,
  sortTasks
} from '@slayzone/tasks/board'
import { selectPendingPrompts } from '@slayzone/terminal/chat-prompts'
import { initialState, reducer } from '@slayzone/terminal/reducer'
import { suppressDeviceStatusReplies } from '@slayzone/terminal/suppress-device-status'
import { getTerminalThemeById, terminalThemes } from '@slayzone/terminal/terminal-themes'
import { buildPermissionView, REJECT_MESSAGE } from '@slayzone/task-terminals/prompt-options'

jest.mock('@slayzone/ui', () => {
  throw new Error('@slayzone/ui (desktop UI kit) loaded')
})
jest.mock('@slayzone/ui/secure-context', () => {
  throw new Error('@slayzone/ui/secure-context (desktop UI kit) loaded')
})
jest.mock('@xterm/xterm', () => {
  throw new Error('@xterm/xterm (DOM terminal) loaded')
})
jest.mock('react-dom', () => {
  throw new Error('react-dom loaded')
})
jest.mock('lucide-react', () => {
  throw new Error('lucide-react (DOM icons) loaded')
})
jest.mock('@slayzone/transport/client', () => {
  throw new Error('@slayzone/transport/client (the tRPC runtime) loaded by pure logic')
})

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    status: 'todo',
    priority: 3,
    order: 0,
    created_at: '2026-10-01T00:00:00Z',
    due_date: null,
    parent_id: null,
    archived_at: null,
    is_temporary: false,
    snoozed_until: null,
    ...fields
  } as Task
}

describe('@slayzone/tasks/board', () => {
  it('sorts, groups, filters and drafts like the desktop board', () => {
    const tasks = [task('low', { priority: 4 }), task('urgent', { priority: 1 })]
    expect(sortTasks(tasks, 'priority').map((t) => t.id)).toEqual(['urgent', 'low'])
    expect(PRIORITY_LABELS[1]).toBe('Urgent')

    const byPriority = groupTasksBy(tasks, 'priority')
    expect(byPriority.find((c) => c.id === 'p1')?.tasks.map((t) => t.id)).toEqual(['urgent'])
    expect(columnToCreateTaskDraft(byPriority[0], 'priority')).toEqual({ priority: 1 })

    const sub = task('sub', { parent_id: 'urgent' })
    expect(applyFilters([...tasks, sub], defaultFilterState, new Map()).map((t) => t.id)).toEqual([
      'low',
      'urgent'
    ])
  })

  it('patches a board row in place', () => {
    const board = {
      tasks: [task('a'), task('b')],
      projects: [],
      tags: [],
      taskTags: {},
      blockedTaskIds: []
    }
    const renamed = task('a', { title: 'renamed' })
    const patched = patchBoardRows(board, ['a'], {
      tasks: [renamed],
      taskTags: {},
      blockedTaskIds: []
    })
    expect(patched?.tasks.map((t) => t.title)).toEqual(['renamed', 'b'])
  })
})

const permissionRequest: PermissionRequestEvent = {
  kind: 'permission-request',
  requestId: 'r1',
  toolName: 'Bash',
  toolUseId: 't1',
  input: { command: 'ls' }
}

describe('@slayzone/terminal chat logic', () => {
  it('reduces agent events into a timeline with its open prompts', () => {
    const state = reducer(initialState(), { type: 'event', event: permissionRequest })
    expect(selectPendingPrompts(state).map((p) => p.requestId)).toEqual(['r1'])
  })

  it('offers the desktop prompt card options', () => {
    const view = buildPermissionView(permissionRequest, { autoModeAvailable: false, cwd: '/w' })
    expect(view.options[0]).toMatchObject({ id: 'yes', label: 'Yes' })
    expect(view.options.at(-1)?.decision).toMatchObject({
      behavior: 'deny',
      message: REJECT_MESSAGE
    })
  })
})

describe('@slayzone/terminal terminal helpers', () => {
  it('has the terminal colour themes', () => {
    expect(terminalThemes.length).toBeGreaterThan(0)
    expect(getTerminalThemeById(terminalThemes[0].id)).toBe(terminalThemes[0].colors)
  })

  it('suppresses device-status replies on any xterm-compatible parser', () => {
    const registered: unknown[] = []
    const parser = {
      registerCsiHandler: (id: unknown) => {
        registered.push(id)
        return { dispose: () => undefined }
      }
    }
    suppressDeviceStatusReplies({ parser } as never)
    expect(registered).toEqual([{ final: 'n' }, { prefix: '?', final: 'n' }])
  })
})
