import { randomUUID } from 'node:crypto'
import type { ChatAttachment } from '@slayzone/terminal-contracts'
import type { ChatTransferManifest } from '../shared'
import type { ChatOwnershipStore, HubChatOwnership } from './hub-ownership'

export interface ChatMigrationSource {
  /** Called after the durable gate closes. Await all in-flight writers and flush. */
  quiesce(owner: HubChatOwnership): Promise<void>
  /** Deterministic, repeatable stream while the ownership gate is closed. */
  open(
    owner: HubChatOwnership,
    migrationId: string
  ): Promise<{
    manifest: ChatTransferManifest
    chunks(offset: number): AsyncIterable<Uint8Array>
  }>
  readAttachment(owner: HubChatOwnership, ref: ChatAttachment): Promise<Uint8Array>
  /** Idempotent; only source content is removed, never destination or routing metadata. */
  cleanup(owner: HubChatOwnership): Promise<void>
}
export type ChatComputerRequest = (computerId: string, request: unknown) => Promise<unknown>

/** Ownership commits once. Recovery after that point always moves forward. */
export function createChatMigration(opts: {
  ownership: ChatOwnershipStore
  source: ChatMigrationSource
  request: ChatComputerRequest
}) {
  const pending = new Map<string, Promise<HubChatOwnership>>()
  async function current(id: string) {
    const owner = await opts.ownership.get(id)
    if (!owner || owner.state === 'deleted') throw new Error('Chat ownership deleted or missing')
    return owner
  }
  async function run(id: string, computerId: string) {
    let owner = await current(id)
    if (owner.state === 'active' && !owner.cleanupPending) return owner
    if (owner.state === 'legacy') {
      owner = await opts.ownership.beginMigration(id, {
        expectedComputerId: owner.computerId,
        expectedEpoch: owner.epoch,
        migrationId: randomUUID(),
        destinationComputerId: computerId
      })
    }
    const migrationId = owner.migrationId
    const destination = owner.destinationComputerId
    if (!migrationId || !destination) throw new Error('Chat migration metadata is incomplete')
    if (destination !== computerId) throw new Error('Chat migration belongs to another computer')
    if (owner.state !== 'active') {
      await opts.source.quiesce(owner)
      const gated = await current(id)
      if (gated.migrationId !== migrationId || gated.epoch !== owner.epoch)
        throw new Error('Chat ownership changed during quiesce')
      const source = await opts.source.open(owner, migrationId)
      const { manifest } = source
      const start = (await opts.request(destination, { kind: 'transfer.begin', manifest })) as {
        id: string
        offset: number
      }
      if (!Number.isSafeInteger(start.offset) || start.offset < 0 || start.offset > manifest.bytes)
        throw new Error('Invalid destination transfer offset')
      let offset = start.offset
      for await (const bytes of source.chunks(offset)) {
        if (!bytes.length) continue
        const ack = (await opts.request(destination, {
          kind: 'transfer.chunk',
          id: start.id,
          offset,
          data: Buffer.from(bytes).toString('base64')
        })) as { offset: number }
        offset += bytes.length
        if (ack.offset !== offset) throw new Error('Invalid destination chunk acknowledgement')
      }
      if (offset !== manifest.bytes) throw new Error('Source transfer length changed')
      const staged = (await opts.request(destination, {
        kind: 'transfer.finish',
        id: start.id
      })) as { id: string; epoch: number; hash: string }
      if (staged.id !== id || staged.epoch !== owner.epoch + 1 || staged.hash !== manifest.hash)
        throw new Error('Destination verification mismatch')
      const verified = (await opts.request(destination, { kind: 'migration.verify', id })) as {
        missing: ChatAttachment[]
      }
      for (const ref of verified.missing) {
        const bytes = await opts.source.readAttachment(owner, ref)
        await opts.request(destination, {
          kind: 'attachment.put',
          route: { id, epoch: owner.epoch + 1 },
          ref,
          data: Buffer.from(bytes).toString('base64')
        })
      }
      const complete = (await opts.request(destination, { kind: 'migration.verify', id })) as {
        missing: ChatAttachment[]
      }
      if (complete.missing.length) throw new Error('Destination attachment verification incomplete')
      await opts.ownership.markVerified(id, migrationId, manifest.hash)
      owner = await opts.ownership.commitMigration(id, migrationId, manifest.hash)
    }
    await opts.request(destination, {
      kind: 'migration.activate',
      id,
      epoch: owner.epoch,
      migrationId,
      hash: owner.manifestHash
    })
    const activated = await current(id)
    if (
      activated.epoch !== owner.epoch ||
      activated.migrationId !== migrationId ||
      activated.state !== 'active'
    )
      throw new Error('Chat ownership changed before cleanup')
    await opts.source.cleanup(activated)
    return opts.ownership.completeCleanup(id, migrationId, activated.epoch)
  }
  return {
    ensure(id: string, computerId: string) {
      const existing = pending.get(id)
      if (existing) return existing
      const work = run(id, computerId).finally(() => {
        pending.delete(id)
      })
      pending.set(id, work)
      return work
    }
  }
}
