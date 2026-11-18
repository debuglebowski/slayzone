/**
 * Uploads started from a task's artifact list: pick (photos, camera, files), then each
 * picked file goes to the task's hub (`uploadArtifact`), all at once, each with its
 * progress. A finished upload leaves the list of uploads — the new artifact shows in the
 * task's list (reloaded here at once; the hub also tells every client). A failed one
 * stays, with why, until retried or dismissed; one in progress can be cancelled.
 *
 * The uploads live outside the screen, one list per hub + task (+ folder), for as long as
 * the app's query client: a list that unmounts (the task page switching segment, the
 * person going back) leaves its uploads running, and shows them again — progress, and
 * failures — when it is back. Must render inside the task's hub scope.
 */
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { useTRPC } from '../trpc'
import type { HubTarget } from './hub-rest'
import {
  type PickedFile,
  PickerPermissionError,
  pickUploads,
  type UploadSource
} from './pick-uploads'
import { uploadArtifact } from './upload'

export interface UploadItem {
  id: string
  file: PickedFile
  /** Bytes sent and in total; total 0 = not known yet. */
  sent: number
  total: number
  status: 'uploading' | 'failed'
  error: string | null
}

export interface PickError {
  message: string
  /** The app may not use the camera/photos: the fix is in Settings. */
  needsSettings: boolean
}

export interface ArtifactUploads {
  items: UploadItem[]
  /** Why the last pick failed (e.g. no camera permission); null = it didn't. */
  pickError: PickError | null
  start: (source: UploadSource) => void
  retry: (id: string) => void
  cancel: (id: string) => void
  dismiss: (id: string) => void
  dismissPickError: () => void
}

interface UploadsState {
  items: UploadItem[]
  pickError: PickError | null
}

/** What an upload needs from the screen that started it (the latest, on a retry). */
interface UploadContext {
  target: HubTarget
  taskId: string
  folderId: string | null
  /** The task's list is stale: an artifact arrived. */
  onUploaded: () => void
}

let nextUploadId = 0

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** One hub + task's uploads, whoever shows them. */
class UploadsStore {
  private state: UploadsState = { items: [], pickError: null }
  private readonly listeners = new Set<() => void>()
  private readonly aborts = new Map<string, AbortController>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): UploadsState => this.state

  private set(change: Partial<UploadsState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }

  private update(id: string, change: Partial<UploadItem> | null): void {
    this.set({
      items:
        change === null
          ? this.state.items.filter((item) => item.id !== id)
          : this.state.items.map((item) => (item.id === id ? { ...item, ...change } : item))
    })
  }

  private send(item: UploadItem, context: UploadContext): void {
    const abort = new AbortController()
    this.aborts.set(item.id, abort)
    uploadArtifact(context.target, {
      taskId: context.taskId,
      file: item.file,
      folderId: context.folderId,
      signal: abort.signal,
      onProgress: (sent, total) => {
        if (!abort.signal.aborted) this.update(item.id, { sent, total })
      }
    })
      .then(() => {
        this.update(item.id, null)
        context.onUploaded()
      })
      .catch((err: unknown) => {
        // Cancelled: already gone from the list.
        if (!abort.signal.aborted) this.update(item.id, { status: 'failed', error: messageOf(err) })
      })
      .finally(() => {
        if (this.aborts.get(item.id) === abort) this.aborts.delete(item.id)
      })
  }

  start(source: UploadSource, context: UploadContext): void {
    this.set({ pickError: null })
    pickUploads(source)
      .then((files) => {
        const started = files.map(
          (file): UploadItem => ({
            id: `upload-${++nextUploadId}`,
            file,
            sent: 0,
            total: 0,
            status: 'uploading',
            error: null
          })
        )
        this.set({ items: [...this.state.items, ...started] })
        for (const item of started) this.send(item, context)
      })
      .catch((err: unknown) =>
        this.set({
          pickError: {
            message: messageOf(err),
            needsSettings: err instanceof PickerPermissionError
          }
        })
      )
  }

  retry(id: string, context: UploadContext): void {
    const item = this.state.items.find((i) => i.id === id)
    if (!item || item.status !== 'failed') return
    const again = { ...item, sent: 0, total: 0, status: 'uploading' as const, error: null }
    this.update(id, again)
    this.send(again, context)
  }

  cancel(id: string): void {
    this.aborts.get(id)?.abort()
    this.aborts.delete(id)
    this.update(id, null)
  }

  dismiss(id: string): void {
    this.update(id, null)
  }

  dismissPickError(): void {
    this.set({ pickError: null })
  }
}

/** Per query client (the app's lifetime; each test's own), per hub + task + folder. */
const stores = new WeakMap<QueryClient, Map<string, UploadsStore>>()

function uploadsStoreFor(queryClient: QueryClient, key: string): UploadsStore {
  let byKey = stores.get(queryClient)
  if (!byKey) {
    byKey = new Map()
    stores.set(queryClient, byKey)
  }
  let store = byKey.get(key)
  if (!store) {
    store = new UploadsStore()
    byKey.set(key, store)
  }
  return store
}

export function useArtifactUploads(
  target: HubTarget,
  taskId: string,
  options: { folderId?: string | null } = {}
): ArtifactUploads {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const folderId = options.folderId ?? null
  const store = uploadsStoreFor(queryClient, `${target.hubId}\n${taskId}\n${folderId ?? ''}`)
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const context = (): UploadContext => ({
    target,
    taskId,
    folderId,
    onUploaded: () =>
      void queryClient.invalidateQueries(trpc.artifacts.getByTask.queryFilter({ taskId }))
  })

  return {
    items: state.items,
    pickError: state.pickError,
    start: (source) => store.start(source, context()),
    retry: (id) => store.retry(id, context()),
    cancel: (id) => store.cancel(id),
    dismiss: (id) => store.dismiss(id),
    dismissPickError: () => store.dismissPickError()
  }
}
