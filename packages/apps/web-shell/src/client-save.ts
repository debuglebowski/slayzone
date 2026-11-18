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
import { createZipEncoder } from '@slayzone/task-artifacts/zip-stream'
import { saveBlob } from './artifact-export'
import { fflateDeflater } from './fflate-deflater'

/** A message to the zip worker; one at a time, each answered by a {@link ZipWorkerReply}. */
export type ZipWorkerRequest =
  | { seq: number; op: 'write'; path: string; data: Uint8Array; size?: number }
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
  /** `size`: the file's total length (the encoder lays its entry out by it). */
  write(path: string, data: Uint8Array, size?: number): Promise<void>
  mkdir(path: string): Promise<void>
  finish(): Promise<void>
  dispose(): void
}

/**
 * The zip worker (zip-worker.ts), one request in flight at a time.
 *
 * A worker that fails is dead for good, and the sink with it: the failure is latched,
 * so the request in flight and every later one reject rather than wait on a worker
 * that will never answer. It can fail before any request — a tab left open across a
 * hub upgrade asks for a hashed worker chunk the new build no longer has (404).
 */
export function workerZipSink(onOut: (chunk: Uint8Array) => void): ZipSink {
  const worker = new Worker(new URL('./zip-worker.ts', import.meta.url), { type: 'module' })
  let seq = 0
  let pending: { seq: number; resolve: () => void; reject: (e: Error) => void } | null = null
  let dead: Error | null = null
  const die = (err: Error): void => {
    dead ??= err
    const p = pending
    pending = null
    p?.reject(dead)
    worker.terminate()
  }
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
    die(new Error((event as Partial<ErrorEvent>).message || 'The zip worker failed'))
  }
  // A reply that cannot be deserialised: its archive bytes are lost, so is the zip.
  worker.onmessageerror = () => {
    die(new Error('The zip worker sent a reply that could not be read'))
  }
  const send = (req: ZipWorkerRequest, transfer: Transferable[] = []): Promise<void> =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead)
      pending = { seq: req.seq, resolve, reject }
      try {
        worker.postMessage(req, transfer)
      } catch (err) {
        // A DOMException (DataCloneError) is not an Error in every engine.
        die(
          err instanceof Error
            ? err
            : new Error((err as { message?: string } | null)?.message ?? String(err))
        )
      }
    })
  return {
    write: (path, data, size) => {
      // Transfer when the view owns its whole buffer; otherwise it is copied.
      const whole = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      return send(
        { seq: ++seq, op: 'write', path, data, size },
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
    write: (path, data, size) => encoder.write(path, data, size),
    mkdir: (path) => encoder.mkdir(path),
    finish: () => encoder.finish(),
    dispose: () => undefined
  }
}

interface Target {
  write(path: string, data: Uint8Array, size?: number): Promise<void>
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
      write: (path, data, size) => sink.write(path, data, size),
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
    write: async (id: string, path: string, data: Uint8Array, size?: number) =>
      get(id).write(path, data, size),
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
