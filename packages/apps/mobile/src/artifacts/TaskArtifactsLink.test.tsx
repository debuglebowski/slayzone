import { act, render, screen, userEvent } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { trpcTest } from '../testing'
import { artifactRow, fakeArtifactsHub } from './fake-artifacts-hub'
import { TaskArtifactsLink } from './TaskArtifactsLink'

const mockPush = jest.fn()
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }))
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: ({ children }: { children: ReactNode }) => children
}))

describe('TaskArtifactsLink', () => {
  it("shows how many artifacts the task has, live, and opens the task's list", async () => {
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', 'plan.md')] })
    const { wrapper } = trpcTest(hub.backend)
    await render(<TaskArtifactsLink hubId="hub:x" hubAddress="hub.example:8443" taskId="t1" />, {
      wrapper
    })
    await screen.findByText('1 ›')

    hub.state.artifacts = [...hub.state.artifacts, artifactRow('a2', 'b.md')]
    await act(async () => hub.emit('notify.onTasksChanged', { taskIds: ['t1'] }))
    await screen.findByText('2 ›')

    await userEvent.setup().press(screen.getByTestId('task-artifacts-link'))
    expect(mockPush).toHaveBeenCalledWith('/artifacts/hub.example%3A8443/t1')
  })
})
