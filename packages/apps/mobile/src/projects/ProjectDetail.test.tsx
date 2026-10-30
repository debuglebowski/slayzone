import { render, screen, userEvent, waitFor, within } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { Alert } from 'react-native'
import type { HubComputer } from '../computers/hub-computers'
import type { BoardProject } from '../hub-board'
import { createFakeHubs, homeHub, projectOf, taskOf, workHub } from '../hubs/testing'
import type { ProjectRow } from './hub-projects'
import { ProjectDetail } from './ProjectDetail'

const mockHubs = createFakeHubs()
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: (props: { hubId: string; fallback?: ReactNode; children: ReactNode }) =>
    mockHubs.HubScope(props)
}))

const computer = (id: string, name: string, usable = true): HubComputer =>
  ({ id, name, connected: usable, usable, lastSeenAt: null, revokedAt: null }) as HubComputer

const COMPUTERS = [computer('mini', 'mac-mini'), computer('laptop', 'laptop', false)]

type Calls = Array<{ path: string; input: unknown }>

/** A hub with `COMPUTERS`, a browsable `/Users/me`, recording every write. */
function serveHub(hubId: string, fail: Record<string, string> = {}): Calls {
  const calls: Calls = []
  const write = (path: string) => (input: unknown) => {
    calls.push({ path, input })
    if (fail[path]) throw new Error(fail[path])
    return { ok: true }
  }
  mockHubs.serve(hubId, {
    procedures: {
      'computers.list': () => COMPUTERS,
      'workspace.listRoots': () => ({
        computerId: 'laptop',
        isLocal: false,
        roots: ['/Users/me'],
        home: '/Users/me',
        platform: 'darwin',
        sep: '/'
      }),
      'workspace.listDir': (input: { path: string }) => ({
        computerId: 'laptop',
        path: input.path,
        parent: null,
        entries: [{ name: 'app', path: `${input.path}/app`, type: 'directory', isGitRepo: true }]
      }),
      'workspace.setProjectPath': write('workspace.setProjectPath'),
      'workspace.forgetProjectPath': write('workspace.forgetProjectPath'),
      'computers.setProjectDefaultComputer': write('computers.setProjectDefaultComputer')
    },
    subscriptions: { 'computers.onStatusChange': () => undefined }
  })
  return calls
}

const PROJECT = projectOf('p', {
  name: 'Website',
  default_computer_id: 'mini',
  resolved_computer_id: 'mini',
  placements: [
    { computer_id: 'mini', path: '/Users/me/site', status: 'ready' },
    { computer_id: 'gone', path: '/old/site', status: 'refused' }
  ]
})

function rowOf(project: BoardProject = PROJECT, hub = workHub): ProjectRow {
  return { key: `${hub.id}\n${project.id}`, hubId: hub.id, hubLabel: hub.label, project }
}

function setup(project?: BoardProject) {
  const onOpenTask = jest.fn()
  const tasks = [
    {
      key: 'k',
      hubId: workHub.id,
      hubLabel: workHub.label,
      task: taskOf('t1', { title: 'Ship it' }),
      project: PROJECT
    }
  ]
  const ui = <ProjectDetail row={rowOf(project)} tasks={tasks} showHub onOpenTask={onOpenTask} />
  return { ui, onOpenTask }
}

const folderRow = (computerId: string) => within(screen.getByTestId(`folder-${computerId}`))

afterEach(() => jest.restoreAllMocks())

describe('ProjectDetail', () => {
  it("shows the project's folder on every computer, with each computer's state", async () => {
    serveHub(workHub.id)
    const { ui } = setup()
    await render(ui)

    expect(screen.getByText('Website')).toBeOnTheScreen()
    expect(screen.getByText(workHub.label)).toBeOnTheScreen()
    const mini = await waitFor(() => folderRow('mini'))
    expect(mini.getByText('/Users/me/site')).toBeOnTheScreen()
    expect(mini.getByText('Default')).toBeOnTheScreen()
    expect(mini.getByText('Connected')).toBeOnTheScreen()
    expect(folderRow('laptop').getByText('No folder')).toBeOnTheScreen()
    expect(folderRow('laptop').getByText('Never connected')).toBeOnTheScreen()
    const gone = folderRow('gone')
    expect(gone.getByText('Unknown computer')).toBeOnTheScreen()
    expect(gone.getByText('Outside the folders this computer allows')).toBeOnTheScreen()
  })

  it("sets a computer's folder through that hub, by browsing that computer", async () => {
    const homeCalls = serveHub(homeHub.id)
    const calls = serveHub(workHub.id)
    const { ui } = setup()
    await render(ui)
    const user = userEvent.setup()

    await user.press(await waitFor(() => folderRow('laptop').getByText('Pick folder')))
    await user.press(await screen.findByText('app'))
    await user.press(screen.getByText('Select'))
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: 'workspace.setProjectPath',
        input: { computerId: 'laptop', projectId: 'p', path: '/Users/me/app' }
      })
    )
    expect(homeCalls).toEqual([])
  })

  it("says why a computer refused a folder (desktop's words)", async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    serveHub(workHub.id, {
      'workspace.setProjectPath': "'/Users/me/app' is outside the folders this computer allows"
    })
    const { ui } = setup()
    await render(ui)
    const user = userEvent.setup()

    await user.press(await waitFor(() => folderRow('mini').getByText('Change')))
    await user.press(await screen.findByText('app'))
    await user.press(screen.getByText('Select'))
    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith(
        "Couldn't use that folder",
        "'/Users/me/app' is outside the folders this computer allows"
      )
    )
  })

  it("removes a computer's folder (the folder itself stays)", async () => {
    const calls = serveHub(workHub.id)
    const { ui } = setup()
    await render(ui)
    const user = userEvent.setup()

    await user.press(await waitFor(() => folderRow('mini').getByText('Remove')))
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: 'workspace.forgetProjectPath',
        input: { computerId: 'mini', projectId: 'p' }
      })
    )
  })

  it('changes the computer the project runs on by default', async () => {
    const calls = serveHub(workHub.id)
    const { ui } = setup()
    await render(ui)
    const user = userEvent.setup()

    await user.press(await screen.findByTestId('project-default-computer'))
    const sheet = within(screen.getByTestId('choice-sheet'))
    expect(sheet.getByText('Local')).toBeOnTheScreen()
    await user.press(sheet.getByText('laptop · offline'))
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: 'computers.setProjectDefaultComputer',
        input: { projectId: 'p', computerId: 'laptop' }
      })
    )
  })

  it("says why it can't list the hub's computers, and guesses no computer names", async () => {
    mockHubs.serve(workHub.id, {
      procedures: {
        'computers.list': () => {
          throw new Error('hub requires authentication')
        }
      },
      subscriptions: { 'computers.onStatusChange': () => undefined }
    })
    const { ui } = setup()
    await render(ui)
    expect(await screen.findByText('hub requires authentication')).toBeOnTheScreen()
    expect(screen.queryByText('Unknown computer')).toBeNull()
  })

  it("shows an older hub's one folder for every computer, read-only", async () => {
    serveHub(workHub.id)
    const legacy = { ...projectOf('p', { name: 'Old' }), placements: undefined, path: '/srv/old' }
    const { ui } = setup(legacy as unknown as BoardProject)
    await render(ui)
    expect(await screen.findByText('/srv/old')).toBeOnTheScreen()
    expect(screen.queryByText('Change')).toBeNull()
  })

  it("opens the project's tasks", async () => {
    serveHub(workHub.id)
    const { ui, onOpenTask } = setup()
    await render(ui)
    await userEvent.setup().press(screen.getByText('Ship it'))
    expect(onOpenTask).toHaveBeenCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ id: 't1' }) })
    )
  })
})
