// @vitest-environment jsdom
// The artifact viewer's view state: the view mode (preview / split / raw) and the find
// bar (open, query). Selecting an artifact resets both (to that artifact's saved view
// mode, else the appearance default; find bar closed). Task tabs live in <Activity>,
// which tears effects down on hide and re-runs them on show — and the reset rode on an
// effect, so a plain tab switch also closed the find bar and put back the saved view
// mode over one picked since (from a search hit, or with its save still in flight).
// The same reset, a commit after a search hit in another artifact, wiped the hit's
// query and raw view; and it read the saved view mode only as of the selection, so
// with the artifacts still loading then, the default showed until the next tab show.
// Pins: the reset on a selection change, the saved view mode on mount.
import { Activity, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RENDER_MODE_INFO,
  type ArtifactsSidebarState,
  type TaskArtifact
} from '@slayzone/task-contracts'
import type { ArtifactDevicePreview } from './ArtifactDevicePicker'
import type { ArtifactsPanelHandle } from './ArtifactsPanel.types'
import { detectPlatform, toast, useShortcutStore } from '@slayzone/ui'

const uploads = vi.hoisted(() => ({
  hubId: 'local',
  uploadPath: vi.fn(),
  uploadBlob: vi.fn(),
  showOpenDialog: vi.fn()
}))

type Row = Pick<TaskArtifact, 'id' | 'task_id' | 'title' | 'folder_id' | 'render_mode'> & {
  view_mode: string | null
}

// The server: t1's artifacts. `updateGate`, when set, holds every update in flight.
const server: {
  rows: Row[]
  folders: Array<{ id: string; task_id: string; parent_id: string | null; name: string }>
  updateGate: Promise<void> | null
} = { rows: [], folders: [], updateGate: null }

// A stable tRPC view, like the real provider's: one proxy object per path.
vi.mock('./trpc', () => {
  const nodes = new Map<string, unknown>()
  const queryFn = (path: string, input: { taskId?: string } | undefined) => async () => {
    if (path === 'artifacts.getByTask')
      return server.rows.filter((r) => r.task_id === input?.taskId).map((r) => ({ ...r }))
    if (path === 'artifacts.foldersGetByTask') return server.folders.map((f) => ({ ...f }))
    if (path === 'app.clipboard.hasFiles') return false
    return null
  }
  const mutationFn = (path: string) => async (input: { id?: string; viewMode?: string }) => {
    if (path === 'artifacts.upload') return uploads.uploadPath(input)
    if (path === 'artifacts.uploadBlob') return uploads.uploadBlob(input)
    if (path === 'app.dialog.showOpenDialog') return uploads.showOpenDialog(input)
    if (path !== 'artifacts.update') return null
    if (server.updateGate) await server.updateGate
    const row = server.rows.find((r) => r.id === input.id)
    if (!row) return null
    if (input.viewMode !== undefined) row.view_mode = input.viewMode
    return { ...row }
  }
  const node = (path: string[]): unknown => {
    const key = path.join('.')
    const existing = nodes.get(key)
    if (existing) return existing
    const leaf: Record<string, unknown> = {
      queryOptions: (input: { taskId?: string } | undefined, opts?: object) => ({
        queryKey: [path, { input, type: 'query' }],
        queryFn: queryFn(key, input),
        ...opts
      }),
      mutationOptions: () => ({ mutationFn: mutationFn(key) })
    }
    const proxy = new Proxy(leaf, {
      get: (target, prop: string) => (prop in target ? target[prop] : node([...path, prop]))
    })
    nodes.set(key, proxy)
    return proxy
  }
  const trpc = node([])
  return { useTRPC: () => trpc, useTRPCClient: () => trpc }
})
vi.mock('@slayzone/telemetry/client', () => {
  const tracker = {
    track: vi.fn(),
    trackTask: vi.fn(),
    trackProject: vi.fn(),
    trackShortcut: vi.fn()
  }
  return { useTrack: () => tracker }
})
vi.mock('@slayzone/transport/client', () => ({
  electronBootstrap: { getDropPaths: () => [] },
  useHubId: () => uploads.hubId,
  useHubRegistryStore: (select: (state: object) => unknown) =>
    select({
      defaultHubId: 'local',
      hubs: [
        { id: 'local', kind: 'local' },
        { id: 'remote', kind: 'remote' }
      ]
    })
}))
const appearance = {
  editorMarkdownViewMode: 'rich',
  notesReadability: 'normal',
  notesWidth: 'narrow',
  notesFontFamily: 'sans',
  editorMinimapEnabled: false,
  editorTocEnabled: false
}
vi.mock('@slayzone/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/ui')>()),
  useAppearance: () => appearance
}))
// The viewer, reduced to the props under test.
vi.mock('./ArtifactContentEditor', () => ({
  ArtifactContentEditor: ({
    artifact,
    viewMode,
    searchQuery,
    devicePreviews,
    showDeviceFrame
  }: {
    artifact: TaskArtifact
    viewMode: string
    searchQuery: string
    devicePreviews?: readonly ArtifactDevicePreview[]
    showDeviceFrame?: boolean
  }) => {
    const primary = devicePreviews?.find(({ slot }) => slot === 'primary')
    const format = ({ viewport }: ArtifactDevicePreview) => viewport.width + '×' + viewport.height
    return (
      <div
        data-testid="viewer"
        data-artifact={artifact.id}
        data-view-mode={viewMode}
        data-search={searchQuery}
        data-device-frame={showDeviceFrame ? primary?.frame?.device.id : undefined}
        data-viewports={devicePreviews?.map(format).join(', ')}
        data-viewport={primary && format(primary)}
      />
    )
  }
}))
// The search sidebar, reduced to one hit per artifact (a "needle" match).
vi.mock('./ArtifactSearchPanel', () => ({
  ArtifactSearchPanel: ({
    artifacts,
    onSelectResult
  }: {
    artifacts: TaskArtifact[]
    onSelectResult: (
      id: string,
      payload: { query: string; matchCase: boolean; useRegex: boolean; matchIndex: number }
    ) => void
  }) => (
    <div>
      {artifacts.map((a) => (
        <button
          key={a.id}
          data-testid={`hit-${a.id}`}
          onClick={() =>
            onSelectResult(a.id, {
              query: 'needle',
              matchCase: true,
              useRegex: false,
              matchIndex: 0
            })
          }
        />
      ))}
    </div>
  )
}))
vi.mock('./VersionsPanel', () => ({ VersionsPanel: () => null }))

const { ArtifactsPanel } = await import('./ArtifactsPanel')

const row = (id: string, viewMode: string | null = null): Row => ({
  id,
  task_id: 't1',
  title: `${id}.md`,
  folder_id: null,
  render_mode: null,
  view_mode: viewMode
})

let client: QueryClient
const handle = createRef<ArtifactsPanelHandle>()

function Tab({ mode, saved = 'a1' }: { mode: 'visible' | 'hidden'; saved?: string | null }) {
  return (
    <QueryClientProvider client={client}>
      <Activity mode={mode}>
        <ArtifactsPanel ref={handle} taskId="t1" initialActiveArtifactId={saved} />
      </Activity>
    </QueryClientProvider>
  )
}

const viewer = () => screen.getByTestId('viewer')
const findInput = () => screen.queryByPlaceholderText<HTMLInputElement>('Find...')
/** Let pending timers up to `ms` fire, and the renders they cause land. */
const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
/** Every query (and, unless held, mutation) finished, and its result rendered. */
async function idle({ mutations = true } = {}) {
  await waitFor(() => expect(client.isFetching()).toBe(0))
  if (mutations) await waitFor(() => expect(client.isMutating()).toBe(0))
  await settle(10)
}

async function mountLoaded(saved = 'a1') {
  const view = render(<Tab mode="visible" saved={saved} />)
  await waitFor(() => expect(viewer().dataset.artifact).toBe(saved))
  await idle()
  return view
}
const select = (id: string) => act(() => handle.current?.selectArtifact(id))
function chooseViewMode(label: 'Preview' | 'Split' | 'Raw') {
  fireEvent.click(screen.getByRole('button', { name: /^View mode:/ }))
  fireEvent.click(screen.getByRole('button', { name: label }))
}
function openFind(query: string) {
  fireEvent.keyDown(viewer(), { key: 'f', metaKey: true })
  const input = findInput()
  if (!input) throw new Error('find bar did not open')
  fireEvent.change(input, { target: { value: query } })
}
async function switchAwayAndBack(view: ReturnType<typeof render>, saved = 'a1') {
  view.rerender(<Tab mode="hidden" saved={saved} />)
  view.rerender(<Tab mode="visible" saved={saved} />)
  await idle({ mutations: false })
}

beforeEach(() => {
  uploads.hubId = 'local'
  uploads.uploadPath.mockReset()
  uploads.uploadBlob.mockReset()
  uploads.showOpenDialog.mockReset()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  useShortcutStore.setState({ overrides: {}, isRecording: false })
  server.rows = [row('a1'), row('a2', 'raw'), row('a3')]
  server.folders = []
  server.updateGate = null
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } })
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.unstubAllGlobals()
})

it('pins actions per artifact and can save them as a default for its render type', async () => {
  server.rows = [row('a1'), row('a2'), { ...row('a3'), title: 'page.html' }, row('a4')]
  try {
    const view = await mountLoaded()
    const openMore = () =>
      fireEvent.click(screen.getByRole('button', { name: 'More artifact actions' }))
    expect(screen.queryByTestId('artifact-zoom')).toBeNull()
    openMore()
    const pin = screen.getByRole('button', { name: 'Pin Zoom' })
    act(() => pin.focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe('Pin Zoom')
    fireEvent.click(pin)
    expect(screen.getByTestId('artifact-zoom')).toBeTruthy()
    act(() => screen.getByRole('button', { name: 'Zoom' }).focus())
    act(() => screen.getByRole('button', { name: 'Unpin Zoom' }).focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe('Unpin Zoom')
    fireEvent.click(screen.getByRole('button', { name: 'More artifact actions' }))

    select('a2')
    expect(screen.queryByTestId('artifact-zoom')).toBeNull()
    openMore()
    fireEvent.click(screen.getByRole('button', { name: 'Pin Download' }))

    select('a1')
    openMore()
    fireEvent.click(screen.getByRole('button', { name: 'Set as default for Rich Text' }))
    expect(screen.getByRole('button', { name: 'Saved as default for Rich Text' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unpin Zoom' })).toBeTruthy()

    select('a4')
    expect(screen.getByTestId('artifact-zoom')).toBeTruthy()
    select('a2')
    expect(screen.queryByTestId('artifact-zoom')).toBeNull()
    openMore()
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(screen.getByTestId('artifact-zoom')).toBeTruthy()

    select('a3')
    expect(screen.queryByTestId('artifact-zoom')).toBeNull()
    expect(screen.getByRole('button', { name: 'Device preview' })).toBeTruthy()

    view.unmount()
    await mountLoaded('a2')
    expect(screen.getByTestId('artifact-zoom')).toBeTruthy()
  } finally {
    cleanup()
    window.localStorage.clear()
  }
})

it('keeps render formats, export options and Markdown display settings in More', async () => {
  server.rows = [
    row('a1'),
    { ...row('a2'), title: 'page.html' },
    { ...row('a3'), title: 'document.pdf' }
  ]
  await mountLoaded()
  const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
  click('More artifact actions')
  click('Display')
  expect(screen.getByRole('dialog', { name: 'Artifact actions' })).toBeTruthy()
  expect(['left', 'right']).toContain(
    screen.getByRole('dialog', { name: 'Display' }).getAttribute('data-side')
  )
  for (const name of ['Outline', /Minimap/, 'Compact', 'Wide', 'Use mono font']) {
    expect(screen.getByRole('switch', { name })).toBeTruthy()
  }
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
  expect(screen.getByRole('button', { name: 'Display' })).toBe(document.activeElement)
  click('Zoom')
  expect(['left', 'right']).toContain(
    screen.getByRole('dialog', { name: 'Zoom' }).getAttribute('data-side')
  )
  expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeTruthy()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.getByRole('button', { name: 'Zoom' })).toBe(document.activeElement)
  const format = screen.getByRole('button', { name: 'Render as' })
  act(() => format.focus())
  fireEvent.keyDown(format, { key: 'ArrowRight' })
  expect(screen.getByRole('dialog', { name: 'Artifact actions' })).toBeTruthy()
  expect(screen.getByRole('dialog', { name: 'Render as' })).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Auto (Rich Text)' }))
  for (const { label } of Object.values(RENDER_MODE_INFO)) {
    expect(screen.getByRole('button', { name: label })).toBeTruthy()
  }
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rich Text' }))
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
  expect(screen.queryByRole('dialog', { name: 'Render as' })).toBeNull()
  expect(document.activeElement).toBe(format)
  const download = screen.getByRole('button', { name: 'Download' })
  fireEvent.pointerEnter(download, { pointerType: 'mouse' })
  const downloadMenu = await screen.findByRole('dialog', { name: 'Download' })
  expect(['left', 'right']).toContain(downloadMenu.getAttribute('data-side'))
  fireEvent.pointerLeave(download, { pointerType: 'mouse' })
  fireEvent.pointerEnter(downloadMenu, { pointerType: 'mouse' })
  await settle(225)
  expect(screen.getByRole('dialog', { name: 'Download' })).toBe(downloadMenu)
  expect(document.activeElement).toBe(format)
  for (const name of [
    'Download original',
    'Download as PDF',
    'Download as HTML',
    'Download all as ZIP'
  ]) {
    expect(screen.getByRole('button', { name })).toBeTruthy()
  }

  select('a2')
  click('More artifact actions')
  click('Theme')
  for (const name of ['System theme', 'Dark (forced)', 'Light (forced)']) {
    expect(screen.getByRole('button', { name })).toBeTruthy()
  }

  select('a3')
  click('More artifact actions')
  expect(screen.queryByRole('button', { name: 'Zoom' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Versions' })).toBeTruthy()
  click('Download')
  expect(screen.getByRole('button', { name: 'Download original' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Download as PDF' })).toBeNull()
})

describe('ArtifactsPanel device preview persistence', () => {
  const scrollIntoView = HTMLElement.prototype.scrollIntoView

  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView ??= () => undefined
    server.rows = [
      { ...row('a1', 'split'), title: 'first.html' },
      { ...row('a2'), title: 'other.html' }
    ]
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
  })

  it('keeps the device, foldable mode, rotation and frame setting per artifact after reopening', async () => {
    const view = await mountLoaded()
    expect(viewer().dataset.viewMode).toBe('split')
    fireEvent.click(screen.getByRole('button', { name: 'Device preview' }))
    fireEvent.click(await screen.findByRole('option', { name: 'iPhone Duo' }))
    expect(viewer().dataset.viewport).toBe('466×678')
    expect(viewer().dataset.deviceFrame).toBe('iphone-duo')
    expect(screen.getByRole('button', { name: 'Switch to Unfolded' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Search devices' })).toBeNull()

    const devicePicker = screen.getByRole('button', { name: /^Device preview, iPhone Duo/ })
    fireEvent.click(devicePicker)
    const showFrame = screen.getByRole('switch', { name: 'Show device frame' })
    expect(showFrame.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(showFrame)
    expect(viewer().dataset.deviceFrame).toBeUndefined()
    expect(viewer().dataset.viewport).toBe('466×678')
    fireEvent.click(showFrame)
    expect(viewer().dataset.deviceFrame).toBe('iphone-duo')

    fireEvent.click(screen.getByRole('button', { name: 'Both' }))
    expect(viewer().dataset.viewports).toBe('466×678, 951×669')
    const screenSwitcher = screen.getByRole('button', { name: 'Switch to Cover' })
    fireEvent.click(screenSwitcher)
    expect(viewer().dataset.viewports).toBe('466×678')

    expect(screen.getByRole('button', { name: 'Switch to Unfolded' })).toBe(screenSwitcher)
    fireEvent.click(screenSwitcher)
    expect(viewer().dataset.viewport).toBe('951×669')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to portrait' }))
    expect(viewer().dataset.viewport).toBe('669×951')
    expect(screen.getByRole('button', { name: 'Switch to Both' })).toBe(screenSwitcher)
    fireEvent.click(screenSwitcher)
    expect(viewer().dataset.viewports).toBe('678×466, 669×951')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Cover' }))
    expect(viewer().dataset.viewport).toBe('678×466')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Unfolded' }))
    expect(viewer().dataset.viewport).toBe('669×951')

    select('a2')
    expect(viewer().dataset.viewport).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Device preview' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Surface Duo' }))
    expect(viewer().dataset.viewport).toBe('540×720')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Dual screen' }))
    expect(viewer().dataset.viewport).toBe('1114×720')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Both' }))
    expect(viewer().dataset.viewports).toBe('540×720, 1114×720')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Single screen' }))
    expect(viewer().dataset.viewport).toBe('540×720')

    select('a1')
    expect(viewer().dataset.viewport).toBe('669×951')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Both' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Device preview, iPhone Duo, both screens' })
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Show device frame' }))

    view.unmount()
    await mountLoaded()
    expect(viewer().dataset.viewports).toBe('678×466, 669×951')
    expect(viewer().dataset.viewport).toBe('669×951')
    expect(viewer().dataset.deviceFrame).toBeUndefined()
    select('a2')
    expect(viewer().dataset.viewport).toBe('540×720')
    expect(viewer().dataset.deviceFrame).toBe('surface-duo')
  })

  it('restores a rotated custom size and remembers switching back to fit to pane', async () => {
    const view = await mountLoaded()
    fireEvent.click(screen.getByRole('button', { name: 'Device preview' }))
    const sizing = screen.getByRole('group', { name: 'Viewport sizing' })
    expect(sizing.contains(screen.getByRole('button', { name: 'Fit to pane' }))).toBe(true)
    expect(sizing.compareDocumentPosition(screen.getByRole('listbox'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    const customSize = screen.getByRole('button', { name: 'Custom size' })
    expect(sizing.contains(customSize)).toBe(true)
    fireEvent.click(customSize)
    const width = screen.getByRole('spinbutton', { name: 'Viewport width' })
    expect(document.activeElement).toBe(width)
    expect(fireEvent.keyDown(width, { key: 'ArrowUp' })).toBe(true)
    fireEvent.change(width, {
      target: { value: '700' }
    })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Viewport height' }), {
      target: { value: '900' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch to landscape' }))

    view.unmount()
    const reopened = await mountLoaded()
    expect(viewer().dataset.viewport).toBe('900×700')
    fireEvent.click(screen.getByRole('button', { name: 'Device preview, Custom, 900 by 700' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fit to pane' }))

    reopened.unmount()
    await mountLoaded()
    expect(viewer().dataset.viewport).toBeUndefined()
  })

  it('keeps foldable screens and rotation reachable after Device is unpinned', async () => {
    await mountLoaded()
    const openMore = () =>
      fireEvent.click(screen.getByRole('button', { name: 'More artifact actions' }))
    const openDevice = () => fireEvent.click(screen.getByRole('button', { name: 'Device' }))

    openMore()
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Device' }))
    expect(screen.queryByRole('button', { name: 'Device preview' })).toBeNull()
    openDevice()
    const search = screen.getByRole('combobox', { name: 'Search devices' })
    expect(document.activeElement).toBe(search)
    expect(fireEvent.keyDown(search, { key: 'ArrowLeft' })).toBe(true)
    expect(['left', 'right']).toContain(
      screen.getByRole('dialog', { name: 'Device' }).getAttribute('data-side')
    )
    fireEvent.click(await screen.findByRole('option', { name: 'iPhone Duo' }))
    expect(viewer().dataset.viewport).toBe('466×678')

    openMore()
    openDevice()
    fireEvent.click(screen.getByRole('switch', { name: 'Show device frame' }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch to landscape' }))
    fireEvent.click(screen.getByRole('button', { name: 'Both' }))
    expect(viewer().dataset.viewports).toBe('678×466, 669×951')
    expect(viewer().dataset.deviceFrame).toBeUndefined()

    openMore()
    openDevice()
    fireEvent.change(screen.getByRole('combobox', { name: 'Search devices' }), {
      target: { value: 'Fit' }
    })
    fireEvent.click(await screen.findByRole('option', { name: 'Fit to pane' }))
    expect(viewer().dataset.viewport).toBeUndefined()
  })
})

describe('ArtifactsPanel uploads to a remote hub', () => {
  function binaryFile() {
    const bytes = new Uint8Array([0, 128, 255])
    const file = new File([bytes], 'picked.bin')
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => bytes.buffer
    })
    return { file, bytes }
  }

  it('sends picked bytes to the task and opens the returned artifact', async () => {
    uploads.hubId = 'remote'
    const pending = Promise.withResolvers<Row>()
    uploads.uploadBlob.mockReturnValue(pending.promise)
    const { file, bytes } = binaryFile()
    await mountLoaded()

    const picker = screen.getByTestId<HTMLInputElement>('artifacts-upload-input')
    const openPicker = vi.spyOn(picker, 'click')
    fireEvent.click(screen.getByTestId('artifacts-upload-btn'))
    expect(openPicker).toHaveBeenCalledOnce()
    fireEvent.change(picker, { target: { files: [file] } })

    expect(screen.getByText('Uploading picked.bin…')).toBeTruthy()
    expect(viewer().dataset.artifact).toBe('a1')
    pending.resolve({ ...row('picked'), title: file.name })

    await waitFor(() => expect(viewer().dataset.artifact).toBe('picked'))
    expect(screen.queryByText('Uploading picked.bin…')).toBeNull()
    expect(uploads.uploadBlob).toHaveBeenCalledWith({
      taskId: 't1',
      title: file.name,
      bytes
    })
    expect(uploads.uploadPath).not.toHaveBeenCalled()
    expect(uploads.showOpenDialog).not.toHaveBeenCalled()
  })

  it('reports a failed dropped file and uploads the next one', async () => {
    uploads.hubId = 'remote'
    uploads.uploadBlob.mockRejectedValueOnce(new Error('Hub unavailable'))
    uploads.uploadBlob.mockResolvedValueOnce({
      ...row('picked'),
      title: 'picked.bin'
    })
    const toastError = vi.spyOn(toast, 'error').mockImplementation(() => '')
    try {
      await mountLoaded()
      const { file } = binaryFile()
      fireEvent.drop(viewer(), { dataTransfer: { files: [file, file] } })

      await waitFor(() => expect(viewer().dataset.artifact).toBe('picked'))
      expect(screen.queryByText('Uploading picked.bin…')).toBeNull()
      expect(uploads.uploadBlob).toHaveBeenCalledTimes(2)
      expect(toastError).toHaveBeenCalledWith('Upload failed', {
        description: 'picked.bin: Hub unavailable'
      })
    } finally {
      toastError.mockRestore()
    }
  })
})

it('keeps the native file picker and path upload for a local task', async () => {
  uploads.showOpenDialog.mockResolvedValue({
    canceled: false,
    filePaths: ['/tmp/picked.bin']
  })
  uploads.uploadPath.mockResolvedValue({
    ...row('picked'),
    title: 'picked.bin'
  })
  await mountLoaded()

  fireEvent.click(screen.getByTestId('artifacts-upload-btn'))

  await waitFor(() => expect(viewer().dataset.artifact).toBe('picked'))
  expect(uploads.uploadPath).toHaveBeenCalledWith({
    taskId: 't1',
    sourcePath: '/tmp/picked.bin'
  })
  expect(uploads.uploadBlob).not.toHaveBeenCalled()
})

function pressSidebarShortcut(key = 's') {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: detectPlatform() === 'mac',
    ctrlKey: detectPlatform() !== 'mac',
    shiftKey: true,
    cancelable: true
  })
  act(() => window.dispatchEvent(event))
  return event.defaultPrevented
}

describe('ArtifactsPanel sidebar shortcut', () => {
  it('toggles the sidebar in both directions with the default binding', async () => {
    await mountLoaded()
    expect(screen.getByTestId('artifacts-sidebar')).toBeTruthy()
    expect(pressSidebarShortcut()).toBe(true)
    expect(screen.queryByTestId('artifacts-sidebar')).toBeNull()
    expect(pressSidebarShortcut()).toBe(true)
    expect(screen.getByTestId('artifacts-sidebar')).toBeTruthy()
  })

  it('follows live customizations and can be cleared', async () => {
    await mountLoaded()
    act(() =>
      useShortcutStore.setState({ overrides: { 'artifacts-toggle-sidebar': 'mod+shift+m' } })
    )
    expect(pressSidebarShortcut()).toBe(false)
    expect(pressSidebarShortcut('m')).toBe(true)
    expect(screen.queryByTestId('artifacts-sidebar')).toBeNull()

    act(() => useShortcutStore.setState({ overrides: { 'artifacts-toggle-sidebar': null } }))
    expect(pressSidebarShortcut('m')).toBe(false)
    expect(pressSidebarShortcut()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
    expect(screen.getByTestId('artifacts-sidebar')).toBeTruthy()
  })

  it('unregisters while the task tab is hidden and rebinds on show', async () => {
    const view = await mountLoaded()
    view.rerender(<Tab mode="hidden" />)
    expect(pressSidebarShortcut()).toBe(false)
    view.rerender(<Tab mode="visible" />)
    await idle()
    expect(pressSidebarShortcut()).toBe(true)
    expect(screen.queryByTestId('artifacts-sidebar')).toBeNull()
  })

  it('does not toggle while recording a shortcut or a modal is open', async () => {
    await mountLoaded()
    act(() => useShortcutStore.setState({ isRecording: true }))
    expect(pressSidebarShortcut()).toBe(false)
    act(() => useShortcutStore.setState({ isRecording: false }))

    const modal = document.createElement('div')
    modal.setAttribute('data-slot', 'dialog-overlay')
    modal.setAttribute('data-state', 'open')
    document.body.append(modal)
    try {
      expect(pressSidebarShortcut()).toBe(false)
      expect(screen.getByTestId('artifacts-sidebar')).toBeTruthy()
    } finally {
      modal.remove()
    }
  })
})

describe('ArtifactsPanel sidebar persistence (per task)', () => {
  function renderWith(
    initialSidebarState: ArtifactsSidebarState | null,
    onSidebarStateChange = vi.fn()
  ) {
    const view = render(
      <QueryClientProvider client={client}>
        <ArtifactsPanel
          ref={handle}
          taskId="t1"
          initialActiveArtifactId="a1"
          initialSidebarState={initialSidebarState}
          onSidebarStateChange={onSidebarStateChange}
        />
      </QueryClientProvider>
    )
    return { view, onSidebarStateChange }
  }
  const sidebarHeader = () => screen.getByText('Artifacts').parentElement as HTMLElement

  it('mounts with the saved visibility and width', async () => {
    renderWith({ visible: false, width: 220 })
    await idle()
    expect(screen.queryByTestId('artifacts-sidebar')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
    expect(sidebarHeader().style.width).toBe('220px')
  })

  it('shows the selected artifact title in the header only while the sidebar is hidden', async () => {
    renderWith({ visible: false, width: 220 })
    await idle()
    expect(screen.getByTestId('artifacts-header-title').textContent).toBe('a1.md')
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
    expect(screen.queryByTestId('artifacts-header-title')).toBeNull()
  })

  it('defaults to visible at the default width with nothing saved', async () => {
    const { onSidebarStateChange } = renderWith(null)
    await idle()
    expect(screen.getByTestId('artifacts-sidebar')).toBeTruthy()
    expect(sidebarHeader().style.width).toBe('300px')
    expect(onSidebarStateChange).not.toHaveBeenCalled()
  })

  it('reports a toggle (button and shortcut)', async () => {
    const { onSidebarStateChange } = renderWith({ visible: true, width: 250 })
    await idle()
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))
    expect(onSidebarStateChange).toHaveBeenLastCalledWith({ visible: false, width: 250 })
    pressSidebarShortcut()
    expect(onSidebarStateChange).toHaveBeenLastCalledWith({ visible: true, width: 250 })
  })

  it('reports the width at the end of a drag, and on double-click reset', async () => {
    const { onSidebarStateChange } = renderWith({ visible: true, width: 250 })
    await idle()
    const grip = screen.getByTestId('artifacts-sidebar-resize')
    fireEvent.mouseDown(grip, { clientX: 500 })
    fireEvent.mouseMove(document, { clientX: 540 })
    fireEvent.mouseMove(document, { clientX: 560 })
    expect(onSidebarStateChange).not.toHaveBeenCalled()
    fireEvent.mouseUp(document)
    expect(onSidebarStateChange).toHaveBeenCalledTimes(1)
    expect(onSidebarStateChange).toHaveBeenLastCalledWith({ visible: true, width: 310 })
    fireEvent.doubleClick(grip)
    expect(onSidebarStateChange).toHaveBeenLastCalledWith({ visible: true, width: 300 })
  })

  it('keeps the saved state across a tab switch without re-reporting it', async () => {
    const onSidebarStateChange = vi.fn()
    const tab = (mode: 'visible' | 'hidden') => (
      <QueryClientProvider client={client}>
        <Activity mode={mode}>
          <ArtifactsPanel
            ref={handle}
            taskId="t1"
            initialActiveArtifactId="a1"
            initialSidebarState={{ visible: false, width: 220 }}
            onSidebarStateChange={onSidebarStateChange}
          />
        </Activity>
      </QueryClientProvider>
    )
    const view = render(tab('visible'))
    await idle()
    view.rerender(tab('hidden'))
    view.rerender(tab('visible'))
    await idle()
    expect(screen.queryByTestId('artifacts-sidebar')).toBeNull()
    expect(onSidebarStateChange).not.toHaveBeenCalled()
  })
})

describe('ArtifactsPanel view state across a tab switch', () => {
  it('an open find bar keeps its query', async () => {
    const view = await mountLoaded()
    openFind('needle')
    expect(viewer().dataset.search).toBe('needle')

    await switchAwayAndBack(view)
    expect(findInput()?.value).toBe('needle')
    expect(viewer().dataset.search).toBe('needle')
  })

  it('the raw view and find bar opened from a search hit stay', async () => {
    const view = await mountLoaded()
    act(() => handle.current?.toggleSearch())
    fireEvent.click(screen.getByTestId('hit-a1'))
    await waitFor(() => expect(findInput()?.value).toBe('needle')) // opened 50 ms later
    expect(viewer().dataset.viewMode).toBe('raw')
    expect(findInput()?.value).toBe('needle')

    await switchAwayAndBack(view)
    expect(viewer().dataset.viewMode).toBe('raw')
    expect(findInput()?.value).toBe('needle')
  })

  it('a view mode picked while its save is still in flight stays', async () => {
    const view = await mountLoaded()
    let release = () => {}
    server.updateGate = new Promise<void>((r) => {
      release = r
    })
    chooseViewMode('Split')
    expect(viewer().dataset.viewMode).toBe('split')

    await switchAwayAndBack(view)
    expect(viewer().dataset.viewMode).toBe('split')
    release()
    await idle()
    expect(viewer().dataset.viewMode).toBe('split')
  })
})

describe('ArtifactsPanel search hit in another artifact', () => {
  it("opens it in the raw view with the find bar on the hit's query", async () => {
    await mountLoaded()
    act(() => handle.current?.toggleSearch())
    fireEvent.click(screen.getByTestId('hit-a3'))
    await waitFor(() => expect(findInput()).not.toBeNull()) // opened 50 ms later
    expect(viewer().dataset.artifact).toBe('a3')
    expect(viewer().dataset.viewMode).toBe('raw')
    expect(findInput()?.value).toBe('needle')
    expect(viewer().dataset.search).toBe('needle')
  })
})

describe('ArtifactsPanel view state on a selection change (pins)', () => {
  it('resets to the newly selected artifact: its saved view mode, find bar closed', async () => {
    await mountLoaded()
    openFind('needle')

    select('a2')
    expect(viewer().dataset.artifact).toBe('a2')
    expect(viewer().dataset.viewMode).toBe('raw')
    expect(findInput()).toBeNull()
    expect(viewer().dataset.search).toBe('')

    // No saved mode: the appearance default ('rich' → preview).
    select('a1')
    expect(viewer().dataset.viewMode).toBe('preview')
  })

  it('a view mode picked from the toolbar is saved per artifact and comes back on reselect', async () => {
    await mountLoaded()
    chooseViewMode('Split')
    await idle()
    select('a2')
    expect(viewer().dataset.viewMode).toBe('raw')
    select('a1')
    expect(viewer().dataset.viewMode).toBe('split')
  })

  it('reselecting the same artifact keeps the view state', async () => {
    await mountLoaded()
    openFind('needle')
    select('a1')
    expect(findInput()?.value).toBe('needle')
  })
})

describe('ArtifactsPanel saved view mode of the artifact selected at mount', () => {
  it('with the artifacts already loaded (pin)', async () => {
    await client.prefetchQuery({
      queryKey: [['artifacts', 'getByTask'], { input: { taskId: 't1' }, type: 'query' }],
      queryFn: async () => server.rows.map((r) => ({ ...r }))
    })
    render(<Tab mode="visible" saved="a2" />)
    expect(viewer().dataset.viewMode).toBe('raw')
  })

  it('with the artifacts loading after mount: applied by the next tab show at the latest (pin)', async () => {
    const view = await mountLoaded('a2')
    await switchAwayAndBack(view, 'a2')
    expect(viewer().dataset.viewMode).toBe('raw')
  })

  it('with the artifacts loading after mount: applied as they arrive', async () => {
    await mountLoaded('a2')
    expect(viewer().dataset.viewMode).toBe('raw')
  })
})

describe('ArtifactsPanel inline rename from a context menu', () => {
  // Closing, the menu hands focus back to the row it opened on. Rename shows its
  // input in that row and focuses it; the late hand-back blurred it, and blur commits
  // the rename and closes the input — mid-typing for a user, and under load in e2e 93
  // (the input vanished under Enter).
  async function renameVia(trigger: HTMLElement) {
    fireEvent.contextMenu(trigger)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    await settle(50)
  }
  const renameInput = () => screen.queryByTestId('artifacts-rename-input')

  it('an artifact keeps its rename input focused as the menu closes', async () => {
    await mountLoaded()
    await renameVia(screen.getByTestId('artifact-row-a1').querySelector('button') as HTMLElement)
    expect(renameInput()).not.toBeNull()
    expect(document.activeElement).toBe(renameInput())
  })

  it('a folder keeps its rename input focused as the menu closes', async () => {
    server.folders = [{ id: 'f1', task_id: 't1', parent_id: null, name: 'docs' }]
    await mountLoaded()
    await waitFor(() => expect(screen.getByTestId('folder-row-f1')).toBeTruthy())
    await renameVia(screen.getByTestId('folder-row-f1').querySelector('button') as HTMLElement)
    expect(renameInput()).not.toBeNull()
    expect(document.activeElement).toBe(renameInput())
  })
})
