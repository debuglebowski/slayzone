// The web shell's side of artifact downloads: streaming save targets (the host
// contract's `saveTarget*`). The client reads each file from the hub in bounded pieces
// and writes them here. A file becomes one browser download; a folder (a browser
// cannot write into a folder the person picks everywhere) and a zip are built by the
// zip worker as the pieces arrive, so compression never blocks the page and no size
// has a ceiling (zip64 past 4 GB). Each piece — and each chunk of zip output — becomes
// its own Blob the moment it arrives: Chromium moves Blob data out of the tab into
// browser-process storage, which pages to disk, so the tab never holds the download
// as one growing buffer. Close only joins those Blobs.
import type {
  HostSaveResult,
  SaveTargetOpenResult,
  SaveTargetRequest
} from '@slayzone/platform/electron-bootstrap-contract'
import { saveBlob } from './artifact-export'
import { createZipEncoder, fflateDeflater } from './zip-stream'

/** A message to the zip worker; one at a time, each answered by a {@link ZipWorkerReply}. */
export type ZipWorkerRequest =
  | { seq: number; op: 'write'; path: string; data: Uint8Array }
  | { seq: number; op: 'mkdir'; path: string }
  | { seq: number; op: 'finish' }

/** The archive bytes a request produced. */
export interface ZipWorkerReply {
  seq: number
  out: Uint8Array[]
  error?: string
}

/** A zip being built: every archive byte it produces goes to `onOut`. */
export interface ZipSink {
  write(path: string, data: Uint8Array): Promise<void>
  mkdir(path: string): Promise<void>
  finish(): Promise<void>
  dispose(): void
}

/** The zip worker (zip-worker.ts), one request in flight at a time. */
export function workerZipSink(onOut: (chunk: Uint8Array) => void): ZipSink {
  const worker = new Worker(new URL('./zip-worker.ts', import.meta.url), { type: 'module' })
  let seq = 0
  let pending: { seq: number; resolve: () => void; reject: (e: Error) => void } | null = null
  worker.onmessage = (event: MessageEvent<ZipWorkerReply>) => {
    const reply = event.data
    const p = pending
    if (!p || p.seq !== reply.seq) return
    pending = null
    for (const chunk of reply.out) onOut(chunk)
    if (reply.error) p.reject(new Error(reply.error))
    else p.resolve()
  }
  worker.onerror = (event) => {
    const p = pending
    pending = null
    p?.reject(new Error(event.message || 'The zip worker failed'))
  }
  const send = (req: ZipWorkerRequest, transfer: Transferable[] = []): Promise<void> =>
    new Promise((resolve, reject) => {
      pending = { seq: req.seq, resolve, reject }
      worker.postMessage(req, transfer)
    })
  return {
    write: (path, data) => {
      // Transfer when the view owns its whole buffer; otherwise it is copied.
      const whole = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      return send(
        { seq: ++seq, op: 'write', path, data },
        whole ? [data.buffer as ArrayBuffer] : []
      )
    },
    mkdir: (path) => send({ seq: ++seq, op: 'mkdir', path }),
    finish: () => send({ seq: ++seq, op: 'finish' }),
    dispose: () => worker.terminate()
  }
}

/** The same encoder on the calling thread — for a host without workers (tests). */
export function inlineZipSink(onOut: (chunk: Uint8Array) => void): ZipSink {
  const encoder = createZipEncoder(onOut, { deflater: fflateDeflater })
  return {
    write: async (path, data) => encoder.write(path, data),
    mkdir: async (path) => encoder.mkdir(path),
    finish: async () => encoder.finish(),
    dispose: () => undefined
  }
}

interface Target {
  write(path: string, data: Uint8Array): Promise<void>
  mkdir(path: string): Promise<void>
  close(): Promise<void>
  abort(): void
}

/** A BlobPart over `data` (a view on a shared buffer is copied: not a BlobPart). */
const bytesPart = (data: Uint8Array): BlobPart =>
  data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data)

export function createBrowserSaveTargets(
  deps: {
    createZipSink?: (onOut: (chunk: Uint8Array) => void) => ZipSink
    /** Blob construction, injectable so tests can see the memory shape. */
    makeBlob?: (parts: BlobPart[], opts?: BlobPropertyBag) => Blob
  } = {}
) {
  const createZipSink = deps.createZipSink ?? workerZipSink
  const makeBlob = deps.makeBlob ?? ((parts, opts) => new Blob(parts, opts))
  /** One piece out of the tab's memory: a Blob snapshots its bytes. */
  const stash = (data: Uint8Array): Blob => makeBlob([bytesPart(data)])
  const targets = new Map<string, Target>()
  let next = 0

  const fileTarget = (fileName: string): Target => {
    let parts: Blob[] = []
    return {
      write: async (_path, data) => {
        parts.push(stash(data))
      },
      mkdir: async () => {
        throw new Error('A file download has no folders')
      },
      close: async () => saveBlob(makeBlob(parts), fileName),
      abort: () => {
        parts = []
      }
    }
  }

  const zipTarget = (fileName: string): Target => {
    let parts: Blob[] = []
    const sink = createZipSink((chunk) => parts.push(stash(chunk)))
    return {
      write: (path, data) => sink.write(path, data),
      mkdir: (path) => sink.mkdir(path),
      close: async () => {
        await sink.finish().finally(() => sink.dispose())
        saveBlob(makeBlob(parts, { type: 'application/zip' }), fileName)
      },
      abort: () => {
        sink.dispose()
        parts = []
      }
    }
  }

  const get = (id: string): Target => {
    const target = targets.get(id)
    if (!target) throw new Error('Unknown save target')
    return target
  }

  return {
    async open(request: SaveTargetRequest): Promise<SaveTargetOpenResult> {
      const target =
        request.kind === 'file'
          ? fileTarget(request.fileName)
          : zipTarget(request.kind === 'zip' ? request.fileName : `${request.folderName}.zip`)
      const targetId = `save-${++next}`
      targets.set(targetId, target)
      return { ok: true, targetId }
    },
    write: async (id: string, path: string, data: Uint8Array) => get(id).write(path, data),
    mkdir: async (id: string, path: string) => get(id).mkdir(path),
    async close(id: string): Promise<HostSaveResult> {
      const target = get(id)
      targets.delete(id)
      return target.close().then(
        () => ({ ok: true }) as const,
        (err: unknown) => {
          target.abort()
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as const
        }
      )
    },
    async abort(id: string): Promise<void> {
      targets.get(id)?.abort()
      targets.delete(id)
    }
  }
}
