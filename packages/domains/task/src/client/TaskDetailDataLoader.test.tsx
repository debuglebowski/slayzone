// @vitest-environment jsdom
import React, { Suspense } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { createTrpcTest } from '@slayzone/transport/testing'
import { TASK_CARD_OMITTED_FIELDS, toCardRow, type Task } from '@slayzone/task-contracts'

const seen: Array<Task | null | undefined> = []
vi.mock('./TaskDetailPage', () => ({
  TaskDetailPage: (props: { initialData?: { task: Task | null } }) => {
    seen.push(props.initialData?.task)
    return <div data-testid="page" />
  }
}))

import { TaskDetailDataLoader, type TaskDetailDataLoaderProps } from './TaskDetailDataLoader'
import { taskDetailCache, type TaskDetailData } from './taskDetailCache'

afterEach(() => {
  cleanup()
  seen.length = 0
})

const fullRow = (): Task =>
  ({
    id: 'tFull',
    title: 'T',
    status: 'todo',
    ...Object.fromEntries([...TASK_CARD_OMITTED_FIELDS].map((f) => [f, null])),
    description: 'the body',
    provider_config: { mode: 'x' }
  }) as unknown as Task

const snapshot = (task: Task): TaskDetailData =>
  ({
    task,
    project: null,
    tags: [],
    taskTagIds: [],
    subTasks: [],
    parentTask: null
  }) as unknown as TaskDetailData

it('a detail primed from a card row waits for the full row before the page renders', async () => {
  const t = createTrpcTest({ procedures: { 'task.get': () => fullRow() } })
  taskDetailCache.prime('taskDetail', ['tFull', undefined], snapshot(toCardRow(fullRow())))
  const { findByTestId } = render(
    <Suspense fallback={null}>
      <TaskDetailDataLoader {...({ taskId: 'tFull' } as unknown as TaskDetailDataLoaderProps)} />
    </Suspense>,
    { wrapper: t.wrapper }
  )
  await findByTestId('page')
  await waitFor(() => expect(seen.length).toBeGreaterThan(0))
  for (const task of seen)
    expect(task).toMatchObject({ description: 'the body', provider_config: { mode: 'x' } })
})
