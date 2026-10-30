/**
 * One artifact, live, as the viewer needs it: its row, its content as text or as a local
 * file, its versions, and the mermaid build when its page draws diagrams. Must render
 * inside the artifact's hub scope.
 *
 * Live like desktop's viewer: the row reloads when the hub says the task changed
 * (`useTaskArtifactsLive`); the content reloads when the hub says the file changed on
 * disk (`artifacts.onContentChanged`, which a desktop autosave fires without touching the
 * row). Desktop also polls the file's mtime every second while visible; the phone does not
 * (the event covers it, and the app refetches when it comes to the foreground).
 */
import type { ArtifactVersion } from '@slayzone/task-artifacts/shared'
import type { TaskArtifact } from '@slayzone/task-contracts/types'
import { useSubscription } from '@slayzone/transport/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTRPC } from '../trpc'
import { downloadArtifactFile } from './files'
import type { HubTarget } from './hub-rest'
import { loadMermaidScript } from './page-assets'
import { useTaskArtifactsLive } from './use-task-artifacts'

export interface ArtifactRowState {
  /** Undefined while loading; null = no such artifact (deleted). */
  artifact: TaskArtifact | null | undefined
  error: string | null
  /** Bumped each time the hub reports the artifact's file changed. */
  contentTick: number
}

export function useArtifactRow(taskId: string, artifactId: string): ArtifactRowState {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const rowQ = useQuery(trpc.artifacts.get.queryOptions({ id: artifactId }))
  const [contentTick, setContentTick] = useState(0)
  useTaskArtifactsLive(taskId)
  useSubscription(
    trpc.artifacts.onContentChanged.subscriptionOptions(undefined, {
      onData: (changedId) => {
        if (changedId !== artifactId) return
        setContentTick((tick) => tick + 1)
        void queryClient.invalidateQueries(
          trpc.artifacts.readContent.queryFilter({ id: artifactId })
        )
      }
    })
  )
  return {
    artifact: rowQ.data,
    error: rowQ.error ? rowQ.error.message : null,
    contentTick
  }
}

export interface Loaded<T> {
  data: T | undefined
  error: string | null
  retry: () => void
}

/** The working copy's text (`readContent`), or one version's (`versionsRead`). */
export function useArtifactText(
  artifactId: string,
  version: ArtifactVersion | null,
  enabled: boolean
): Loaded<string> {
  const trpc = useTRPC()
  const current = useQuery({
    ...trpc.artifacts.readContent.queryOptions({ id: artifactId }),
    enabled: enabled && !version,
    staleTime: 0
  })
  const old = useQuery({
    ...trpc.artifacts.versionsRead.queryOptions({
      artifactId,
      versionRef: version?.version_num ?? 0
    }),
    enabled: enabled && !!version,
    // A version's content never changes.
    staleTime: Number.POSITIVE_INFINITY
  })
  const q = version ? old : current
  return {
    // `readContent` answers null for an artifact that is gone (the row says so too).
    data: q.data === null ? '' : q.data,
    error: q.error ? q.error.message : null,
    retry: () => void q.refetch()
  }
}

/** The artifact (or one version) as a local file, downloaded from its hub. */
export function useArtifactFile(
  target: HubTarget,
  artifact: TaskArtifact,
  version: ArtifactVersion | null,
  contentTick: number,
  enabled: boolean
): Loaded<string> {
  const source = {
    artifact,
    version: version ? { ref: version.version_num, contentHash: version.content_hash } : null,
    contentTick
  }
  const q = useQuery({
    queryKey: [
      'artifact-file',
      target.hubId,
      artifact.id,
      artifact.title,
      version?.content_hash ?? null,
      artifact.current_version_id,
      artifact.updated_at,
      contentTick
    ],
    queryFn: () => downloadArtifactFile(target, source),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false
  })
  return {
    data: q.data,
    error: q.error ? q.error.message : null,
    retry: () => void q.refetch()
  }
}

/** The artifact's versions, newest first (desktop's history: the latest 50). */
export function useArtifactVersions(
  artifactId: string,
  enabled: boolean
): Loaded<ArtifactVersion[]> {
  const trpc = useTRPC()
  const q = useQuery({
    ...trpc.artifacts.versionsList.queryOptions({ artifactId, limit: 50 }),
    enabled,
    staleTime: 0
  })
  return {
    data: q.data as ArtifactVersion[] | undefined,
    error: q.error ? q.error.message : null,
    retry: () => void q.refetch()
  }
}

/** The mermaid build, read from the app bundle the first time a page needs it. */
export function useMermaidScript(needed: boolean): Loaded<string> {
  const q = useQuery({
    queryKey: ['artifact-page-assets', 'mermaid'],
    queryFn: loadMermaidScript,
    enabled: needed,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false
  })
  return {
    data: q.data,
    error: q.error ? q.error.message : null,
    retry: () => void q.refetch()
  }
}
