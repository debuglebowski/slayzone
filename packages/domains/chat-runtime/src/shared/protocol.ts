import { z } from 'zod'
import { SIDE_QUESTION_MAX_CHARS } from '@slayzone/terminal-contracts'

const id = z.string().min(1).max(500),
  text = z.string().max(1_000_000)
export const chatIdentitySchema = z.object({
  id,
  taskId: id,
  tabId: id,
  mode: z.enum(['claude-chat', 'codex-chat']),
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
})
export const chatRouteSchema = z.object({
  id,
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
})
export const chatAttachmentSchema = z
  .object({
    artifactId: id,
    contentHash: z.string().max(128).optional(),
    name: z.string().min(1).max(512),
    kind: z.enum(['image', 'pdf', 'text']),
    mediaType: z.enum([
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'application/pdf',
      'text/plain'
    ]),
    size: z.number().int().nonnegative()
  })
  .strict()
export const chatContentSchema = z
  .array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text }),
      z.object({ type: z.literal('attachment'), attachment: chatAttachmentSchema })
    ])
  )
  .max(200)
export const chatDraftSchema = z.object({
  text,
  attachments: z.array(chatAttachmentSchema).max(100)
})
const create = z.object({
  tabId: id,
  taskId: id,
  mode: z.enum(['claude-chat', 'codex-chat']),
  cwd: z.string().max(10000),
  providerFlagsOverride: z.string().nullish()
})
const rewind = create.extend({ messageId: id, scope: z.enum(['before', 'after']) })
const permissions = z.object({
  requestId: id,
  optionId: id.optional(),
  decision: z.discriminatedUnion('behavior', [
    z.object({
      behavior: z.literal('allow'),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      updatedPermissions: z.array(z.unknown()).optional(),
      scope: z.literal('session').optional(),
      amendment: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('execpolicy'), command: z.array(z.string()) }),
          z.object({
            kind: z.literal('network'),
            host: z.string(),
            action: z.enum(['allow', 'deny'])
          })
        ])
        .optional()
    }),
    z.object({
      behavior: z.literal('deny'),
      message: z.string().optional(),
      interrupt: z.boolean().optional()
    })
  ])
})
const tab = z.tuple([id]),
  taskMode = z.tuple([id, z.string()]),
  createTuple = z.tuple([create])
export const chatOperationSchemas = {
  askSideQuestion: z.tuple([
    create.extend({
      requestId: id,
      question: z.string().trim().min(1).max(SIDE_QUESTION_MAX_CHARS),
      history: z
        .array(
          z.object({
            question: z.string().max(SIDE_QUESTION_MAX_CHARS),
            answer: z.string().max(200_000)
          })
        )
        .max(50)
    })
  ]),
  cancelSideQuestion: z.tuple([z.object({ tabId: id, requestId: id })]),
  supports: z.tuple([z.string()]),
  testSetWatchdogTimings: z.tuple([
    z
      .object({
        startingBoundMs: z.number().positive(),
        runningStallMs: z.number().positive(),
        killGraceMs: z.number().positive(),
        spawnReplyBoundMs: z.number().positive().optional()
      })
      .nullable()
  ]),
  hydrate: createTuple,
  start: z.tuple([create.extend({ reason: z.enum(['user', 'restore']).optional() })]),
  restart: createTuple,
  interrupt: createTuple,
  abortAndPop: createTuple,
  reset: createTuple,
  send: z.tuple([id, z.object({ id, content: chatContentSchema.min(1) })]),
  sendToolResult: z.tuple([
    id,
    z.object({ toolUseId: id, content: z.string(), isError: z.boolean().optional() })
  ]),
  respondPermission: z.tuple([id, permissions]),
  rewindPreview: z.tuple([rewind]),
  rewind: z.tuple([rewind.extend({ conversation: z.boolean(), files: z.boolean() })]),
  fork: z.tuple([create.extend({ messageId: id })]),
  listThreads: z.tuple([create.extend({ conversationId: z.string().nullish() })]),
  createThread: z.tuple([
    create.extend({
      messageId: id,
      answerId: id,
      title: z.string().trim().min(1).max(120),
      text: text.min(1)
    })
  ]),
  switchConversation: z.tuple([
    create.extend({ conversationId: z.string().uuid(), sourceMode: z.string() })
  ]),
  continueInTerminal: createTuple,
  continueInChat: createTuple,
  takeOver: createTuple,
  kill: tab,
  remove: tab,
  getReplay: z.tuple([id, z.number().int()]),
  getBufferSince: z.tuple([id, z.number().int()]),
  getInfo: z.tuple([id, z.string().optional()]),
  openTimeline: z.tuple([id, z.string()]),
  timelinePages: z.tuple([
    id,
    z.array(z.number().int().nonnegative()).max(512),
    z.number().int(),
    z.number().int()
  ]),
  searchTimeline: z.tuple([id, z.string().max(1000)]),
  commandTaskOutput: z.tuple([id, id]),
  stopCommandTask: z.tuple([id, id]),
  backgroundCommandTask: z.tuple([id, id]),
  getWorkspaceChanges: z.tuple([id, id]),
  getWorkspaceFileDiff: z.tuple([id, id, z.string().max(10000)]),
  inspectPermissions: taskMode,
  getMode: taskMode,
  getModel: taskMode,
  getEffort: taskMode,
  getCollaboration: taskMode,
  getFastMode: taskMode,
  getModels: taskMode,
  getCliSnapshot: taskMode,
  getCliCommandDetails: taskMode,
  getAutoEligibility: z.tuple([]),
  setMode: z.tuple([
    create.extend({ chatMode: z.string(), stopAndResume: z.boolean().optional() })
  ]),
  setModel: z.tuple([create.extend({ chatModel: z.string() })]),
  setEffort: z.tuple([create.extend({ chatEffort: z.string() })]),
  setCollaboration: z.tuple([create.extend({ chatCollaboration: z.string() })]),
  setFastMode: z.tuple([create.extend({ chatFastMode: z.boolean() })]),
  decidePlan: z.tuple([
    create.extend({
      planId: id,
      decision: z.enum(['implement', 'keep-planning']),
      messageId: id.optional()
    })
  ]),
  listSkills: z.tuple([z.string()]),
  listCommands: z.tuple([z.string(), z.object({ nested: z.boolean().optional() }).optional()]),
  listAgents: z.tuple([z.string()]),
  listFiles: z.tuple([z.string(), z.string(), z.number().positive().optional()]),
  bumpAutocompleteUsage: z.tuple([z.string(), z.string()]),
  getAutocompleteUsage: z.tuple([]),
  getTabState: tab,
  saveTabDraft: z.tuple([id, chatDraftSchema]),
  saveTabScroll: z.tuple([
    id,
    z.union([
      z.object({ atBottom: z.literal(true) }),
      z.object({
        atBottom: z.literal(false),
        key: id,
        offsetPx: z.number(),
        row: z.number().int().nonnegative().optional()
      })
    ])
  ])
} as const
const queueOptions = z
  .object({
    id: id.optional(),
    content: chatContentSchema.optional(),
    expectedConversationId: id.optional()
  })
  .optional()
export const chatQueueOperationSchemas = {
  list: tab,
  push: z.tuple([id, text, text, queueOptions]),
  update: z.tuple([id, z.object({ send: text, original: text, content: chatContentSchema })]),
  move: z.tuple([id, z.number().int().nonnegative()]),
  hold: tab,
  release: tab,
  remove: tab,
  clear: tab
} as const
export type ChatOperation = keyof typeof chatOperationSchemas
export type ChatQueueOperation = keyof typeof chatQueueOperationSchemas
export const CHAT_READ_OPERATIONS = new Set<ChatOperation>([
  'supports',
  'getReplay',
  'getBufferSince',
  'getInfo',
  'openTimeline',
  'timelinePages',
  'searchTimeline',
  'commandTaskOutput',
  'getWorkspaceChanges',
  'getWorkspaceFileDiff',
  'listThreads',
  'inspectPermissions',
  'getMode',
  'getModel',
  'getEffort',
  'getCollaboration',
  'getFastMode',
  'getModels',
  'getCliSnapshot',
  'getCliCommandDetails',
  'getAutoEligibility',
  'listSkills',
  'listCommands',
  'listAgents',
  'listFiles',
  'getAutocompleteUsage',
  'getTabState'
])
const envelope = z.object({
  route: chatRouteSchema,
  target: z.enum(['ops', 'queue']),
  method: z.string(),
  operationId: id.optional(),
  args: z.array(z.unknown()).max(16)
})
export function parseChatInvocation(input: unknown) {
  const request = envelope.parse(input)
  const schemas = request.target === 'ops' ? chatOperationSchemas : chatQueueOperationSchemas
  if (!Object.hasOwn(schemas, request.method)) throw new Error('Unknown chat operation')
  const schema = (schemas as Record<string, z.ZodType>)[request.method]
  const args = schema.parse(request.args) as unknown[]
  const read =
    request.target === 'queue'
      ? request.method === 'list'
      : CHAT_READ_OPERATIONS.has(request.method as ChatOperation)
  if (!read && !request.operationId) throw new Error('Chat command requires an operation id')
  return { ...request, args }
}
export type ChatInvocation = ReturnType<typeof parseChatInvocation>
export const chatBootstrapSchema = z.object({
  identity: chatIdentitySchema,
  projectId: id.nullable(),
  cwd: z.string().max(10000),
  revision: z.number().int().nonnegative(),
  providerConfig: z.object({
    conversationId: z.string().nullish(),
    chatConversationId: z.string().nullish(),
    flags: z.string().nullish(),
    chatMode: z.string().nullish(),
    chatModel: z.string().nullish(),
    chatEffort: z.string().nullish(),
    chatCollaboration: z.enum(['default', 'plan']).nullish(),
    chatFastMode: z.boolean().optional()
  }),
  defaultFlags: z.string().nullable(),
  settings: z.record(z.string(), z.string().nullable()).optional(),
  terminalProviderConfig: z.record(z.string(), z.unknown()).optional(),
  honoredConversations: z.array(z.string()).optional(),
  deletedConversations: z
    .array(z.object({ mode: z.string(), conversationId: z.string() }))
    .optional(),
  env: z.record(z.string(), z.string())
})
export const chatTransferManifestSchema = z.object({
  header: z.object({
    format: z.literal('slayzone-chat'),
    version: z.literal(1),
    migrationId: z.string().min(1),
    identity: chatIdentitySchema,
    events: z.number().int().nonnegative(),
    records: z.number().int().nonnegative(),
    receipts: z.number().int().nonnegative()
  }),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
})
