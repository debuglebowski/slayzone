import { describe, it, expect } from 'vitest'
import type { PaletteCommand } from '@slayzone/ui'
import { buildSearchItems, createFzf, groupResults, rankResults } from './SearchDialog.algorithm'

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
