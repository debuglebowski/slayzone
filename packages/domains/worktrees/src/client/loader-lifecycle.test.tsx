// @vitest-environment jsdom
// Real Activity/StrictMode + scoped worktrees client, compiled like the renderer.
import { Activity, StrictMode } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import {
  WorkspaceTargetProvider,
  type WorkspaceTarget
} from '@slayzone/file-editor/client/workspace-target'
import type { GitDiffSnapshot } from '../shared/types'
import { GIT_TEXT_EXPIRED, type GitFileDiffsPage, type GitTextPage } from '../shared/git-text'

interface Input {
  filePaths?: string[]
  cursor?: string | null
  index?: number
  treeId?: string
  target?: WorkspaceTarget
}
interface Options {
  signal?: AbortSignal
}
type Query = (input: Input, options?: Options) => Promise<unknown>
type Client = { worktrees: Record<string, { query: ReturnType<typeof vi.fn<Query>> }> }
const held = vi.hoisted(() => ({ client: null as unknown as Client }))
vi.mock('@slayzone/transport/client', () => ({
  typedTrpc: () => ({ useTRPCClient: () => held.client, useTRPC: () => held.client })
}))
import { useDiffTexts } from './useDiffTexts'
import { useIgnoredTree } from './useIgnoredTree'
import { usePagedStashDiff } from './usePagedStashDiff'

const params = { contextLines: '3', ignoreWhitespace: false, fromSha: undefined, toSha: undefined }
const target: WorkspaceTarget = { taskId: 'task-A', computerId: 'computer-A' }
const patch = (name: string) =>
  `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-é\n+😀\n`
const snapshot: GitDiffSnapshot = {
  targetPath: '/same',
  files: ['a.txt'],
  stagedFiles: [],
  unstagedFiles: [],
  untrackedFiles: ['a.txt'],
  unstagedPatch: '',
  stagedPatch: '',
  generatedAt: 'same',
  isGitRepo: true
}
const page = (text: string): GitFileDiffsPage & { $paged: true } => ({
  $paged: true,
  diffs: { 'a.txt': text },
  deferred: [],
  large: []
})
const tree = (id: string) => ({
  treeId: id,
  totalFiles: 1,
  root: {
    items: [{ path: id, name: id, isDirectory: false, size: 1, fileCount: 1 }],
    nextCursor: null
  }
})
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
function client(label = 'hub-A', overrides: Record<string, Query> = {}): Client {
  const identify = (i: Input) =>
    `${label}:${i.target?.taskId ?? i.target?.projectId}:${i.target?.computerId}`
  const methods: Record<string, Query> = {
    getUntrackedFileDiffs: async (i) => page(identify(i)),
    getFileDiffsPage: async () => ({ diffs: {}, deferred: [], large: [] }),
    readGitText: async () => ({ text: patch(label), cursor: null, totalBytes: 100 }),
    openIgnoredTree: async (i) => tree(identify(i)),
    listIgnoredTree: async () => ({ items: [], nextCursor: null }),
    matchIgnoredTree: async () => ({ items: [], nextCursor: null }),
    ...overrides
  }
  return {
    worktrees: Object.fromEntries(
      Object.entries(methods).map(([name, query]) => [name, { query: vi.fn(query) }])
    )
  }
}
let diff!: ReturnType<typeof useDiffTexts>,
  ignored!: ReturnType<typeof useIgnoredTree>,
  stash!: ReturnType<typeof usePagedStashDiff>
function Diff() {
  diff = useDiffTexts('/same', params, snapshot)
  return <output>{diff.texts.get('?:a.txt')?.text}</output>
}
function Ignored() {
  ignored = useIgnoredTree('/same', true)
  return <output>{ignored.snapshot.dirs.get('')?.items[0]?.path}</output>
}
function Stash({ index = 0, entry }: { index?: number | null; entry?: string }) {
  stash = usePagedStashDiff('/same', index, entry)
  return <output>{stash.files.map((f) => f.path).join(',')}</output>
}
const diffText = () => diff.texts.get('?:a.txt')?.text
const rootPath = () => ignored.snapshot.dirs.get('')?.items[0]?.path
const frame = (kind: 'diff' | 'ignored', visible = true, scope = target) => (
  <WorkspaceTargetProvider target={scope}>
    <Activity mode={visible ? 'visible' : 'hidden'}>
      {kind === 'diff' ? <Diff /> : <Ignored />}
    </Activity>
  </WorkspaceTargetProvider>
)
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test.each(['diff', 'ignored'] as const)(
  '%s completed data reacquires a live loader after Activity hide/show',
  async (kind) => {
    let version = 'old'
    held.client = client('hub', {
      getUntrackedFileDiffs: async () => page(version),
      openIgnoredTree: async () => tree(version)
    })
    const view = render(frame(kind))
    await waitFor(() => expect(kind === 'diff' ? diffText() : rootPath()).toBe('old'))
    const old = kind === 'diff' ? diff.loader : ignored.loader
    view.rerender(frame(kind, false))
    version = 'fresh'
    view.rerender(frame(kind))
    await waitFor(() => expect(kind === 'diff' ? diffText() : rootPath()).toBe('fresh'))
    expect(kind === 'diff' ? diff.loader : ignored.loader).not.toBe(old)
    view.rerender(frame(kind))
    await act(turn)
    expect(
      held.client.worktrees[kind === 'diff' ? 'getUntrackedFileDiffs' : 'openIgnoredTree'].query
    ).toHaveBeenCalledTimes(2)
  }
)

test.each(['diff', 'ignored'] as const)(
  '%s pending old Activity read is cancelled/fenced and never follows more pages',
  async (kind) => {
    const late = deferred<unknown>()
    let count = 0
    held.client = client('hub', {
      [kind === 'diff' ? 'getUntrackedFileDiffs' : 'openIgnoredTree']: async () =>
        ++count === 1 ? late.promise : kind === 'diff' ? page('fresh') : tree('fresh')
    })
    const view = render(frame(kind))
    const query =
      held.client.worktrees[kind === 'diff' ? 'getUntrackedFileDiffs' : 'openIgnoredTree'].query
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    const signal = query.mock.calls[0][1]?.signal
    view.rerender(frame(kind, false))
    await act(async () => {
      late.resolve(
        kind === 'diff'
          ? { $paged: true, diffs: {}, large: ['a.txt'], deferred: ['next.txt'] }
          : tree('late')
      )
      await turn()
    })
    expect(signal?.aborted).toBe(true)
    expect(held.client.worktrees.readGitText.query).not.toHaveBeenCalled()
    view.rerender(frame(kind))
    await waitFor(() => expect(kind === 'diff' ? diffText() : rootPath()).toBe('fresh'))
    expect(query.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(false)
  }
)

test.each(['diff', 'ignored'] as const)(
  '%s survives StrictMode effect replay with usable controls',
  async (kind) => {
    held.client = client('ready')
    render(<StrictMode>{frame(kind)}</StrictMode>)
    await waitFor(() =>
      expect(kind === 'diff' ? diffText() : rootPath()).toBe('ready:task-A:computer-A')
    )
    if (kind === 'ignored') {
      await act(() => ignored.loader!.loadMore('folder'))
      expect(ignored.snapshot.dirs.get('folder')?.failed).toBe(false)
    }
  }
)

const changes: Array<[string, WorkspaceTarget, string]> = [
  ['task', { taskId: 'task-B', computerId: 'computer-A' }, 'hub-A:task-B:computer-A'],
  ['project', { projectId: 'project-B', computerId: 'computer-A' }, 'hub-A:project-B:computer-A'],
  ['computer', { taskId: 'task-A', computerId: 'computer-B' }, 'hub-A:task-A:computer-B'],
  ['hub', target, 'hub-B:task-A:computer-A']
]
for (const kind of ['diff', 'ignored'] as const)
  test.each(changes)(
    '%s ' + kind + ' rebinds same pathname through actual scoped client',
    async (change, scope, expected) => {
      held.client = client()
      const view = render(frame(kind))
      await waitFor(() =>
        expect(kind === 'diff' ? diffText() : rootPath()).toBe('hub-A:task-A:computer-A')
      )
      const old = kind === 'diff' ? diff.loader : ignored.loader
      if (change === 'hub') held.client = client('hub-B')
      view.rerender(frame(kind, true, scope))
      await waitFor(() => expect(kind === 'diff' ? diffText() : rootPath()).toBe(expected))
      const current = kind === 'diff' ? diff.loader : ignored.loader
      expect(current).not.toBe(old)
      const calls =
        held.client.worktrees[kind === 'diff' ? 'getUntrackedFileDiffs' : 'openIgnoredTree'].query
          .mock.calls.length
      view.rerender(frame(kind, true, { ...scope }))
      await act(turn)
      expect(kind === 'diff' ? diff.loader : ignored.loader).toBe(current)
      expect(
        held.client.worktrees[kind === 'diff' ? 'getUntrackedFileDiffs' : 'openIgnoredTree'].query
      ).toHaveBeenCalledTimes(calls)
    }
  )

for (const kind of ['diff', 'ignored'] as const)
  test.each(['success', 'error'] as const)(
    '%s old ' + kind + ' scope completion cannot alter the new scope or retry through it',
    async (outcome) => {
      const late = deferred<unknown>()
      const old = client('old', {
        [kind === 'diff' ? 'getUntrackedFileDiffs' : 'openIgnoredTree']: () => late.promise
      })
      held.client = old
      const view = render(frame(kind))
      const query =
        old.worktrees[kind === 'diff' ? 'getUntrackedFileDiffs' : 'openIgnoredTree'].query
      await waitFor(() => expect(query).toHaveBeenCalledOnce())
      const signal = query.mock.calls[0][1]?.signal
      const next = client('new')
      held.client = next
      view.rerender(frame(kind, true, { taskId: 'task-B', computerId: 'computer-B' }))
      await waitFor(() =>
        expect(kind === 'diff' ? diffText() : rootPath()).toBe('new:task-B:computer-B')
      )
      await act(async () => {
        if (outcome === 'success') late.resolve(kind === 'diff' ? page('old') : tree('old'))
        else late.reject(new Error('old failed'))
        await turn()
      })
      expect(kind === 'diff' ? diffText() : rootPath()).toBe('new:task-B:computer-B')
      expect(signal?.aborted).toBe(true)
      expect(
        next.worktrees[kind === 'diff' ? 'getUntrackedFileDiffs' : 'openIgnoredTree'].query.mock
          .calls[0][1]?.signal?.aborted
      ).toBe(false)
    }
  )

for (const change of ['selection', 'Activity', 'client', 'entry'] as const)
  test.each(['success', 'error', 'expired'] as const)(
    'stash ' + change + ' fences late rest %s, including all following pages/restarts',
    async (outcome) => {
      const late = deferred<GitTextPage>()
      let first = 0
      const query: Query = async (i) => {
        if (i.cursor === 'old-rest') return late.promise
        if (i.cursor === 'never-read') throw new Error('superseded page was followed')
        if (i.cursor === 'fresh-rest')
          return { text: patch('fresh-tail.txt'), cursor: null, totalBytes: 999 }
        if (i.index === 1) return { text: patch('other.txt'), cursor: null, totalBytes: 200 }
        return ++first === 1
          ? { text: patch('old.txt'), cursor: 'old-rest', totalBytes: 999 }
          : { text: patch('fresh.txt'), cursor: 'fresh-rest', totalBytes: 999 }
      }
      const initial = client('hub', { readGitText: query })
      held.client = initial
      const draw = (index = 0, visible = true, entry = 'sha-A') => (
        <WorkspaceTargetProvider target={target}>
          <Activity mode={visible ? 'visible' : 'hidden'}>
            <Stash index={index} entry={entry} />
          </Activity>
        </WorkspaceTargetProvider>
      )
      const view = render(draw())
      await waitFor(() => expect(stash.files[0]?.path).toBe('old.txt'))
      let loading!: Promise<void>
      act(() => {
        loading = stash.loadRest()
      })
      await waitFor(() =>
        expect(
          initial.worktrees.readGitText.query.mock.calls.some(([i]) => i.cursor === 'old-rest')
        ).toBe(true)
      )
      if (change === 'selection') {
        view.rerender(draw(1))
        await waitFor(() => expect(stash.files[0]?.path).toBe('other.txt'))
        view.rerender(draw())
      }
      if (change === 'Activity') {
        view.rerender(draw(0, false))
        view.rerender(draw())
      }
      if (change === 'client') {
        held.client = client('new', { readGitText: query })
        view.rerender(draw())
      }
      if (change === 'entry') view.rerender(draw(0, true, 'sha-B'))
      await waitFor(() => expect(stash.files[0]?.path).toBe('fresh.txt'))
      const before = stash.rest
      const calls = initial.worktrees.readGitText.query.mock.calls.length
      await act(async () => {
        if (outcome === 'success')
          late.resolve({ text: patch('old-tail.txt'), cursor: 'never-read', totalBytes: 999 })
        else late.reject(new Error(outcome === 'expired' ? GIT_TEXT_EXPIRED : 'old failed'))
        await loading
      })
      expect(stash.files.map((f) => f.path)).toEqual(['fresh.txt'])
      expect(stash.rest).toEqual(before)
      expect(initial.worktrees.readGitText.query.mock.calls).toHaveLength(calls)
      expect(
        held.client.worktrees.readGitText.query.mock.calls.some(([i]) => i.cursor === 'never-read')
      ).toBe(false)
    }
  )

test('stash current rest failure is retryable, expiry restarts once, UTF8 and all pages survive', async () => {
  const a = patch('é.txt'),
    b = patch('😀.txt'),
    c = patch('終.txt')
  let fail = true,
    expired = false
  held.client = client('hub', {
    readGitText: async (i) => {
      if (i.cursor === null)
        return { text: a, cursor: 'rest', totalBytes: new TextEncoder().encode(a + b + c).length }
      if (fail) {
        fail = false
        throw new Error('current failure')
      }
      if (!expired) {
        expired = true
        throw new Error(GIT_TEXT_EXPIRED)
      }
      return {
        text: i.cursor === 'rest' ? b : c,
        cursor: i.cursor === 'rest' ? 'last' : null,
        totalBytes: 999
      }
    }
  })
  render(
    <WorkspaceTargetProvider target={target}>
      <Stash />
    </WorkspaceTargetProvider>
  )
  await waitFor(() => expect(stash.files[0]?.path).toBe('é.txt'))
  expect(stash.rest?.remainingBytes).toBe(new TextEncoder().encode(b + c).length)
  await act(() => stash.loadRest())
  expect(stash.rest?.failed).toBe(true)
  await act(() => stash.loadRest())
  expect(stash.files.map((f) => f.path)).toEqual(['é.txt', '😀.txt', '終.txt'])
  expect(
    stash.files.map((f) => f.hunks.flatMap((h) => h.lines.map((line) => line.content)))
  ).toEqual([
    ['é', '😀'],
    ['é', '😀'],
    ['é', '😀']
  ])
  expect(stash.rest).toBeNull()
})

test.each(['success', 'error'] as const)(
  'stash fences %s from an already pending expiry restart after client rebind',
  async (outcome) => {
    const restart = deferred<GitTextPage>()
    let starts = 0
    const old = client('old', {
      readGitText: async (i) => {
        if (i.cursor === null) {
          if (++starts === 2) return restart.promise
          return { text: patch('old.txt'), cursor: 'expired', totalBytes: 999 }
        }
        throw new Error(GIT_TEXT_EXPIRED)
      }
    })
    held.client = old
    const draw = () => (
      <WorkspaceTargetProvider target={target}>
        <Stash />
      </WorkspaceTargetProvider>
    )
    const view = render(draw())
    await waitFor(() => expect(stash.files[0]?.path).toBe('old.txt'))
    let loading!: Promise<void>
    act(() => {
      loading = stash.loadRest()
    })
    await waitFor(() => expect(starts).toBe(2))
    held.client = client('fresh.txt')
    view.rerender(draw())
    await waitFor(() => expect(stash.files[0]?.path).toBe('fresh.txt'))
    const fresh = stash.files
    await act(async () => {
      if (outcome === 'success')
        restart.resolve({ text: patch('old-restart.txt'), cursor: 'never-read', totalBytes: 999 })
      else restart.reject(new Error('old restart failed'))
      await loading
    })
    expect(stash.files).toBe(fresh)
    expect(stash.rest).toBeNull()
    expect(old.worktrees.readGitText.query).toHaveBeenCalledTimes(3)
    expect(
      old.worktrees.readGitText.query.mock.calls.every(([, options]) => options?.signal?.aborted)
    ).toBe(true)
    expect(held.client.worktrees.readGitText.query).toHaveBeenCalledOnce()
    expect(held.client.worktrees.readGitText.query.mock.calls[0][1]?.signal?.aborted).toBe(false)
  }
)

test('stash unchanged identity stays cached and concurrent Load rest reads each page once', async () => {
  const tail = deferred<GitTextPage>()
  held.client = client('hub', {
    readGitText: async (i) =>
      i.cursor === null
        ? { text: patch('first.txt'), cursor: 'tail', totalBytes: 999 }
        : tail.promise
  })
  const draw = () => (
    <WorkspaceTargetProvider target={{ ...target }}>
      <Stash entry="same-sha" />
    </WorkspaceTargetProvider>
  )
  const view = render(draw())
  await waitFor(() => expect(stash.files[0]?.path).toBe('first.txt'))
  view.rerender(draw())
  await act(turn)
  expect(held.client.worktrees.readGitText.query).toHaveBeenCalledOnce()
  let first!: Promise<void>, second!: Promise<void>
  act(() => {
    first = stash.loadRest()
    second = stash.loadRest()
  })
  await waitFor(() => expect(held.client.worktrees.readGitText.query).toHaveBeenCalledTimes(2))
  await act(async () => {
    tail.resolve({ text: patch('last.txt'), cursor: null, totalBytes: 999 })
    await Promise.all([first, second])
  })
  expect(stash.files.map((file) => file.path)).toEqual(['first.txt', 'last.txt'])
  expect(stash.rest).toBeNull()
})
