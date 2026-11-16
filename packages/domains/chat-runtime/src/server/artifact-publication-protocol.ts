/** Private owner port only. Public artifact schemas never accept filesystem paths. */
import { z } from 'zod'
import type { SerializedError } from '@slayzone/platform/sqlite-worker'
import type { TaskArtifact } from '@slayzone/task-contracts'
import type { ArtifactVersion, AuthorContext, VersionRef } from '@slayzone/task-artifacts/shared'
import type { ChatMetadataUpdate } from './local-data'

export type PublicationRoute = { id: string; epoch: number }
export type StagedPublicationRef = { sha256: string; size: number; uploadId?: string }
type Input = { staged: StagedPublicationRef; data?: never } | { data: string; staged?: never }
export type PublicationIntent =
  | {
      method: 'uploadArtifactBlob'
      args: [Input & { taskId: string; title: string; folderId?: string | null }]
    }
  | {
      method: 'writeArtifactContent'
      args: [
        Input & {
          artifactId: string
          append?: boolean
          mutateCurrent?: boolean
          mutateRef?: VersionRef
          author?: AuthorContext
        }
      ]
    }
export type OwnerStamp = { storeId: string; instanceId: string; connectionEpoch: number }
export type PublicationContext = {
  owner: OwnerStamp
  route: PublicationRoute
  taskId: string
  tabId: string
  lifecycleRevision: number
  operationId: string
  intentHash: string
}
export type PublicationSourceGrant = {
  kind: 'staged-path'
  leaseId: string
  entryId: string
  path: string
  ref: StagedPublicationRef
  identity: { dev: string; ino: string; size: number }
  binding:
    | {
        kind: 'owned'
        taskId: string
        route: PublicationRoute
        operationId: string
        revision: number
      }
    | { kind: 'legacy' }
}
export type InspectPublication = {
  route: PublicationRoute
  operationId: string
  intent: PublicationIntent
}
export type PublicationValue =
  | { method: 'uploadArtifactBlob'; result: TaskArtifact | null }
  | {
      method: 'writeArtifactContent'
      result: { artifact: TaskArtifact | null; version: ArtifactVersion }
    }
export type PublicationOutcome =
  | {
      kind: 'committed'
      value: PublicationValue
      replayed: boolean
      durability: 'owner-flush'
      metadata: ChatMetadataUpdate[]
    }
  | { kind: 'not-committed'; error: SerializedError; receipt: 'absent' | 'accepted-unconfirmed' }
  | { kind: 'unconfirmed'; error: SerializedError }
export type PublicationKey = { conversationId: string; operationId: string }
export type PublicationControl = { owner: OwnerStamp; key: PublicationKey; executionId: string }
export type CancelReason = 'request-aborted' | 'source-revoked' | 'lifecycle-fence' | 'shutdown'
export type CancelPublication = PublicationControl & { reason: CancelReason }
export type PublicationSettlement = PublicationControl & {
  kind: 'settled'
  quiescent: true
  outcome: PublicationOutcome
}
export type PublicationPhase = 'validating' | 'staging' | 'committing' | 'fencing' | 'closing-files'
export type PublicationStatus =
  | (PublicationControl & ({ kind: 'absent' } | { kind: 'running'; phase: PublicationPhase }))
  | PublicationSettlement
export type Inspection =
  | { kind: 'admit'; context: PublicationContext }
  | { kind: 'join'; context: PublicationContext; executionId: string }
  | { kind: 'replay'; context: PublicationContext; value: PublicationValue }
  | { kind: 'unconfirmed'; error: SerializedError }
export type PublishPublication = {
  executionId: string
  context: PublicationContext
  intent: PublicationIntent
  source?: PublicationSourceGrant
}

const id = z.string().min(1).max(200),
  integer = z.number().int().nonnegative().safe()
const staged = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: integer,
    uploadId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict()
const inline = z
  .string()
  .max(14_000_000)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
export const publicationRouteSchema = z.object({ id, epoch: integer }).strict()
const upload = { taskId: id, title: z.string().min(1).max(512), folderId: id.nullish() }
const write = {
  artifactId: id,
  append: z.boolean().optional(),
  mutateCurrent: z.boolean().optional(),
  mutateRef: z.union([z.string().max(200), z.number().int()]).optional(),
  author: z
    .object({ type: z.enum(['user', 'agent']).nullable(), id: z.string().nullable() })
    .optional()
}
export const publicationIntentSchema: z.ZodType<PublicationIntent> = z.union([
  z
    .object({
      method: z.literal('uploadArtifactBlob'),
      args: z.tuple([z.object({ ...upload, staged }).strict()])
    })
    .strict(),
  z
    .object({
      method: z.literal('uploadArtifactBlob'),
      args: z.tuple([z.object({ ...upload, data: inline }).strict()])
    })
    .strict(),
  z
    .object({
      method: z.literal('writeArtifactContent'),
      args: z.tuple([z.object({ ...write, staged }).strict()])
    })
    .strict(),
  z
    .object({
      method: z.literal('writeArtifactContent'),
      args: z.tuple([z.object({ ...write, data: inline }).strict()])
    })
    .strict()
])
export const inspectPublicationSchema = z
  .object({ route: publicationRouteSchema, operationId: id, intent: publicationIntentSchema })
  .strict()
export const publicationSourceSchema = z
  .object({
    kind: z.literal('staged-path'),
    leaseId: z.string().min(1).max(200),
    entryId: z.string().min(1).max(200),
    path: z.string().min(1),
    ref: staged,
    identity: z
      .object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/), size: integer })
      .strict(),
    binding: z.union([
      z.object({ kind: z.literal('legacy') }).strict(),
      z
        .object({
          kind: z.literal('owned'),
          taskId: id,
          route: publicationRouteSchema,
          operationId: id,
          revision: integer
        })
        .strict()
    ])
  })
  .strict()
