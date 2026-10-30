/**
 * Test-only (the artifact suites; never imported by app code): an in-memory hub for the
 * artifact screens — every `artifacts.*` procedure and subscription they use, with
 * answers a test can replace, every call recorded, and `emit` to push what a hub would
 * send. Run through the real tRPC client and React Query (`trpcTest`, `../testing.tsx`).
 */
import type { ArtifactVersion } from '@slayzone/task-artifacts/shared'
import type { ArtifactFolder, TaskArtifact } from '@slayzone/task-contracts/types'
import type { TrpcTestBackend } from '@slayzone/transport/testing'

// biome-ignore lint/suspicious/noExplicitAny: inputs are whatever the view under test sends
type Handler = (input: any) => unknown

export interface FakeArtifactsHub {
  backend: TrpcTestBackend
  // biome-ignore lint/suspicious/noExplicitAny: inputs are whatever the view under test sends
  calls: Array<{ path: string; input: any }>
  on: (path: string, handler: Handler) => void
  emit: (path: string, data: unknown) => void
  // biome-ignore lint/suspicious/noExplicitAny: inputs are whatever the view under test sends
  callsTo: (path: string) => any[]
  /** The hub's state, which the default answers read (mutate it, then emit). */
  state: {
    artifacts: TaskArtifact[]
    folders: ArtifactFolder[]
    content: Record<string, string>
    versions: Record<string, ArtifactVersion[]>
  }
}

export function artifactRow(
  id: string,
  title: string,
  extra: Partial<TaskArtifact> = {}
): TaskArtifact {
  return {
    id,
    task_id: 't1',
    folder_id: null,
    title,
    render_mode: null,
    view_mode: null,
    readability_override: null,
    width_override: null,
    zoom_pct: null,
    html_theme_override: null,
    language: null,
    order: 0,
    created_at: '2026-10-30 10:00:00',
    updated_at: '2026-10-30 10:00:00',
    current_version_id: `${id}-v2`,
    ...extra
  }
}

export function folderRow(
  id: string,
  name: string,
  parent_id: string | null = null
): ArtifactFolder {
  return { id, task_id: 't1', parent_id, name, order: 0, created_at: '2026-10-30 10:00:00' }
}

export function versionRow(artifactId: string, n: number): ArtifactVersion {
  return {
    id: `${artifactId}-v${n}`,
    artifact_id: artifactId,
    version_num: n,
    content_hash: `hash${n}abcdef`,
    size: 10,
    name: null,
    author_type: 'user',
    author_id: null,
    created_at: '2026-10-30 10:00:00',
    parent_id: n > 1 ? `${artifactId}-v${n - 1}` : null
  } as ArtifactVersion
}

export function fakeArtifactsHub(
  initial: Partial<FakeArtifactsHub['state']> = {}
): FakeArtifactsHub {
  const state: FakeArtifactsHub['state'] = {
    artifacts: initial.artifacts ?? [],
    folders: initial.folders ?? [],
    content: initial.content ?? {},
    versions: initial.versions ?? {}
  }
  const calls: FakeArtifactsHub['calls'] = []
  const live = new Map<string, Set<(data: unknown) => void>>()
  const handlers: Record<string, Handler> = {
    'artifacts.getByTask': ({ taskId }) => state.artifacts.filter((a) => a.task_id === taskId),
    'artifacts.foldersGetByTask': ({ taskId }) => state.folders.filter((f) => f.task_id === taskId),
    'artifacts.get': ({ id }) => state.artifacts.find((a) => a.id === id) ?? null,
    'artifacts.readContent': ({ id }) => state.content[id] ?? '',
    'artifacts.versionsList': ({ artifactId }) => state.versions[artifactId] ?? [],
    'artifacts.versionsRead': ({ artifactId, versionRef }) =>
      `${state.content[artifactId] ?? ''} (v${versionRef})`,
    'artifacts.update': (input) => {
      state.artifacts = state.artifacts.map((a) =>
        a.id === input.id && 'htmlThemeOverride' in input
          ? { ...a, html_theme_override: input.htmlThemeOverride }
          : a
      )
      return state.artifacts.find((a) => a.id === input.id) ?? null
    }
  }
  const procedures: Record<string, Handler> = {}
  for (const path of Object.keys(handlers)) {
    procedures[path] = (input) => {
      calls.push({ path, input })
      return handlers[path](input)
    }
  }
  const subscription = (path: string) => (_input: unknown, emit: (data: unknown) => void) => {
    const set = live.get(path) ?? new Set()
    set.add(emit)
    live.set(path, set)
    return () => set.delete(emit)
  }
  return {
    backend: {
      procedures,
      subscriptions: {
        'notify.onTasksChanged': subscription('notify.onTasksChanged'),
        'artifacts.onContentChanged': subscription('artifacts.onContentChanged')
      }
    },
    calls,
    state,
    on: (path, handler) => {
      handlers[path] = handler
      if (!procedures[path]) {
        procedures[path] = (input) => {
          calls.push({ path, input })
          return handlers[path](input)
        }
      }
    },
    emit: (path, data) => {
      for (const emit of live.get(path) ?? []) emit(data)
    },
    callsTo: (path) => calls.filter((c) => c.path === path).map((c) => c.input)
  }
}
