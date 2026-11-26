import type { Project } from '@slayzone/projects-contracts'
import type { Task } from '@slayzone/task-contracts'

/**
 * Sample projects and tasks for the lens previews ("Mock data"): enough variety that
 * every lens setting visibly changes something. Partial records — the preview only
 * reads display fields — cast to the full types. No worktrees and no folders, so the
 * tree's worktree-colour and skill lookups never ask a computer about made-up ids.
 */
const HOUR = 60 * 60 * 1000

const project = (id: string, name: string, color: string, sort_order: number): Project =>
  ({
    id,
    name,
    color,
    sort_order,
    starred: true,
    placements: [],
    resolved_computer_id: null,
    columns_config: null
  }) as unknown as Project

export const MOCK_PROJECTS: Project[] = [
  project('mock-p1', 'Acme Web', '#4ea4ff', 0),
  project('mock-p2', 'Mobile App', '#f2b84b', 1)
]

function task(
  id: string,
  projectId: string,
  title: string,
  extra: Partial<Task> & { order: number }
): Task {
  return {
    id,
    project_id: projectId,
    parent_id: null,
    title,
    status: 'todo',
    priority: 3,
    archived_at: null,
    is_temporary: false,
    is_blocked: false,
    snoozed_until: null,
    needs_attention: false,
    has_worktree: false,
    pinned: false,
    pin_order: 0,
    tree_collapsed: false,
    due_date: null,
    last_interaction_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...extra
  } as Task
}

/** Built relative to `now` so the Recent lens has something in each bucket. */
export function mockTasks(now: number): Task[] {
  return [
    task('mock-a', 'mock-p1', 'Checkout redesign', {
      order: 0,
      status: 'in_progress',
      priority: 2,
      last_interaction_at: now - HOUR
    }),
    task('mock-b', 'mock-p1', 'Fix login redirect', {
      order: 1,
      status: 'review',
      priority: 1,
      needs_attention: true,
      last_interaction_at: now - 2 * HOUR
    }),
    task('mock-c', 'mock-p1', 'Write release notes', {
      order: 2,
      status: 'todo',
      pinned: true
    }),
    task('mock-d', 'mock-p1', 'Card component', {
      order: 3,
      parent_id: 'mock-a',
      status: 'done',
      last_interaction_at: now - 30 * HOUR
    }),
    task('mock-e', 'mock-p1', 'Price formatting', {
      order: 4,
      parent_id: 'mock-a',
      status: 'in_progress',
      last_interaction_at: now - 3 * HOUR
    }),
    task('mock-f', 'mock-p2', 'Push notifications', {
      order: 0,
      status: 'todo',
      priority: 2,
      is_blocked: true,
      last_interaction_at: now - 4 * 24 * HOUR
    }),
    task('mock-g', 'mock-p2', 'Crash on launch', {
      order: 1,
      status: 'in_progress',
      priority: 1,
      needs_attention: true,
      last_interaction_at: now - 5 * HOUR
    }),
    task('mock-h', 'mock-p2', 'Scratch terminal', {
      order: 2,
      status: 'in_progress',
      priority: 5,
      is_temporary: true
    }),
    task('mock-i', 'mock-p2', 'Onboarding copy', {
      order: 3,
      status: 'done',
      priority: 4,
      last_interaction_at: now - 20 * 24 * HOUR
    })
  ]
}

/** The task shown in "How rows look": every row marker has something to show. */
export function previewRowTask(): Task {
  return task('mock-preview', 'mock-p1', 'Example task', {
    order: 0,
    status: 'in_progress',
    priority: 2,
    has_worktree: true,
    is_blocked: true
  })
}
