import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { UserContentBlock } from '@slayzone/terminal-contracts'

export interface QueuedSubmissionInput {
  send: string
  original: string
  content: UserContentBlock[]
  expectedMode?: string
}
export interface QueuedSubmission extends QueuedSubmissionInput {
  id: string
  createdAt: number
  state: 'pending' | 'failed'
  error?: string
}
/** Each entry is independently committed/removed, so another editor's journal cannot be overwritten. */
export interface QueuedSubmissionStorage {
  list(): Promise<QueuedSubmission[]>
  put(entry: QueuedSubmission): Promise<void>
  remove(id: string): Promise<void>
}
const EMPTY: QueuedSubmission[] = []
const failure = (err: unknown) => (err instanceof Error ? err.message : String(err))
export function queuedSubmissionInputKey(input: QueuedSubmissionInput): string {
  return JSON.stringify([
    input.expectedMode ?? null,
    input.send,
    input.original,
    input.content.map((block) =>
      block.type === 'text'
        ? ['text', block.text]
        : [
            'attachment',
            block.attachment.artifactId,
            block.attachment.contentHash,
            block.attachment.name,
            block.attachment.kind,
            block.attachment.mediaType,
            block.attachment.size
          ]
    )
  ])
}
export function parseQueuedSubmission(raw: string): QueuedSubmission | null {
  try {
    const entry = JSON.parse(raw) as QueuedSubmission
    return entry &&
      /^[a-zA-Z0-9_-]{1,100}$/.test(entry.id) &&
      typeof entry.send === 'string' &&
      typeof entry.original === 'string' &&
      (entry.expectedMode === undefined ||
        (typeof entry.expectedMode === 'string' &&
          entry.expectedMode.length > 0 &&
          entry.expectedMode.length <= 200)) &&
      Array.isArray(entry.content) &&
      entry.content.every((block) => {
        if (!block || typeof block !== 'object') return false
        if (block.type === 'text') return typeof block.text === 'string'
        if (
          block.type !== 'attachment' ||
          !block.attachment ||
          typeof block.attachment !== 'object'
        )
          return false
        const file = block.attachment
        return (
          typeof file.artifactId === 'string' &&
          !!file.artifactId &&
          typeof file.name === 'string' &&
          ['image', 'pdf', 'text'].includes(file.kind) &&
          [
            'image/png',
            'image/jpeg',
            'image/gif',
            'image/webp',
            'application/pdf',
            'text/plain'
          ].includes(file.mediaType) &&
          Number.isSafeInteger(file.size) &&
          file.size >= 0 &&
          (file.contentHash === undefined || typeof file.contentHash === 'string')
        )
      }) &&
      Number.isFinite(entry.createdAt) &&
      ['pending', 'failed'].includes(entry.state)
      ? entry
      : null
  } catch {
    return null
  }
}

/** Local delivery intent is durable before RPC. Reopen exposes Retry; it never sends by itself. */
export function createQueuedSubmissions(opts: {
  storage: QueuedSubmissionStorage
  deliver(entry: QueuedSubmission): Promise<void>
  createId(): string
}) {
  const entries = new Map<string, QueuedSubmission>()
  const flights = new Map<string, Promise<void>>()
  const listeners = new Set<() => void>()
  let snapshot = EMPTY
  let admission = Promise.resolve()
  const publish = () => {
    snapshot = [...entries.values()].sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
    )
    for (const listener of listeners) listener()
  }
  const ready = opts.storage.list().then((saved) => {
    for (const entry of saved)
      entries.set(entry.id, {
        ...entry,
        state: 'failed',
        error: entry.error ?? 'Confirmation unavailable. Retry to check delivery.'
      })
    publish()
  })
  void ready.catch(() => {
    /* Submit reports staging failure before any RPC. */
  })
  function attempt(entry: QueuedSubmission): Promise<void> {
    const running = flights.get(entry.id)
    if (running) return running
    const pending: QueuedSubmission = { ...entry, state: 'pending', error: undefined }
    let acknowledged = false
    entries.set(entry.id, pending)
    publish()
    const predecessor = admission
    let release!: () => void
    const admitted = new Promise<void>((resolve) => {
      release = resolve
    })
    admission = predecessor.then(() => admitted)
    const work = predecessor
      .then(async () => {
        try {
          // Preserve local submission order through asynchronous journal writes.
          // Release once RPC starts; later messages need not wait for its ACK.
          await opts.storage.put(pending)
          const delivery = opts.deliver(pending)
          release()
          await delivery
          acknowledged = true
          await opts.storage.remove(entry.id)
          entries.delete(entry.id)
          publish()
        } finally {
          release()
        }
      })
      .catch(async (err) => {
        const failed: QueuedSubmission = {
          ...pending,
          state: 'failed',
          error: acknowledged
            ? 'Message accepted. Local confirmation remains; retry safely checks delivery.'
            : failure(err)
        }
        entries.set(entry.id, failed)
        // A failed status write cannot erase the already staged delivery intent.
        await opts.storage.put(failed).catch(() => {
          /* The original staged intent remains. */
        })
        publish()
        if (!acknowledged) throw err
      })
    flights.set(entry.id, work)
    void work.then(
      () => flights.delete(entry.id),
      () => flights.delete(entry.id)
    )
    return work
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async push(input: QueuedSubmissionInput) {
      await ready
      const key = queuedSubmissionInputKey(input)
      const previous = [...entries.values()].find(
        (entry) => queuedSubmissionInputKey(entry) === key
      )
      return attempt(
        previous ?? {
          ...input,
          content: input.content.map((block) =>
            block.type === 'attachment'
              ? { ...block, attachment: { ...block.attachment } }
              : { ...block }
          ),
          id: opts.createId(),
          createdAt: Date.now(),
          state: 'pending'
        }
      )
    },
    async retry(id: string) {
      await ready
      const entry = entries.get(id)
      if (!entry) return
      return attempt(entry)
    },
    async dismiss(id: string) {
      await ready
      if (flights.has(id)) throw new Error('Wait for confirmation before removing this local copy')
      await opts.storage.remove(id)
      entries.delete(id)
      publish()
    },
    ready
  }
}

export function useQueuedSubmissions(opts: Parameters<typeof createQueuedSubmissions>[0]) {
  const { storage, deliver, createId } = opts
  const manager = useMemo(
    () => createQueuedSubmissions({ storage, deliver, createId }),
    [storage, deliver, createId]
  )
  const pending = useSyncExternalStore(manager.subscribe, manager.getSnapshot, () => EMPTY)
  useEffect(() => {
    void manager.ready.catch(() => {
      /* Submit reports the journal read failure. */
    })
  }, [manager])
  return { pending, push: manager.push, retry: manager.retry, dismiss: manager.dismiss }
}
