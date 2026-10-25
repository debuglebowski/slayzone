import { describe, it, expect } from 'vitest'
import type { PaletteCommand } from '@slayzone/ui'
import {
  buildSearchItems,
  createFzf,
  firstResultValue,
  groupResults,
  rankResults
} from './SearchDialog.algorithm'

const taskCommands: PaletteCommand[] = [
  {
    id: 'status',
    label: 'Change status…',
    page: {
      kind: 'list',
      title: 'Status',
      items: [
        { id: 'status:todo', label: 'Todo', run: () => {} },
        { id: 'status:done', label: 'Done', run: () => {} }
      ]
    }
  },
  { id: 'archive', label: 'Archive task', run: () => {} }
]

const base = { fileContext: null, allFiles: [], tasks: [], projects: [] }

describe('buildSearchItems — task commands', () => {
  it('flattens sub-page items under their page title', () => {
    const items = buildSearchItems({ ...base, filter: 'all', taskCommands })
    const labels = items.filter((i) => i.kind === 'task-command').map((i) => i.label)
    expect(labels).toEqual(['Change status…', 'Status → Todo', 'Status → Done', 'Archive task'])
  })

  it('the task filter shows only task commands', () => {
    const items = buildSearchItems({ ...base, filter: 'task', taskCommands })
    expect(items.every((i) => i.kind === 'task-command')).toBe(true)
    expect(items).toHaveLength(4)
  })

  it('the actions filter leaves task commands out', () => {
    const items = buildSearchItems({
      ...base,
      filter: 'actions',
      taskCommands
    })
    expect(items.some((i) => i.kind === 'task-command')).toBe(false)
  })
})

describe('rankResults — task commands', () => {
  it('typing a status value finds the flattened sub-page item', () => {
    const items = buildSearchItems({ ...base, filter: 'all', taskCommands })
    const { fzfLabel, fzfPath } = createFzf(items)
    const results = rankResults(fzfLabel, fzfPath, 'done')
    expect(results[0]?.item.label).toBe('Status → Done')
  })

  it('task commands outrank an equally matching global action', () => {
    const items = buildSearchItems({
      ...base,
      filter: 'all',
      taskCommands: [{ id: 'settings', label: 'Open settings', run: () => {} }]
    })
    const { fzfLabel, fzfPath } = createFzf(items)
    const results = rankResults(fzfLabel, fzfPath, 'open settings')
    expect(results[0]?.item.kind).toBe('task-command')
    expect(groupResults(results).taskCommands).toHaveLength(1)
  })
})

describe('rankResults — match tiers', () => {
  const rank = (
    taskCommands: PaletteCommand[],
    q: string,
    tasks: { id: string; title: string }[] = []
  ) => {
    const items = buildSearchItems({
      ...base,
      filter: 'all',
      taskCommands,
      tasks: tasks.map((t) => ({ ...t, project_id: 'p', status: 'todo', priority: 3 })) as never
    })
    const { fzfLabel, fzfPath } = createFzf(items)
    return groupResults(rankResults(fzfLabel, fzfPath, q))
  }

  it('orders a group exact, then prefix, then word start (fzf scores these equal)', () => {
    const groups = rank([], 'review', [
      { id: 't1', title: 'Reviewer setup' },
      { id: 't2', title: 'Code review' },
      { id: 't3', title: 'review' },
      { id: 't4', title: 'Prereview notes' }
    ])
    expect(groups.tasks.map((r) => r.item.label)).toEqual([
      'review',
      'Reviewer setup',
      'Code review',
      'Prereview notes'
    ])
  })

  it('a sub-page value matches exactly on its own label or with its page title', () => {
    const groups = rank(
      [{ id: 'mark-done', label: 'Mark done', run: () => {} }, ...taskCommands],
      'done'
    )
    expect(groups.taskCommands[0]?.item.label).toBe('Status → Done')
    const withTitle = rank(taskCommands, 'status done')
    expect(withTitle.taskCommands[0]?.item.label).toBe('Status → Done')
  })
})

describe('rankResults — entity pages capped in root search', () => {
  const blockers: PaletteCommand = {
    id: 'blocked-by',
    label: 'Blocked by…',
    page: {
      kind: 'list',
      title: 'Blocked by',
      searchLimit: 5,
      items: Array.from({ length: 8 }, (_, i) => ({
        id: `blocker:${i}`,
        label: `Alpha task ${i}`,
        run: () => {}
      }))
    }
  }

  it('shows at most searchLimit hits from one page', () => {
    const items = buildSearchItems({ ...base, filter: 'all', taskCommands: [blockers] })
    const { fzfLabel, fzfPath } = createFzf(items)
    const hits = rankResults(fzfLabel, fzfPath, 'alpha task')
    expect(hits.filter((r) => r.item.label.startsWith('Blocked by →'))).toHaveLength(5)
  })

  it('inside the page itself every item stays searchable', () => {
    const page = blockers.page as Extract<PaletteCommand['page'], { kind: 'list' }>
    const items = buildSearchItems({ ...base, filter: 'task', taskCommands: page.items })
    const { fzfLabel, fzfPath } = createFzf(items)
    expect(rankResults(fzfLabel, fzfPath, 'alpha task')).toHaveLength(8)
  })
})

describe('firstResultValue', () => {
  it('selects the first row on screen, not the best overall hit', () => {
    const items = buildSearchItems({
      ...base,
      filter: 'all',
      taskCommands: [{ id: 'x', label: 'Open settings panel', run: () => {} }],
      tasks: [
        { id: 't1', title: 'settings', project_id: 'p', status: 'todo', priority: 3 }
      ] as never
    })
    const { fzfLabel, fzfPath } = createFzf(items)
    const groups = groupResults(rankResults(fzfLabel, fzfPath, 'settings'))
    // The exact task match is the best hit overall, but the task group renders first.
    expect(firstResultValue(groups)).toBe('task-command:cmd:x')
  })
})
