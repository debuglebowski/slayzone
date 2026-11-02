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
import type { ChatStorage } from './storage'
export const TRANSFER_CHUNK_BYTES = 256 * 1024
export function encodeTransfer(snapshot: ChatMigrationSnapshot) {
  const header: ChatTransferHeader = {
    format: 'slayzone-chat',
    version: 1,
    migrationId: snapshot.migrationId,
    identity: snapshot.identity,
    events: snapshot.events.length,
    records: snapshot.records.length,
    receipts: snapshot.receipts.length
  }
  const lines = [
    JSON.stringify(header),
    ...snapshot.events.map((value) => JSON.stringify({ kind: 'event', value })),
    ...snapshot.records.map((value) => JSON.stringify({ kind: 'record', value })),
    ...snapshot.receipts.map((value) => JSON.stringify({ kind: 'receipt', value }))
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
      for (const { id, header, progress: p } of entries()) {
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
            (!p || owner.migrationHash === p.manifest.hash) &&
            existsSync(path(id, '.data'))
          ) {
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
