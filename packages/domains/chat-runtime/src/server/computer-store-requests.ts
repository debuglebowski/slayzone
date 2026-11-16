/** Store-only request groups. All route checks and dependent writes execute on one owner. */
import { forEachIsolatedSync, isStorageFatal } from '@slayzone/platform/isolation'
import type { ChatAttachment } from '@slayzone/terminal-contracts'
import type { ChatStoreServices } from './computer-chat-stores'
import type { ChatStoreJobs } from './computer-chat-store-jobs'
import { computerRequestSchema, type ComputerChatRequest } from './computer-request'
import type { ChatBootstrap } from './local-data'

export const STORE_REQUEST_KINDS = [
  'inventory',
  'migration.prepared',
  'migration.activate',
  'attachment.has',
  'attachment.put',
  'attachment.read',
  'ackMetadata',
  'sessionMove.forget'
] as const
export type StoreRequest = Extract<
  ComputerChatRequest,
  { kind: (typeof STORE_REQUEST_KINDS)[number] }
>
export function createStoreRequests(r: ChatStoreServices & ChatStoreJobs) {
  return {
    async handle(raw: StoreRequest): Promise<unknown> {
      const req = computerRequestSchema.parse(raw)
      switch (req.kind) {
        case 'inventory': {
          const entries: Array<Record<string, unknown>> = []
          forEachIsolatedSync(
            r.storage.inventory().filter((o) => !o.identity.id.startsWith('__')),
            {
              pass: 'computer.chat-inventory',
              key: (o) => o.identity.id,
              taskId: (o) => o.identity.taskId,
              ledger: r.storage.faults,
              ignoreGate: true,
              isFatal: isStorageFatal
            },
            (o) => {
              try {
                entries.push({
                  ...o,
                  hasConversationContent: r.storage.hasConversationContent(o.identity.id),
                  bootstrapRevision:
                    r.storage.getRecord<ChatBootstrap>(o.identity.id, 'settings', 'bootstrap')
                      ?.revision ?? 0,
                  inbox: !!r.storage.getRecord(o.identity.id, 'settings', 'inbox'),
                  tabTransitions: r.storage
                    .records(o.identity.id, 'settings')
                    .filter((record) => record.id.startsWith('tab-transition:'))
                    .map((record) => record.value),
                  lifecycle: r.storage.taskLifecycle(o.identity.taskId),
                  metadataCounter:
                    r.storage.getRecord<number>(o.identity.id, 'settings', 'metadata-counter') ?? 0,
                  historySeq: r.storage.nextSeq(o.identity.id) - 1,
                  stateVersion: r.storage.stateVersion(o.identity.taskId),
                  storeId: r.storage.storeId()
                })
              } catch (error) {
                entries.push({ ...o, unreadable: true })
                throw error
              }
            }
          )
          return entries
        }
        case 'migration.prepared': {
          const owner = r.storage.conversation(req.id),
            manifest = r.transfers.resume(req.id)
          if (owner?.state !== 'prepared' || !manifest) return null
          return {
            migrationId: owner.migrationId,
            epoch: owner.identity.epoch,
            hash: owner.migrationHash,
            manifest,
            attachments: r.storage
              .records(req.id, 'attachment')
              .filter((record) => record.kind === 'attachment')
              .map((record) => {
                const { artifactId, contentHash, name, kind, mediaType, size } =
                  record.value as ChatAttachment
                return { artifactId, contentHash, name, kind, mediaType, size }
              })
          }
        }
        case 'migration.activate': {
          const owner = r.storage.conversation(req.id)
          if (owner?.state === 'prepared' && r.attachments.missing(req.id).length)
            throw new Error('Migration attachments are incomplete')
          r.storage.activate(req.id, req.migrationId, req.epoch, req.hash)
          r.transfers.collectActivated()
          return { ok: true }
        }
        case 'attachment.has':
        case 'attachment.read':
        case 'attachment.put': {
          const owner = r.storage.conversation(req.route.id)
          if (
            !owner ||
            owner.identity.epoch !== req.route.epoch ||
            (req.kind === 'attachment.read'
              ? owner.state === 'deleted'
              : req.kind === 'attachment.has' && owner.state !== 'active')
          )
            throw new Error('Attachment ownership mismatch')
          if (req.kind === 'attachment.put') {
            const bytes = Buffer.from(req.data, 'base64')
            if (owner.state === 'prepared') {
              r.attachments.putPrepared(req.route.id, req.route.epoch, req.ref, bytes)
              return req.ref
            }
            if (owner.state !== 'active') throw new Error('Attachment conversation is unavailable')
            return r.attachments.put(owner.identity.tabId, req.ref, bytes)
          }
          if (req.kind === 'attachment.has') {
            if (
              !req.ref.contentHash ||
              !r.storage.getRecord(
                req.route.id,
                'attachment',
                `${req.ref.artifactId}:${req.ref.contentHash}`
              )
            )
              return { present: false }
            try {
              await r.attachments.reader.read(req.ref)
              return { present: true }
            } catch {
              return { present: false }
            }
          }
          if (
            !r.storage
              .records(req.route.id, 'attachment')
              .some(
                (row) =>
                  row.kind === 'attachment' &&
                  (row.value as ChatAttachment).artifactId === req.ref.artifactId &&
                  (!req.ref.contentHash ||
                    (row.value as ChatAttachment).contentHash === req.ref.contentHash)
              )
          )
            throw new Error('Attachment does not belong to this conversation')
          const bytes = await r.attachments.reader.read(req.ref)
          const current = r.storage.conversation(req.route.id)
          if (!current || current.state === 'deleted' || current.identity.epoch !== req.route.epoch)
            throw new Error('Attachment ownership mismatch')
          return { data: Buffer.from(bytes).toString('base64') }
        }
        case 'ackMetadata': {
          const owner = r.storage.conversation(req.id)
          if (!owner) throw new Error('Unknown conversation')
          r.storage.removeRecord(
            req.id,
            owner.identity.epoch,
            'settings',
            `metadata:${req.operationId}`
          )
          return { ok: true }
        }
        case 'sessionMove.forget': {
          const tabs = r.sessionMoves.forgetTask(req.taskId)
          r.transfers.removeTask(req.taskId)
          r.attachments.collectGarbage()
          r.storage.checkpoint()
          return { forgotten: tabs.length }
        }
        default:
          throw new Error('Request does not belong to the store')
      }
    }
  }
}
