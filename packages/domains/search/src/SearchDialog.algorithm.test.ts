import { describe, it, expect } from 'vitest'
import type { PaletteCommand } from '@slayzone/ui'
import {
  buildSearchItems,
  createFzf,
  firstResultValue,
  groupResults,
  rankResults,
  resultValue
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
    const results = rankResults(fzfLabel, fzfPath, 'done', items)
    expect(results.find((r) => !r.context)?.item.label).toBe('Status → Done')
  })

  it('task commands outrank an equally matching global action', () => {
    const items = buildSearchItems({
      ...base,
      filter: 'all',
      taskCommands: [{ id: 'settings', label: 'Open settings', run: () => {} }]
    })
    const { fzfLabel, fzfPath } = createFzf(items)
    const results = rankResults(fzfLabel, fzfPath, 'open settings', items)
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
    return groupResults(rankResults(fzfLabel, fzfPath, q, items))
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
    expect(groups.taskCommands.find((r) => !r.context)?.item.label).toBe('Status → Done')
    const withTitle = rank(taskCommands, 'status done')
    expect(withTitle.taskCommands.find((r) => !r.context)?.item.label).toBe('Status → Done')
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
    const hits = rankResults(fzfLabel, fzfPath, 'alpha task', items)
    expect(hits.filter((r) => r.item.label.startsWith('Blocked by →'))).toHaveLength(5)
  })

  it('inside the page itself every item stays searchable', () => {
    const page = blockers.page as Extract<PaletteCommand['page'], { kind: 'list' }>
    const items = buildSearchItems({ ...base, filter: 'task', taskCommands: page.items })
    const { fzfLabel, fzfPath } = createFzf(items)
    expect(rankResults(fzfLabel, fzfPath, 'alpha task', items)).toHaveLength(8)
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
    const groups = groupResults(rankResults(fzfLabel, fzfPath, 'settings', items))
    // The exact task match is the best hit overall, but the task group renders first.
    expect(firstResultValue(groups)).toBe('task-command:cmd:x')
  })
})

describe('rankResults — sub-page items nest under their command', () => {
  const list = (id: string, label: string, title: string, values: string[]): PaletteCommand => ({
    id,
    label,
    page: {
      kind: 'list',
      title,
      items: values.map((v) => ({ id: `${id}:${v}`, label: v, run: () => {} }))
    }
  })
  const commands = [
    list('due', 'Set due date…', 'Due date', ['Today', 'Tomorrow']),
    { id: 'unsnooze', label: 'Unsnooze', run: () => {} },
    list('snooze', 'Snooze…', 'Snooze', ['In 1 hour', 'Tomorrow'])
  ]
  const search = (q: string) => {
    const items = buildSearchItems({ ...base, filter: 'all', taskCommands: commands })
    const { fzfLabel, fzfPath } = createFzf(items)
    return groupResults(rankResults(fzfLabel, fzfPath, q, items))
  }
  const rows = (q: string) =>
    search(q).taskCommands.map(
      (r) =>
        `${r.nested ? '  ' : ''}${r.nested ? (r.item as { command: PaletteCommand }).command.label : r.item.label}`
    )

  it('the command matching exactly ("…" ignored) tops the group, its items beneath', () => {
    expect(rows('snooze')).toEqual(['Snooze…', '  In 1 hour', '  Tomorrow', 'Unsnooze'])
  })

  it('an item matching alone brings its command along as context, but is the selection', () => {
    expect(rows('tomorrow')).toEqual(['Set due date…', '  Tomorrow', 'Snooze…', '  Tomorrow'])
    const groups = search('tomorrow')
    expect(firstResultValue(groups)).toBe('task-command:cmd:due:Tomorrow')
  })
})

describe('firstResultValue — best hit inside the top group', () => {
  it('selects the exact sub-page item even when its command row (a weaker hit) heads the block', () => {
    // Keywords make the command row itself a (fuzzy) hit for the query.
    const withKeywords = taskCommands.map((c) =>
      c.id === 'status' ? { ...c, keywords: 'status column done' } : c
    )
    const items = buildSearchItems({ ...base, filter: 'all', taskCommands: withKeywords })
    const { fzfLabel, fzfPath } = createFzf(items)
    const groups = groupResults(rankResults(fzfLabel, fzfPath, 'status done', items))
    expect(groups.taskCommands[0]?.context).toBeFalsy()
    expect(groups.taskCommands[0]?.item.label).toBe('Change status…')
    expect(firstResultValue(groups)).toBe('task-command:cmd:status:done')
  })
})

describe('firstResultValue — entity picks never default over the entity itself', () => {
  // A capped entity page ("Blocked by…") lists OTHER tasks/projects. Its rows match
  // those entities' titles exactly, so with a task open, typing another task's title
  // + Enter used to mark it as a blocker instead of opening it.
  const entityPage = (id: string, label: string, title: string, values: string[]) =>
    ({
      id,
      label,
      page: {
        kind: 'list',
        title,
        searchLimit: 5,
        items: values.map((v) => ({ id: `${id}:${v}`, label: v, run: () => {} }))
      }
    }) satisfies PaletteCommand
  const select = (
    q: string,
    tasks: { id: string; title: string }[] = [],
    projects: { id: string; name: string }[] = []
  ) => {
    const items = buildSearchItems({
      ...base,
      filter: 'all',
      taskCommands: [
        entityPage('blocked-by', 'Blocked by…', 'Blocked by', ['Release notes']),
        entityPage('move', 'Move to project…', 'Move to project', ['Website'])
      ],
      tasks: tasks.map((t) => ({ ...t, project_id: 'p', status: 'todo', priority: 3 })) as never,
      projects: projects.map((p) => ({ ...p, color: '#000' })) as never
    })
    const { fzfLabel, fzfPath } = createFzf(items)
    const groups = groupResults(rankResults(fzfLabel, fzfPath, q, items))
    return { groups, selected: firstResultValue(groups) }
  }

  it('an equally matching task is selected over the pick naming it', () => {
    const { groups, selected } = select('release notes', [{ id: 't1', title: 'Release notes' }])
    expect(groups.taskCommands.some((r) => !r.context)).toBe(true) // pick still listed
    expect(selected).toBe(resultValue(groups.tasks[0]!))
  })

  it('an equally matching project is selected over the pick naming it', () => {
    const { groups, selected } = select('website', [], [{ id: 'p1', name: 'Website' }])
    expect(selected).toBe(resultValue(groups.projects[0]!))
  })

  it('the pick stays the selection when no task or project matches as well', () => {
    const { selected } = select('release notes', [{ id: 't1', title: 'Release planning notes' }])
    expect(selected).toBe('task-command:cmd:blocked-by:Release notes')
  })
})
