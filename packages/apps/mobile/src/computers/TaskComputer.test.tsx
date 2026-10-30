import { render, screen, userEvent, waitFor, within } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import type { TaskRow } from '../hub-board'
import { createFakeHubs, homeHub, projectOf, taskOf, workHub } from '../hubs/testing'
import type { HubComputer } from './hub-computers'
import { TaskComputer } from './TaskComputer'

const mockHubs = createFakeHubs()
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: (props: { hubId: string; fallback?: ReactNode; children: ReactNode }) =>
    mockHubs.HubScope(props)
}))

const computer = (id: string, name: string, usable = true): HubComputer =>
  ({ id, name, connected: usable, usable, lastSeenAt: 1, revokedAt: null }) as HubComputer

const COMPUTERS = [computer('mini', 'mac-mini'), computer('laptop', 'laptop', false)]

/** A hub serving `computers`, recording every `computers.setTaskComputer`. */
function serveHub(
  hubId: string,
  setTaskComputer: (input: unknown) => unknown = () => ({ ok: true })
) {
  const calls: unknown[] = []
  mockHubs.serve(hubId, {
    procedures: {
      'computers.list': () => COMPUTERS,
      'computers.setTaskComputer': (input) => {
        calls.push(input)
        return setTaskComputer(input)
      }
    },
    subscriptions: { 'computers.onStatusChange': () => undefined }
  })
  return calls
}

function rowOn(hub: typeof workHub, computerId: string | null = null): TaskRow {
  const project = projectOf('p', { default_computer_id: 'mini', resolved_computer_id: 'mini' })
  return {
    key: `${hub.id}\nt1`,
    hubId: hub.id,
    hubLabel: hub.label,
    task: taskOf('t1', { computer_id: computerId }),
    project
  }
}

async function choose(label: string | RegExp) {
  const user = userEvent.setup()
  await user.press(await screen.findByTestId('task-computer-choice'))
  await user.press(within(screen.getByTestId('choice-sheet')).getByText(label))
}

describe('TaskComputer', () => {
  it("says which computer runs the task's agents: the project's when the task follows it", async () => {
    serveHub(workHub.id)
    await render(<TaskComputer row={rowOn(workHub)} />)
    expect(await screen.findByText('Runs on mac-mini')).toBeOnTheScreen()
    expect(screen.getByText('Inherit project default (mac-mini)')).toBeOnTheScreen()
  })

  it('moves the task to another computer on the hub that owns it, and only there', async () => {
    const homeCalls = serveHub(homeHub.id)
    const workCalls = serveHub(workHub.id)
    await render(<TaskComputer row={rowOn(workHub)} />)

    await choose(/^laptop/)
    await waitFor(() => expect(workCalls).toEqual([{ taskId: 't1', computerId: 'laptop' }]))
    expect(homeCalls).toEqual([])
    expect(screen.getByText('Runs on laptop')).toBeOnTheScreen()
  })

  it('offers an offline computer, marked, never disabled (work waits for it)', async () => {
    serveHub(workHub.id)
    await render(<TaskComputer row={rowOn(workHub)} />)
    const user = userEvent.setup()
    await user.press(await screen.findByTestId('task-computer-choice'))
    const sheet = within(screen.getByTestId('choice-sheet'))
    expect(sheet.getByText('laptop · offline')).toBeOnTheScreen()
    expect(sheet.getByTestId('choice-laptop')).not.toBeDisabled()
  })

  it('follows the project again: the binding is cleared (null)', async () => {
    const calls = serveHub(workHub.id)
    await render(<TaskComputer row={rowOn(workHub, 'laptop')} />)
    expect(await screen.findByText('Runs on laptop')).toBeOnTheScreen()

    await choose('Inherit project default (mac-mini)')
    await waitFor(() => expect(calls).toEqual([{ taskId: 't1', computerId: null }]))
  })

  it('shows the saved computer again when the hub refuses the change', async () => {
    serveHub(workHub.id, () => {
      throw new Error('No such computer')
    })
    await render(<TaskComputer row={rowOn(workHub)} />)

    await choose(/^laptop/)
    expect(
      await screen.findByText("Couldn't change the computer: No such computer")
    ).toBeOnTheScreen()
    expect(screen.getByText('Runs on mac-mini')).toBeOnTheScreen()
  })

  it('says why it can\'t list the hub\'s computers, rather than "no computers"', async () => {
    mockHubs.serve(workHub.id, {
      procedures: {
        'computers.list': () => {
          throw new Error('hub requires authentication')
        }
      },
      subscriptions: { 'computers.onStatusChange': () => undefined }
    })
    await render(<TaskComputer row={rowOn(workHub)} />)
    expect(await screen.findByText('hub requires authentication')).toBeOnTheScreen()
    expect(screen.queryByText('No computers — runs locally')).toBeNull()
  })

  it('says a hub without computers runs the task itself', async () => {
    mockHubs.serve(workHub.id, {
      procedures: { 'computers.list': () => [] },
      subscriptions: { 'computers.onStatusChange': () => undefined }
    })
    await render(<TaskComputer row={rowOn(workHub)} />)
    expect(await screen.findByText('No computers — runs locally')).toBeOnTheScreen()
  })
})
