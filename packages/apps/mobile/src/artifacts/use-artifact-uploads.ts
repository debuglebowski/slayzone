/**
 * Uploads started from a task's artifact list: pick (photos, camera, files), then each
 * picked file goes to the task's hub (`uploadArtifact`), all at once, each with its
 * progress. A finished upload leaves the list of uploads — the new artifact shows in the
 * task's list (reloaded here at once; the hub also tells every client). A failed one
 * stays, with why, until retried or dismissed. Must render inside the task's hub scope.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTRPC } from '../trpc'
import type { HubTarget } from './hub-rest'
import { type PickedFile, pickUploads, type UploadSource } from './pick-uploads'
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

export interface ArtifactUploads {
  items: UploadItem[]
  /** Why the last pick failed (e.g. no camera permission); null = it didn't. */
  pickError: string | null
  start: (source: UploadSource) => void
  retry: (id: string) => void
  dismiss: (id: string) => void
}

let nextUploadId = 0

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function useArtifactUploads(
  target: HubTarget,
  taskId: string,
  options: { folderId?: string | null } = {}
): ArtifactUploads {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [items, setItems] = useState<UploadItem[]>([])
  const [pickError, setPickError] = useState<string | null>(null)

  const update = (id: string, change: Partial<UploadItem> | null) =>
    setItems((list) =>
      change === null
        ? list.filter((item) => item.id !== id)
        : list.map((item) => (item.id === id ? { ...item, ...change } : item))
    )

  const send = (item: UploadItem) => {
    uploadArtifact(target, {
      taskId,
      file: item.file,
      folderId: options.folderId ?? null,
      onProgress: (sent, total) => update(item.id, { sent, total })
    })
      .then(() => {
        update(item.id, null)
        void queryClient.invalidateQueries(trpc.artifacts.getByTask.queryFilter({ taskId }))
      })
      .catch((err: unknown) => update(item.id, { status: 'failed', error: messageOf(err) }))
  }

  const start = (source: UploadSource) => {
    setPickError(null)
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
        setItems((list) => [...list, ...started])
        for (const item of started) send(item)
      })
      .catch((err: unknown) => setPickError(messageOf(err)))
  }

  const retry = (id: string) => {
    const item = items.find((i) => i.id === id)
    if (!item) return
    const again = { ...item, sent: 0, total: 0, status: 'uploading' as const, error: null }
    update(id, again)
    send(again)
  }

  return { items, pickError, start, retry, dismiss: (id) => update(id, null) }
}
