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
import {
  ARTIFACT_TEXT_MAX_BYTES,
  type ArtifactTextRead,
  type ArtifactVersion
} from '@slayzone/task-artifacts/shared'
import type { TaskArtifact } from '@slayzone/task-contracts/types'
import { useSubscription } from '@slayzone/transport/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { type HubTrpcClient, useTRPC, useTRPCClient } from '../trpc'
import { artifactFileExists, downloadArtifactFile } from './files'
import type { HubTarget } from './hub-rest'
import { loadMermaidScript } from './page-assets'
import { useTaskArtifactsLive } from './use-task-artifacts'
import { looksBinary } from './viewer-kind'

export interface ArtifactRowState {
  /** Undefined while loading; null = no such artifact (deleted). */
  artifact: TaskArtifact | null | undefined
  error: string | null
  /** Bumped each time the hub reports the artifact's file changed. */
  contentTick: number
  /** Loads the row again (after `error`). */
  retry: () => void
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
        void queryClient.invalidateQueries(trpc.artifacts.readText.queryFilter({ id: artifactId }))
        void queryClient.invalidateQueries(trpc.artifacts.getMtime.queryFilter({ id: artifactId }))
      }
    })
  )
  return {
    artifact: rowQ.data,
    error: rowQ.error ? rowQ.error.message : null,
    contentTick,
    retry: () => void rowQ.refetch()
  }
}

export interface Loaded<T> {
  data: T | undefined
  error: string | null
  retry: () => void
}

/** What a text kind shows: the text, or why it isn't shown as text. */
export type ArtifactText =
  | { kind: 'text'; content: string }
  /** Not text (NUL bytes, invalid UTF-8): Share opens it elsewhere. */
  | { kind: 'binary' }
  /** Over the hub's text limit (`ARTIFACT_TEXT_MAX_BYTES`): never read. */
  | { kind: 'too-large'; size: number }

/** The hub has no `artifacts.readText` (older than this app; the in-app demo hub). */
function isMissingReadText(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /No procedure found on path "[^"]*artifacts\.readText"|unexpected op artifacts\.readText\b/.test(
    message
  )
}

const fromTextRead = (read: ArtifactTextRead | null): ArtifactText =>
  // Null: the artifact is gone (the row says so too).
  read === null
    ? { kind: 'text', content: '' }
    : read.kind === 'text'
      ? { kind: 'text', content: read.content }
      : read.kind === 'binary'
        ? { kind: 'binary' }
        : { kind: 'too-large', size: read.size }

const fromString = (text: string | null): ArtifactText =>
  text !== null && looksBinary(text) ? { kind: 'binary' } : { kind: 'text', content: text ?? '' }

/**
 * The working copy as text: `readText` (the hub says binary / too large without sending
 * the bytes), else — a hub without it — the whole file as a string.
 */
function readWorkingText(client: HubTrpcClient, id: string): Promise<ArtifactText> {
  return client.artifacts.readText.query({ id }).then(fromTextRead, (err: unknown) => {
    if (!isMissingReadText(err)) throw err
    return client.artifacts.readContent.query({ id }).then(fromString)
  })
}

/** The working copy's text (`readText`), or one version's (`versionsRead`). */
export function useArtifactText(
  artifactId: string,
  version: ArtifactVersion | null,
  enabled: boolean
): Loaded<ArtifactText> {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const current = useQuery({
    queryKey: trpc.artifacts.readText.queryKey({ id: artifactId }),
    queryFn: () => readWorkingText(client, artifactId),
    enabled: enabled && !version,
    staleTime: 0
  })
  // A version's size is known up front: one too large for text is never fetched.
  const versionTooLarge = version !== null && version.size > ARTIFACT_TEXT_MAX_BYTES
  const old = useQuery({
    ...trpc.artifacts.versionsRead.queryOptions({
      artifactId,
      versionRef: version?.version_num ?? 0
    }),
    enabled: enabled && !!version && !versionTooLarge,
    // A version's content never changes.
    staleTime: Number.POSITIVE_INFINITY,
    select: fromString
  })
  if (version && versionTooLarge) {
    return { data: { kind: 'too-large', size: version.size }, error: null, retry: () => undefined }
  }
  const q = version ? old : current
  return {
    data: q.data,
    error: q.error ? q.error.message : null,
    retry: () => void q.refetch()
  }
}

/**
 * The artifact (or one version) as a local file, downloaded from its hub. A file handed
 * out earlier may be evicted by another download or by the OS. Fetch it again if it
 * is missing.
 */
export function useArtifactFile(
  target: HubTarget,
  artifact: TaskArtifact,
  version: ArtifactVersion | null,
  contentTick: number,
  enabled: boolean
): Loaded<string> {
  const trpc = useTRPC()
  // The working copy's mtime on the hub: a change made while nobody listened shows. A hub
  // that can't say (an older one) leaves it out.
  const mtimeQ = useQuery({
    ...trpc.artifacts.getMtime.queryOptions({ id: artifact.id }),
    enabled: enabled && !version,
    staleTime: 0,
    retry: false
  })
  const mtime = version ? null : (mtimeQ.data ?? null)
  const mtimeSettled = version !== null || mtimeQ.status !== 'pending'
  const source = {
    artifact,
    version: version ? { ref: version.version_num, contentHash: version.content_hash } : null,
    contentTick,
    mtime
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
      mtime,
      contentTick
    ],
    queryFn: () => downloadArtifactFile(target, source),
    enabled: enabled && mtimeSettled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false
  })
  // `dataUpdatedAt`: a download again answers the same path; the check must run again.
  const missing = q.data !== undefined && !fileThere(q.data, q.dataUpdatedAt)
  // At most a couple of downloads in a row for a file that keeps going missing.
  const repairs = useRef(0)
  const refetch = q.refetch
  useEffect(() => {
    if (!missing) {
      repairs.current = 0
      return
    }
    if (repairs.current >= 2) return
    repairs.current += 1
    void refetch()
  }, [missing, refetch])
  return {
    data: missing ? undefined : q.data,
    error: q.error ? q.error.message : null,
    retry: () => void q.refetch()
  }
}

/** Whether the file at `uri` is there, as of the download at `_asOf` (a memo key). */
const fileThere = (uri: string, _asOf: number): boolean => artifactFileExists(uri)

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
