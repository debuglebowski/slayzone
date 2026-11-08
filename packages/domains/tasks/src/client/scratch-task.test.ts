import { describe, expect, it } from 'vitest'
import { keepScratchTaskInput, scratchTaskInput } from './scratch-task'

const columns = [
  {
    id: 'inbox',
    label: 'Inbox',
    color: 'gray',
    position: 0,
    category: 'unstarted' as const
  },
  {
    id: 'doing',
    label: 'Doing',
    color: 'blue',
    position: 1,
    category: 'started' as const
  },
  {
    id: 'done',
    label: 'Done',
    color: 'green',
    position: 2,
    category: 'completed' as const
  }
]

describe('scratchTaskInput', () => {
  it('numbers past the highest "Terminal N" in the project', () => {
    const tasks = [
      { project_id: 'p', title: 'Terminal 2' },
      { project_id: 'p', title: 'Terminal 7' },
      { project_id: 'p', title: 'Terminal 7 notes' },
      { project_id: 'other', title: 'Terminal 40' }
    ]
    expect(scratchTaskInput({ id: 'p', columns_config: columns }, tasks)).toEqual({
      projectId: 'p',
      title: 'Terminal 8',
      status: 'inbox',
      isTemporary: true,
      openAfterCreate: true
    })
  })

  it('starts at 1 in a project with none', () => {
    expect(scratchTaskInput({ id: 'p', columns_config: null }, []).title).toBe('Terminal 1')
  })
})

describe('keepScratchTaskInput', () => {
  it('turns it into a started, permanent task', () => {
    expect(keepScratchTaskInput('t', columns)).toEqual({
      id: 't',
      title: 'Untitled task',
      status: 'doing',
      isTemporary: false
    })
  })
})
