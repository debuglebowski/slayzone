import { act, render, screen, userEvent, waitFor, within } from '@testing-library/react-native'
import { ActionSheetIOS, Linking } from 'react-native'
import type { HubFeed } from '../hub-board'
import { type HubSession, hubEntryOf } from '../hub-session'
import { trpcTest } from '../testing'
import { ArtifactsScreen, type ArtifactsScreenProps } from './ArtifactsScreen'
import { artifactRow, fakeArtifactsHub, folderRow } from './fake-artifacts-hub'
import { PickerPermissionError, pickUploads } from './pick-uploads'
import { webViewMounts } from './webview-mock'

jest.mock('./pick-uploads', () => ({
  ...jest.requireActual('./pick-uploads'),
  pickUploads: jest.fn()
}))

type MockOnProgress = (progress: { bytesSent: number; totalBytes: number }) => void
const mockUploads: Array<{ uri: string; url: string; options: Record<string, unknown> }> = []
type MockAnswer = { status: number; body: string }
const mockUploadAnswer: { next: () => MockAnswer | Promise<MockAnswer> } = {
  next: () => ({ status: 200, body: '{"ok":true,"data":{}}' })
}
jest.mock('expo-file-system', () => ({
  File: class {
    uri: string
    constructor(uri: string) {
      this.uri = uri
    }
    async upload(url: string, options: Record<string, unknown>) {
      mockUploads.push({ uri: this.uri, url, options })
      const onProgress = options.onProgress as MockOnProgress | undefined
      onProgress?.({ bytesSent: 5, totalBytes: 10 })
      const signal = options.signal as AbortSignal | undefined
      const answer = await Promise.race([
        mockUploadAnswer.next(),
        new Promise<never>((_, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('Upload cancelled')))
        )
      ])
      return { ...answer, headers: {} }
    }
  },
  Directory: class {},
  Paths: { cache: {}, bundle: {} },
  UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 }
}))

const mockFeeds: { list: HubFeed[] } = { list: [] }
jest.mock('../hub-connections', () => ({ useHubFeeds: () => ({ feeds: mockFeeds.list }) }))

const home: HubSession = { entry: hubEntryOf('home.example'), token: 'h' }
const work: HubSession = { entry: hubEntryOf('work.example'), token: 'w' }
const feedOf = (session: HubSession, title = 'Write spec'): HubFeed =>
  ({
    hub: session.entry,
    connection: { status: 'open', error: null },
    stalled: false,
    board: {
      data: { tasks: [{ id: 't1', title, parent_id: null, project_id: 'p' }], projects: [] },
      pending: false,
      error: null,
      refreshing: false
    }
  }) as unknown as HubFeed

async function show(
  hub: ReturnType<typeof fakeArtifactsHub>,
  props: Partial<ArtifactsScreenProps> = {}
) {
  const { wrapper } = trpcTest(hub.backend)
  const onSelect = jest.fn()
  await render(
    <ArtifactsScreen
      session={home}
      taskId="t1"
      layout="list"
      selected={null}
      onSelect={onSelect}
      onSelectVersion={jest.fn()}
      onBack={jest.fn()}
      {...props}
    />,
    { wrapper }
  )
  return { onSelect }
}

const rowTexts = () =>
  screen
    .queryAllByTestId(/^artifact-(row|folder)-/)
    .map((el) => within(el).queryAllByText(/./)[0]?.props.children as string)

beforeEach(() => {
  mockFeeds.list = [feedOf(home)]
  mockUploads.length = 0
  jest.mocked(pickUploads).mockReset()
})

describe('ArtifactsScreen', () => {
  it("lists the task's artifacts as desktop's tree: folders first, then artifacts, by name", async () => {
    const hub = fakeArtifactsHub({
      folders: [folderRow('f1', 'Docs')],
      artifacts: [
        artifactRow('a1', 'zeta.md'),
        artifactRow('a2', 'inside.md', { folder_id: 'f1' }),
        artifactRow('a3', 'alpha.png')
      ]
    })
    await show(hub)
    await screen.findByTestId('artifact-row-a1')
    expect(rowTexts()).toEqual(['Docs', 'inside.md', 'alpha.png', 'zeta.md'])
    // VoiceOver reads the folder, not its chevron.
    expect(screen.getByRole('button', { name: 'Docs, folder' })).toBeOnTheScreen()
    expect(screen.getByText('Write spec')).toBeOnTheScreen()
    expect(screen.getByText('PNG')).toBeOnTheScreen()
    expect(screen.getByText(/^Image · /)).toBeOnTheScreen()
  })

  it('folds a folder away and back', async () => {
    const hub = fakeArtifactsHub({
      folders: [folderRow('f1', 'Docs')],
      artifacts: [artifactRow('a2', 'inside.md', { folder_id: 'f1' })]
    })
    await show(hub)
    await screen.findByTestId('artifact-row-a2')
    const user = userEvent.setup()
    await user.press(screen.getByTestId('artifact-folder-f1'))
    expect(screen.queryByTestId('artifact-row-a2')).toBeNull()
    await user.press(screen.getByTestId('artifact-folder-f1'))
    expect(screen.getByTestId('artifact-row-a2')).toBeOnTheScreen()
  })

  it('opens a tapped artifact', async () => {
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', 'plan.md')] })
    const { onSelect } = await show(hub)
    await userEvent.setup().press(await screen.findByTestId('artifact-row-a1'))
    expect(onSelect).toHaveBeenCalledWith('a1')
  })

  it('says when there are none', async () => {
    await show(fakeArtifactsHub())
    await screen.findByText('No artifacts yet')
  })

  it("reloads when the hub says this task changed (or doesn't say which), not for another task", async () => {
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', 'plan.md')] })
    await show(hub)
    await screen.findByTestId('artifact-row-a1')
    const loads = () => hub.callsTo('artifacts.getByTask').length
    const before = loads()

    hub.state.artifacts = [...hub.state.artifacts, artifactRow('a2', 'new.md')]
    await act(async () => hub.emit('notify.onTasksChanged', { taskIds: ['other-task'] }))
    expect(loads()).toBe(before)
    expect(screen.queryByTestId('artifact-row-a2')).toBeNull()

    await act(async () => hub.emit('notify.onTasksChanged', { taskIds: ['t1'] }))
    await screen.findByTestId('artifact-row-a2')

    hub.state.artifacts = [...hub.state.artifacts, artifactRow('a3', 'newer.md')]
    await act(async () => hub.emit('notify.onTasksChanged', { taskIds: null }))
    await screen.findByTestId('artifact-row-a3')

    hub.state.artifacts = [...hub.state.artifacts, artifactRow('a4', 'newest.md')]
    await act(async () => hub.emit('notify.onTasksChanged', undefined))
    await screen.findByTestId('artifact-row-a4')
  })

  it('uploads picked photos to the hub that owns the task, with its bearer, and shows the new artifact', async () => {
    mockFeeds.list = [feedOf(home), feedOf(work, 'Work task')]
    const hub = fakeArtifactsHub({ artifacts: [] })
    jest
      .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((_options, pick) => pick(0))
    jest.mocked(pickUploads).mockResolvedValue([{ uri: 'file:///tmp/a.jpg', name: 'IMG_1.jpg' }])
    mockUploadAnswer.next = () => {
      hub.state.artifacts = [artifactRow('a9', 'IMG_1.jpg')]
      return { status: 200, body: JSON.stringify({ ok: true, data: hub.state.artifacts[0] }) }
    }

    await show(hub, { session: work })
    await screen.findByText('No artifacts yet')
    expect(screen.getByText('Work task · work.example')).toBeOnTheScreen()
    await userEvent.setup().press(screen.getByRole('button', { name: 'Upload' }))

    await screen.findByTestId('artifact-row-a9')
    expect(pickUploads).toHaveBeenCalledWith('photos')
    expect(mockUploads).toHaveLength(1)
    expect(mockUploads[0]).toMatchObject({
      uri: 'file:///tmp/a.jpg',
      url: 'https://work.example/api/artifacts?taskId=t1&title=IMG_1.jpg',
      options: {
        httpMethod: 'POST',
        uploadType: 0,
        headers: { authorization: 'Bearer w', 'content-type': 'application/octet-stream' }
      }
    })
    expect(screen.queryByTestId('upload-IMG_1.jpg')).toBeNull()
  })

  it('keeps a failed upload with why, until retried', async () => {
    const hub = fakeArtifactsHub({ artifacts: [] })
    jest
      .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((_options, pick) => pick(2))
    jest.mocked(pickUploads).mockResolvedValue([{ uri: 'file:///tmp/s.pdf', name: 'Spec.pdf' }])
    mockUploadAnswer.next = () => ({ status: 500, body: '{"ok":false,"error":"Disk full"}' })

    await show(hub)
    await screen.findByText('No artifacts yet')
    const user = userEvent.setup()
    await user.press(screen.getByRole('button', { name: 'Upload' }))
    await screen.findByText('Disk full')
    expect(pickUploads).toHaveBeenCalledWith('files')

    mockUploadAnswer.next = () => {
      hub.state.artifacts = [artifactRow('a5', 'Spec.pdf')]
      return { status: 200, body: JSON.stringify({ ok: true, data: hub.state.artifacts[0] }) }
    }
    await user.press(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByTestId('artifact-row-a5')
    expect(mockUploads).toHaveLength(2)
    expect(screen.queryByText('Disk full')).toBeNull()
  })

  it('an upload keeps going while the list is away; its failure shows when the list is back', async () => {
    const hub = fakeArtifactsHub({ artifacts: [] })
    jest
      .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((_options, pick) => pick(2))
    jest.mocked(pickUploads).mockResolvedValue([{ uri: 'file:///tmp/s.pdf', name: 'Spec.pdf' }])
    let answer: (a: MockAnswer) => void = () => undefined
    mockUploadAnswer.next = () => new Promise<MockAnswer>((resolve) => (answer = resolve))

    const { wrapper } = trpcTest(hub.backend)
    const screenEl = (
      <ArtifactsScreen
        session={home}
        taskId="t1"
        layout="list"
        selected={null}
        onSelect={jest.fn()}
        onSelectVersion={jest.fn()}
        onBack={jest.fn()}
      />
    )
    await render(screenEl, { wrapper })
    await screen.findByText('No artifacts yet')
    await userEvent.setup().press(screen.getByRole('button', { name: 'Upload' }))
    await screen.findByTestId('upload-Spec.pdf')
    // The task page switches segment: the list unmounts mid-upload.
    await act(async () => screen.unmount())
    await act(async () => answer({ status: 500, body: '{"ok":false,"error":"Disk full"}' }))
    await render(screenEl, { wrapper })
    await screen.findByText('Disk full')
  })

  it('Cancel stops an upload in progress', async () => {
    const hub = fakeArtifactsHub({ artifacts: [] })
    jest
      .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((_options, pick) => pick(2))
    jest.mocked(pickUploads).mockResolvedValue([{ uri: 'file:///tmp/s.pdf', name: 'Spec.pdf' }])
    mockUploadAnswer.next = () => new Promise<MockAnswer>(() => undefined)
    await show(hub)
    await screen.findByText('No artifacts yet')
    const user = userEvent.setup()
    await user.press(screen.getByRole('button', { name: 'Upload' }))
    await screen.findByTestId('upload-Spec.pdf')
    await user.press(screen.getByRole('button', { name: 'Cancel upload of Spec.pdf' }))
    expect((mockUploads[0].options.signal as AbortSignal).aborted).toBe(true)
    await waitFor(() => expect(screen.queryByTestId('upload-Spec.pdf')).toBeNull())
    expect(screen.queryByText(/cancelled/i)).toBeNull()
  })

  it('no camera permission: says so, with Open Settings, and can be dismissed', async () => {
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined)
    const hub = fakeArtifactsHub({ artifacts: [] })
    jest
      .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((_options, pick) => pick(1))
    jest
      .mocked(pickUploads)
      .mockRejectedValue(new PickerPermissionError('SlayZone may not use the camera.'))
    await show(hub)
    await screen.findByText('No artifacts yet')
    const user = userEvent.setup()
    await user.press(screen.getByRole('button', { name: 'Upload' }))
    await screen.findByText('SlayZone may not use the camera.')
    await user.press(screen.getByRole('button', { name: 'Open Settings' }))
    expect(openSettings).toHaveBeenCalled()
    await user.press(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('SlayZone may not use the camera.')).toBeNull()
  })

  it('says why a picker could not open (no camera permission)', async () => {
    const hub = fakeArtifactsHub({ artifacts: [] })
    jest
      .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((_options, pick) => pick(1))
    jest.mocked(pickUploads).mockRejectedValue(new Error('SlayZone may not use the camera.'))
    await show(hub)
    await screen.findByText('No artifacts yet')
    await userEvent.setup().press(screen.getByRole('button', { name: 'Upload' }))
    await screen.findByText('SlayZone may not use the camera.')
  })

  it('wide screen: the selected (else the first) artifact beside the list', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'b.md'), artifactRow('a2', 'a.md')],
      content: { a1: '# B', a2: '# A' }
    })
    await show(hub, { layout: 'split' })
    await screen.findByTestId('artifact-page-markdown')
    expect(screen.getByTestId('artifact-page-markdown').props.source.html).toContain('<h1>A</h1>')
  })
})

describe('ArtifactsScreen, one artifact instance across layouts', () => {
  it('an iPad going narrow and wide again keeps the open artifact (no new viewer)', async () => {
    const hub = fakeArtifactsHub({
      artifacts: [artifactRow('a1', 'b.md'), artifactRow('a2', 'a.md')],
      content: { a1: '# B', a2: '# A' }
    })
    const { wrapper } = trpcTest(hub.backend)
    const at = (layout: ArtifactsScreenProps['layout']) => (
      <ArtifactsScreen
        session={home}
        taskId="t1"
        layout={layout}
        selected={{ artifactId: 'a1', version: null }}
        onSelect={jest.fn()}
        onSelectVersion={jest.fn()}
        onBack={jest.fn()}
        onCloseArtifact={jest.fn()}
        artifactBackLabel="Artifacts"
      />
    )
    const { rerender } = await render(at('split'), { wrapper })
    await screen.findByTestId('artifact-page-markdown')
    expect(screen.getByTestId('artifact-row-a2')).toBeOnTheScreen()
    const mounts = webViewMounts.count

    await rerender(at('artifact'))
    expect(screen.queryByTestId('artifact-row-a2')).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to Artifacts' })).toBeOnTheScreen()
    await rerender(at('split'))
    expect(screen.getByTestId('artifact-row-a2')).toBeOnTheScreen()
    expect(screen.getByTestId('artifact-page-markdown').props.source.html).toContain('<h1>B</h1>')
    expect(webViewMounts.count).toBe(mounts)
  })
})

describe('ArtifactsScreen errors', () => {
  it('says why the list failed, with Retry', async () => {
    const hub = fakeArtifactsHub()
    let fail = true
    hub.on('artifacts.getByTask', () => {
      if (fail) throw new Error('Not found')
      return [artifactRow('a1', 'plan.md')]
    })
    await show(hub)
    await screen.findByText('Not found')
    fail = false
    await userEvent.setup().press(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByTestId('artifact-row-a1')).toBeOnTheScreen())
  })

  it('a reload that fails while the list shows says so, with Retry; the list stays', async () => {
    const hub = fakeArtifactsHub({ artifacts: [artifactRow('a1', 'plan.md')] })
    await show(hub)
    await screen.findByTestId('artifact-row-a1')
    hub.on('artifacts.getByTask', () => {
      throw new Error('Network request failed')
    })
    await act(async () => hub.emit('notify.onTasksChanged', { taskIds: ['t1'] }))
    await screen.findByText("Couldn't refresh: Network request failed", undefined, {
      timeout: 5000
    })
    expect(screen.getByTestId('artifact-row-a1')).toBeOnTheScreen()
    hub.on('artifacts.getByTask', () => [artifactRow('a1', 'plan.md'), artifactRow('a2', 'new.md')])
    await userEvent.setup().press(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByTestId('artifact-row-a2')
    expect(screen.queryByText(/Couldn't refresh/)).toBeNull()
  })
})
