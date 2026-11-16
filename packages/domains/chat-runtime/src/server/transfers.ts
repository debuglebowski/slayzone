import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import {
  openSync,
  closeSync,
  readSync,
  writeSync,
  fsyncSync,
  statSync,
  lstatSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ChatMigrationSnapshot, ChatTransferHeader, ChatTransferManifest } from '../shared'
import { chatTransferManifestSchema } from '../shared'
import { historyReadTurns } from '@slayzone/terminal/history-turns'
import type { ChatExportReader, ChatStorage } from './storage'
export const TRANSFER_CHUNK_BYTES = 256 * 1024
/**
 * Bytes of lines one step of a streamed export writes at most (one row always):
 * the event loop runs between steps (`historyReadTurns`).
 */
export const EXPORT_STEP_BYTES = 4 * 1024 * 1024

/** A transfer's first line. The ONE encoding, shared by `encodeTransfer` and `writeExportTransfer`. */
function transferHeader(
  meta: Pick<ChatMigrationSnapshot, 'migrationId' | 'identity'> & {
    events: number
    records: number
    receipts: number
  },
  opts?: { move?: boolean }
): ChatTransferHeader {
  return {
    format: 'slayzone-chat',
    version: 1,
    migrationId: meta.migrationId,
    identity: meta.identity,
    events: meta.events,
    records: meta.records,
    receipts: meta.receipts,
    ...(opts?.move ? { move: true as const } : {})
  }
}
/** One line of a transfer after its header (the ONE encoding, as `transferHeader`). */
function transferLine(kind: 'event' | 'record' | 'receipt', value: unknown): string {
  return JSON.stringify({ kind, value })
}

export function encodeTransfer(snapshot: ChatMigrationSnapshot, opts?: { move?: boolean }) {
  const header = transferHeader(
    {
      migrationId: snapshot.migrationId,
      identity: snapshot.identity,
      events: snapshot.events.length,
      records: snapshot.records.length,
      receipts: snapshot.receipts.length
    },
    opts
  )
  const lines = [
    JSON.stringify(header),
    ...snapshot.events.map((value) => transferLine('event', value)),
    ...snapshot.records.map((value) => transferLine('record', value)),
    ...snapshot.receipts.map((value) => transferLine('receipt', value))
  ]
  const bytes = Buffer.from(lines.join('\n') + '\n')
  return {
    bytes,
    manifest: {
      header,
      bytes: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex')
    } satisfies ChatTransferManifest
  }
}
/**
 * A conversation's transfer written to `path` from an export's read snapshot, a page
 * at a time: each step reads (at most) one history page, resolves its images back
 * inline and appends its lines, then the event loop runs (`historyReadTurns`) — never
 * the whole chat in memory or in one synchronous block. Byte-identical to
 * `encodeTransfer(exportConversation(...))` of the same chat (same encoder, same
 * reads). Written to `${path}.tmp`, fsynced, renamed. The caller closes the reader.
 */
export async function writeExportTransfer(
  reader: ChatExportReader,
  path: string,
  opts?: { move?: boolean }
): Promise<ChatTransferManifest> {
  const header = transferHeader(
    {
      migrationId: reader.migrationId,
      identity: reader.identity,
      events: reader.eventCount,
      records: reader.recordCount,
      receipts: reader.receiptCount
    },
    opts
  )
  const temp = `${path}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  const hash = createHash('sha256')
  let bytes = 0
  const write = (buffer: Buffer): void => {
    for (let at = 0; at < buffer.length; ) at += writeSync(fd, buffer, at)
    hash.update(buffer)
    bytes += buffer.length
  }
  const job = historyReadTurns.job()
  async function section<T>(
    kind: 'event' | 'record' | 'receipt',
    expected: number,
    page: () => { rows: T[]; more: boolean },
    value: (row: T) => unknown
  ) {
    let rows: T[] = [],
      at = 0,
      more = true,
      count = 0
    let pending: Buffer | undefined
    for (let done = false; !done; )
      done = await job.step(() => {
        // At most one stored page is loaded/parsed in a turn, even for tiny rows.
        if (at === rows.length) {
          if (!more) return true
          const next = page()
          rows = next.rows
          more = next.more
          at = 0
          if (rows.length === 0) {
            if (more) throw new Error(`Transfer integrity: empty ${kind} page`)
            return true
          }
        }
        let stepBytes = 0
        while (at < rows.length) {
          const buffer = pending ?? Buffer.from(transferLine(kind, value(rows[at])) + '\n')
          // Size the actual wire bytes before writing. Keep a resolved/encoded row
          // for the next turn rather than resolving an image or encoding it twice.
          if (stepBytes > 0 && stepBytes + buffer.length > EXPORT_STEP_BYTES) {
            pending = buffer
            break
          }
          pending = undefined
          write(buffer)
          stepBytes += buffer.length
          at++
          count++
          if (stepBytes >= EXPORT_STEP_BYTES) break
        }
        return !more && at === rows.length
      })
    if (count !== expected) throw new Error(`Transfer integrity: ${kind} count changed`)
  }
  try {
    await job.step(() => write(Buffer.from(JSON.stringify(header) + '\n')))
    let afterSeq = -1
    await section(
      'event',
      reader.eventCount,
      () => {
        const page = reader.eventPage(afterSeq)
        const last = page.events.at(-1)
        if (last) afterSeq = last.seq
        return { rows: page.events, more: page.more }
      },
      (event) => ({ ...event, event: reader.resolve(event.event) })
    )
    let afterRecord: Parameters<ChatExportReader['recordPage']>[0]
    await section(
      'record',
      reader.recordCount,
      () => {
        const page = reader.recordPage(afterRecord)
        const last = page.records.at(-1)
        if (last) afterRecord = { kind: last.kind, id: last.id }
        return { rows: page.records, more: page.more }
      },
      (record) => record
    )
    let afterReceipt: string | undefined
    await section(
      'receipt',
      reader.receiptCount,
      () => {
        const page = reader.receiptPage(afterReceipt)
        const last = page.receipts.at(-1)
        if (last) afterReceipt = last.id
        return { rows: page.receipts, more: page.more }
      },
      (receipt) => receipt
    )
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    unlinkSync(temp)
    throw error
  }
  closeSync(fd)
  renameSync(temp, path)
  return { header, bytes, hash: hash.digest('hex') }
}

export function* readTransferLines(path: string): Generator<string> {
  const fd = openSync(path, 'r'),
    buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES),
    decoder = new StringDecoder('utf8')
  let pending = ''
  try {
    let n: number
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      pending += decoder.write(buffer.subarray(0, n))
      let i: number
      while ((i = pending.indexOf('\n')) >= 0) {
        yield pending.slice(0, i)
        pending = pending.slice(i + 1)
      }
    }
    pending += decoder.end()
    if (pending) throw new Error('Transfer integrity: unterminated line')
  } finally {
    closeSync(fd)
  }
}
export function createChatTransfers(store: ChatStorage) {
  const dir = join(store.dir, 'transfers')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = (id: string, suffix: string) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid transfer id')
    return join(dir, id + suffix)
  }
  type Progress = { manifest: ChatTransferManifest; offset: number }
  function load(id: string): Progress {
    return JSON.parse(readFileSync(path(id, '.json'), 'utf8')) as Progress
  }
  function save(id: string, p: Progress) {
    const tmp = path(id, '.json.tmp')
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(p))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path(id, '.json'))
    syncDirectory()
  }
  function syncDirectory() {
    if (process.platform === 'win32') return
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  function erase(id: string) {
    // Keep the ownership-bearing descriptor until payload removal succeeds, so
    // startup and deletion retries can finish an interrupted cleanup.
    for (const suffix of ['.data', '.json.tmp', '.json'])
      if (existsSync(path(id, suffix))) unlinkSync(path(id, suffix))
    syncDirectory()
  }
  function entries() {
    const result: Array<{ id: string; header: ChatTransferHeader; progress?: Progress }> = []
    const ids = new Set(
      readdirSync(dir)
        .filter((name) => /^[a-f0-9]{64}\.(data|json(?:\.tmp)?)$/.test(name))
        .map((name) => name.slice(0, 64))
    )
    for (const id of ids) {
      let progress: Progress | undefined
      for (const suffix of ['.json', '.json.tmp']) {
        try {
          const value = JSON.parse(readFileSync(path(id, suffix), 'utf8')) as Progress
          const manifest = chatTransferManifestSchema.parse(value.manifest)
          if (
            Number.isSafeInteger(value.offset) &&
            value.offset >= 0 &&
            value.offset <= manifest.bytes
          ) {
            progress = { manifest, offset: value.offset }
            break
          }
        } catch {
          /* Recover identity from the self-describing payload below. */
        }
      }
      if (progress) {
        result.push({ id, progress, header: progress.manifest.header })
        continue
      }
      // A crash can persist payload bytes before their progress descriptor. The
      // bounded first line is sufficient to honor later owner/task tombstones.
      try {
        if (!lstatSync(path(id, '.data')).isFile()) continue
        const fd = openSync(path(id, '.data'), 'r'),
          buffer = Buffer.alloc(64 * 1024)
        let bytes: number
        try {
          bytes = readSync(fd, buffer, 0, buffer.length, 0)
        } finally {
          closeSync(fd)
        }
        const newline = buffer.subarray(0, bytes).indexOf(10)
        if (newline < 0) continue
        const header = chatTransferManifestSchema.shape.header.parse(
          JSON.parse(buffer.subarray(0, newline).toString('utf8'))
        )
        result.push({ id, header })
      } catch {
        // Unidentifiable damage cannot justify deleting another owner's data.
      }
    }
    return result
  }
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  function retryCleanup() {
    if (closed || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      if (closed) return
      try {
        api.collectActivated()
      } catch {
        retryCleanup()
      }
    }, 5000)
    retryTimer.unref()
  }
  const api = {
    begin(manifest: ChatTransferManifest) {
      if (store.taskLifecycle(manifest.header.identity.taskId).state === 'deleted')
        throw new Error('Task chat history was deleted')
      if (store.conversation(manifest.header.identity.id)?.state === 'deleted')
        throw new Error('Conversation deleted')
      if (
        !/^[a-f0-9]{64}$/.test(manifest.hash) ||
        !Number.isSafeInteger(manifest.bytes) ||
        manifest.bytes < 1
      )
        throw new Error('Invalid transfer manifest')
      const id = createHash('sha256')
        .update(JSON.stringify(['history', manifest.hash, manifest.bytes]))
        .digest('hex')
      if (existsSync(path(id, '.json'))) {
        const old = load(id)
        if (!isDeepStrictEqual(old.manifest, manifest))
          throw new Error('Transfer manifest conflict')
        return { id, offset: old.offset }
      }
      const file = path(id, '.data')
      if (!existsSync(file)) {
        const fd = openSync(file, 'wx', 0o600)
        closeSync(fd)
      }
      save(id, { manifest, offset: 0 })
      return { id, offset: 0 }
    },
    chunk(id: string, offset: number, bytes: Uint8Array) {
      const p = load(id)
      if (
        store.conversation(p.manifest.header.identity.id)?.state === 'deleted' ||
        store.taskLifecycle(p.manifest.header.identity.taskId).state === 'deleted'
      )
        throw new Error('Conversation deleted')
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !bytes.length ||
        bytes.length > TRANSFER_CHUNK_BYTES ||
        offset + bytes.length > p.manifest.bytes
      )
        throw new Error('Invalid transfer chunk')
      const fd = openSync(path(id, '.data'), 'r+')
      try {
        if (offset < p.offset) {
          if (offset + bytes.length > p.offset) throw new Error('Overlapping transfer chunk')
          const previous = Buffer.alloc(bytes.length)
          if (
            readSync(fd, previous, 0, previous.length, offset) !== bytes.length ||
            !previous.equals(Buffer.from(bytes))
          )
            throw new Error('Conflicting transfer retry')
          return { offset: p.offset }
        }
        if (offset !== p.offset) throw new Error('Transfer chunk gap')
        let written = 0
        while (written < bytes.length)
          written += writeSync(fd, bytes, written, bytes.length - written, offset + written)
        fsyncSync(fd)
        p.offset += bytes.length
        save(id, p)
        return { offset: p.offset }
      } finally {
        closeSync(fd)
      }
    },
    /** The manifest a transfer was begun with, or null when there is none for `id`. */
    manifestOf(id: string): ChatTransferManifest | null {
      try {
        return load(id).manifest
      } catch {
        return null
      }
    },
    finish(id: string) {
      const p = load(id)
      const owner = store.conversation(p.manifest.header.identity.id)
      if (
        owner?.state === 'active' &&
        owner.migrationId === p.manifest.header.migrationId &&
        owner.migrationHash === p.manifest.hash
      )
        return { id: owner.identity.id, hash: owner.migrationHash, epoch: owner.identity.epoch }
      if (p.offset !== p.manifest.bytes || statSync(path(id, '.data')).size !== p.manifest.bytes)
        throw new Error('Incomplete transfer')
      store.stageTransfer(p.manifest, readTransferLines(path(id, '.data')))
      return {
        id: p.manifest.header.identity.id,
        hash: p.manifest.hash,
        epoch: p.manifest.header.identity.epoch + 1
      }
    },
    collectActivated() {
      let pending = 0
      for (const { id, header } of entries()) {
        try {
          const owner = store.conversation(header.identity.id)
          if (
            owner?.state === 'deleted' ||
            store.taskLifecycle(header.identity.taskId).state === 'deleted'
          ) {
            erase(id)
            continue
          }
          if (
            owner?.state === 'active' &&
            owner.migrationId === header.migrationId &&
            owner.identity.epoch === header.identity.epoch + 1 &&
            owner.identity.taskId === header.identity.taskId &&
            owner.identity.tabId === header.identity.tabId &&
            owner.identity.mode === header.identity.mode &&
            owner.migrationHash &&
            existsSync(path(id, '.data'))
          ) {
            // Activation proves the complete destination for this exact owner.
            // An older partial stream (e.g. before a checkpoint-format upgrade)
            // cannot stage over it, even when its manifest hash differs.
            unlinkSync(path(id, '.data'))
            syncDirectory()
          }
        } catch {
          // Explicit deletion still throws on failure. Background cleanup keeps
          // healthy history usable and retries without claiming deletion ACK.
          pending++
        }
      }
      if (pending) retryCleanup()
      return { pending }
    },
    removeTask(taskId: string) {
      for (const { id, header } of entries()) if (header.identity.taskId === taskId) erase(id)
    },
    removeConversation(conversationId: string) {
      for (const { id, header } of entries()) if (header.identity.id === conversationId) erase(id)
    },
    resume(conversationId: string): ChatTransferManifest | null {
      const owner = store.conversation(conversationId)
      if (owner?.state !== 'prepared') return null
      for (const { progress: p } of entries()) {
        if (!p) continue
        const h = p.manifest.header
        if (
          h.identity.id !== conversationId ||
          h.migrationId !== owner.migrationId ||
          p.manifest.hash !== owner.migrationHash
        )
          continue
        if (
          h.identity.taskId !== owner.identity.taskId ||
          h.identity.tabId !== owner.identity.tabId ||
          h.identity.mode !== owner.identity.mode ||
          h.identity.epoch + 1 !== owner.identity.epoch ||
          p.offset !== p.manifest.bytes
        )
          throw new Error('Prepared transfer proof mismatch')
        return p.manifest
      }
      return null
    },
    progress: (id: string) => load(id),
    close() {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }
  return api
}
