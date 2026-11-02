import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import {
  openSync,
  closeSync,
  readSync,
  writeSync,
  fsyncSync,
  statSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync
} from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ChatMigrationSnapshot, ChatTransferHeader, ChatTransferManifest } from '../shared'
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
    writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 })
    renameSync(tmp, path(id, '.json'))
  }
  return {
    begin(manifest: ChatTransferManifest) {
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
      if (p.offset !== p.manifest.bytes || statSync(path(id, '.data')).size !== p.manifest.bytes)
        throw new Error('Incomplete transfer')
      store.stageTransfer(p.manifest, readTransferLines(path(id, '.data')))
      return {
        id: p.manifest.header.identity.id,
        hash: p.manifest.hash,
        epoch: p.manifest.header.identity.epoch + 1
      }
    },
    progress: (id: string) => load(id)
  }
}
