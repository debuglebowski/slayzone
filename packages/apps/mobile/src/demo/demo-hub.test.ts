/**
 * The demo hub on its own: its tRPC answers through the real client (`trpcTest` over
 * its backend), its REST routes (`http`), the image artifact downloaded through the
 * app's own download path, and that each demo starts from the sample data again.
 */
import { createTrpcTest } from '@slayzone/transport/testing'
import type { AppRouter } from '@slayzone/api'
import { downloadArtifactFile } from '../artifacts/files'
import { hubTarget } from '../artifacts/hub-rest'
import { searchArtifacts } from '../artifacts/search'
import { uploadArtifact } from '../artifacts/upload'
import { PROJECT_COLORS } from '../theme'
import { DEMO_ACCOUNT_EMAIL, DEMO_UNAVAILABLE, type DemoHub, openDemoHub } from './demo-hub'
import { DEMO_IDS } from './seed'

// The device's file system, in memory: what the download path writes and reads.
const mockFiles = new Map<string, Uint8Array>()
jest.mock('expo-file-system', () => {
  const join = (parts: unknown[]) =>
    parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/')
  class Directory {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = join(parts)
    }
    get exists() {
      return [...mockFiles.keys()].some((k) => k.startsWith(`${this.uri}/`))
    }
    create() {}
    delete() {
      for (const k of [...mockFiles.keys()]) if (k.startsWith(`${this.uri}/`)) mockFiles.delete(k)
    }
    list() {
      return []
    }
  }
  class File {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = join(parts)
    }
    get exists() {
      return mockFiles.has(this.uri)
    }
    create() {
      mockFiles.set(this.uri, new Uint8Array())
    }
    delete() {
      mockFiles.delete(this.uri)
    }
    async write(bytes: Uint8Array) {
      // Lands later, as the native write does: a caller that does not await reads nothing.
      await new Promise((r) => setTimeout(r, 5))
      mockFiles.set(this.uri, bytes)
    }
    async bytes() {
      return mockFiles.get(this.uri) ?? new Uint8Array()
    }
  }
  return { Directory, File, Paths: { cache: 'cache:/', bundle: 'bundle:/' }, UploadType: {} }
})

const open: DemoHub[] = []
function demo(): DemoHub {
  const hub = openDemoHub({ replyDelayMs: 10 })
  open.push(hub)
  return hub
}
const clientOf = (hub: DemoHub) => createTrpcTest<AppRouter>(hub.backend).trpcClient

afterEach(() => {
  for (const hub of open.splice(0)) hub.dispose()
  mockFiles.clear()
})

describe('demo hub: tRPC', () => {
  it('serves the board: projects, tasks with subtasks, tags, a blocked task', async () => {
    const board = await clientOf(demo()).task.loadBoardData.query()
    expect(board.projects.map((p) => p?.name)).toEqual(['API v2', 'Web dashboard', 'Home cloud'])
    expect(board.tasks.filter((t) => t.parent_id === DEMO_IDS.search).map((t) => t.title)).toEqual([
      'Trigram index migration',
      'Ranking tests'
    ])
    expect(board.taskTags[DEMO_IDS.search]).toEqual(['demo-tag-feature'])
    expect(board.blockedTaskIds).toContain(DEMO_IDS.rateLimit)
  })

  it('answers copies: a screen holding an answer never sees the state change under it', async () => {
    const client = clientOf(demo())
    const before = await client.task.get.query({ id: DEMO_IDS.node })
    await client.task.update.mutate({ id: DEMO_IDS.node, title: 'Upgrade to Node 26' })
    expect(before?.title).toBe('Upgrade to Node 24')
    expect((await client.task.get.query({ id: DEMO_IDS.node }))?.title).toBe('Upgrade to Node 26')
  })

  it('pushes what changed, as a hub does', async () => {
    const hub = demo()
    const changed: unknown[] = []
    hub.backend.subscriptions?.['notify.onTasksChanged'](undefined, (e) => changed.push(e))
    await clientOf(hub).task.update.mutate({ id: DEMO_IDS.node, status: 'todo' })
    expect(changed).toEqual([{ taskIds: [DEMO_IDS.node] }])
  })

  it('each demo starts from the sample data: a write in one is not in the next', async () => {
    const first = clientOf(demo())
    await first.task.create.mutate({ projectId: DEMO_IDS.api, title: 'Scratch', status: 'todo' })
    expect((await first.task.loadBoardData.query()).tasks.some((t) => t.title === 'Scratch')).toBe(
      true
    )
    const next = clientOf(demo())
    expect((await next.task.loadBoardData.query()).tasks.some((t) => t.title === 'Scratch')).toBe(
      false
    )
  })

  it('answers a chat message itself, then the agent is idle again; closing it drops a reply on its way', async () => {
    const hub = demo()
    const client = clientOf(hub)
    const states: string[] = []
    hub.backend.subscriptions?.['pty.onStateChange'](undefined, (e) =>
      states.push((e as { newState: string }).newState)
    )
    await client.chat.send.mutate({
      tabId: DEMO_IDS.darkMode,
      message: { id: 'm1', content: [{ type: 'text', text: 'Do the charts too' }] }
    })
    expect(states).toEqual(['running'])
    await new Promise((r) => setTimeout(r, 30))
    expect(states).toEqual(['running', 'idle'])
    const replay = await client.chat.getReplay.query({ tabId: DEMO_IDS.darkMode, afterSeq: -1 })
    const kinds = replay.events.slice(-4).map((e) => (e.event as { kind: string }).kind)
    expect(kinds).toEqual(['user-message-delivery', 'turn-init', 'assistant-text', 'result'])

    await client.chat.send.mutate({
      tabId: DEMO_IDS.darkMode,
      message: { id: 'm2', content: [{ type: 'text', text: 'And the legend' }] }
    })
    hub.dispose()
    await new Promise((r) => setTimeout(r, 30))
    expect(states.at(-1)).toBe('running')
  })

  it('creates a project, and archives a column’s tasks at once', async () => {
    const client = clientOf(demo())
    const project = await client.projects.create.mutate({
      name: 'Side quest',
      color: PROJECT_COLORS[0]
    })
    expect((await client.projects.list.query()).map((p) => p.name)).toContain('Side quest')
    expect(project.name).toBe('Side quest')

    await client.task.archiveMany.mutate({ ids: [DEMO_IDS.changelog, DEMO_IDS.layoutShift] })
    const board = await client.task.loadBoardData.query()
    const archived = board.tasks.filter((t) => t.archived_at !== null).map((t) => t.id)
    expect(archived.sort()).toEqual([DEMO_IDS.changelog, DEMO_IDS.layoutShift].sort())
  })

  it('what needs a real computer says so', async () => {
    const client = clientOf(demo())
    await expect(client.workspace.listRoots.query({ computerId: 'x' } as never)).rejects.toThrow(
      DEMO_UNAVAILABLE
    )
  })
})

describe('demo hub: REST', () => {
  it('says who is signed in', async () => {
    const res = await demo().session.inProcess?.http({
      method: 'GET',
      url: 'https://demo.invalid/api/auth/get-session',
      headers: {}
    })
    expect(JSON.parse(String(res?.body)).user.email).toBe(DEMO_ACCOUNT_EMAIL)
  })

  it('searches its artifacts through the app’s own search', async () => {
    const target = hubTarget(demo().session)
    const outcome = await searchArtifacts([target], { q: 'trigram' })
    expect(outcome.hubs[0]).toMatchObject({ ok: true })
    expect(outcome.results.map((r) => r.title)).toEqual(['Plan.md'])
    expect(outcome.results[0].matches.some((m) => m.snippet.includes('Trigram index'))).toBe(true)
  })

  it('serves the image artifact’s bytes, downloaded to the device by the app’s own path', async () => {
    const hub = demo()
    const artifact = await clientOf(hub).artifacts.get.query({ id: DEMO_IDS.screenshotArtifact })
    if (!artifact) throw new Error('no screenshot artifact')
    const uri = await downloadArtifactFile(hubTarget(hub.session), { artifact })
    const bytes = mockFiles.get(uri)
    // A PNG: its signature, and more than a token's worth of pixels.
    expect([...(bytes ?? []).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(bytes?.byteLength).toBeGreaterThan(10_000)
  })

  it('takes an upload as a new artifact of the task', async () => {
    const hub = demo()
    mockFiles.set('file:///photo.jpg', new Uint8Array([1, 2, 3]))
    const created = await uploadArtifact(hubTarget(hub.session), {
      taskId: DEMO_IDS.charts,
      file: { uri: 'file:///photo.jpg', name: 'photo.jpg' }
    })
    expect(created).toMatchObject({ task_id: DEMO_IDS.charts, title: 'photo.jpg' })
    const list = await clientOf(hub).artifacts.getByTask.query({ taskId: DEMO_IDS.charts })
    expect(list.map((a) => a.title)).toEqual(['photo.jpg'])
  })

  it('anything else: not found, saying why', async () => {
    const res = await demo().session.inProcess?.http({
      method: 'GET',
      url: 'https://demo.invalid/api/computers',
      headers: {}
    })
    expect(res?.status).toBe(404)
    expect(JSON.parse(String(res?.body)).error).toBe(DEMO_UNAVAILABLE)
  })
})
