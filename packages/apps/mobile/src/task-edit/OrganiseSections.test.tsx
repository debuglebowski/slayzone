/**
 * Sub-tasks and tags on a task's own hub (the task page has the suites that show them in
 * place): a sub-task's typed title survives a refused create, and tag toggles reach the
 * hub one after another, the last one winning.
 */
import { act, fireEvent, render, screen, userEvent } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import type { BoardData, TaskRow } from '../hub-board'
import { boardOf, createFakeHubs, projectOf, taskOf, workHub } from '../hubs/testing'
import { SubtasksSection, TagsSection } from './OrganiseSections'
import { type Answer, serveTaskHub, writes } from './testing'
import { useTaskWrites } from './use-task-writes'

const mockHubs = createFakeHubs()
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: (props: { hubId: string; fallback?: ReactNode; children: ReactNode }) =>
    mockHubs.HubScope(props)
}))

const task = taskOf('t1', { title: 'Parent', project_id: 'p' })
const row: TaskRow = {
  key: `${workHub.id}\nt1`,
  hubId: workHub.id,
  hubLabel: workHub.label,
  task,
  project: projectOf('p')
}
const board = (): BoardData =>
  ({
    ...boardOf({ projects: [projectOf('p')], tasks: [task] }),
    tags: [
      { id: 'g1', name: 'design', color: 'c1', text_color: 't1', project_id: 'p' },
      { id: 'g2', name: 'bug', color: 'c2', text_color: 't2', project_id: 'p' }
    ]
  }) as BoardData

function Sections() {
  const w = useTaskWrites(task)
  return (
    <>
      <SubtasksSection row={row} board={board()} writes={w} onOpenTask={jest.fn()} />
      <TagsSection row={row} board={board()} writes={w} />
    </>
  )
}

async function show(answers: Record<string, Answer> = {}) {
  const calls = serveTaskHub(mockHubs, workHub.id, {
    'task.loadBoardData': () => board(),
    ...answers
  })
  await render(<>{mockHubs.HubScope({ hubId: workHub.id, children: <Sections /> })}</>)
  return calls
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  })

describe('SubtasksSection', () => {
  it('keeps the typed title when the hub refuses the sub-task, clears it once created', async () => {
    let refuse = true
    const calls = await show({
      'task.create': (input) => {
        if (refuse) throw new Error('hub said no')
        return { id: 's1', ...(input as object) }
      }
    })
    const user = userEvent.setup()
    await user.press(screen.getByTestId('add-subtask'))
    // Typed and Return pressed (the field keeps focus: it stays open).
    await fireEvent.changeText(screen.getByTestId('new-subtask-title'), 'Write docs')
    await fireEvent(screen.getByTestId('new-subtask-title'), 'submitEditing')
    await settle()
    expect(writes(calls).filter((c) => c.path === 'task.create')).toHaveLength(1)
    expect(screen.getByTestId('new-subtask-title')).toHaveDisplayValue('Write docs')

    refuse = false
    await fireEvent(screen.getByTestId('new-subtask-title'), 'submitEditing')
    await settle()
    expect(writes(calls).filter((c) => c.path === 'task.create')).toHaveLength(2)
    expect(screen.getByTestId('new-subtask-title')).toHaveDisplayValue('')
  })
})

describe('TagsSection', () => {
  it('rapid toggles reach the hub one at a time; the last set wins', async () => {
    const replies: Array<() => void> = []
    const calls = await show({
      'tags.setForTask': () =>
        new Promise<undefined>((resolve) => {
          replies.push(() => resolve(undefined))
        })
    })
    const user = userEvent.setup()
    await user.press(screen.getByTestId('edit-tags'))
    await user.press(screen.getByTestId('tag-g1'))
    await user.press(screen.getByTestId('tag-g2'))
    await user.press(screen.getByTestId('tag-g1'))
    await settle()
    const sets = () => writes(calls).filter((c) => c.path === 'tags.setForTask')
    // One write in flight; the others wait for it (and fold into the newest set).
    expect(sets()).toHaveLength(1)
    expect(sets()[0]?.input).toEqual({ taskId: 't1', tagIds: ['g1'] })
    await act(async () => replies.shift()?.())
    await settle()
    expect(sets()).toHaveLength(2)
    expect(sets()[1]?.input).toEqual({ taskId: 't1', tagIds: ['g2'] })
    await act(async () => replies.shift()?.())
    await settle()
    expect(sets()).toHaveLength(2)
    expect(screen.getByTestId('tag-g2')).toBeChecked()
    expect(screen.getByTestId('tag-g1')).not.toBeChecked()
  })
})
