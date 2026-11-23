import { fireEvent, render, screen } from '@testing-library/react-native'
import { taskOf } from '../hubs/testing'
import { TitleInput } from './TaskFields'
import type { TaskWrites } from './use-task-writes'

it('retains a local title edit when another client renames the same task', async () => {
  const writes = (title: string): TaskWrites => ({
    task: taskOf('same-id', { title }),
    update: jest.fn(async () => true),
    error: null,
    setError: jest.fn(),
    run: async (work) => work(),
    refresh: jest.fn()
  })
  const view = await render(<TitleInput writes={writes('Original title')} />)
  await fireEvent.changeText(screen.getByLabelText('Title'), 'Phone draft')
  expect(screen.getByLabelText('Title')).toHaveDisplayValue('Phone draft')
  await view.rerender(<TitleInput writes={writes('Renamed on desktop')} />)
  expect(screen.getByLabelText('Title')).toHaveDisplayValue('Phone draft')
})
