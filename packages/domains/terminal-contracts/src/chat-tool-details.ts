import { z } from 'zod'

/** Preview negotiation travels in the existing computer open method's version string. */
export const chatHistoryDisplaySchema = z.object({
  hideThinking: z.literal(true).optional(),
  hideActivities: z.literal(true).optional(),
  hideActivityMessages: z.literal(true).optional(),
  hideActivityTools: z.literal(true).optional(),
  windowed: z.literal(true).optional()
})
export type ChatHistoryDisplay = z.infer<typeof chatHistoryDisplaySchema>

/** The computer must acknowledge support before a client uses settings to page history. */
export const CHAT_HISTORY_DISPLAY_VERSION = 3

export function toolPreviewVersion(version: string, display?: ChatHistoryDisplay): string {
  const thinking = display?.hideThinking ? '+hide-thinking' : ''
  const activities = display?.hideActivities ? '+hide-activities' : ''
  const messages = display?.hideActivityMessages ? '+hide-activity-messages' : ''
  const tools = display?.hideActivityTools ? '+hide-activity-tools' : ''
  const window = display?.windowed ? '+windowed' : ''
  return `${version}+tool-previews-2${thinking}${activities}${messages}${tools}${window}`
}

export function parseToolPreviewVersion(
  version: string,
  requested: string
): ChatHistoryDisplay | null {
  const base = toolPreviewVersion(version)
  if (!requested.startsWith(base)) return null
  const flags =
    /^(\+hide-thinking)?(\+hide-activities)?(\+hide-activity-messages)?(\+hide-activity-tools)?(\+windowed)?$/.exec(
      requested.slice(base.length)
    )
  if (!flags) return null
  const [, thinking, activities, messages, tools, window] = flags
  return {
    ...(thinking ? { hideThinking: true } : {}),
    ...(activities ? { hideActivities: true } : {}),
    ...(messages ? { hideActivityMessages: true } : {}),
    ...(tools ? { hideActivityTools: true } : {}),
    ...(window ? { windowed: true } : {})
  }
}

export const chatToolDetailRefSchema = z.object({
  instance: z.string().min(1).max(128),
  epoch: z.number().int().nonnegative(),
  row: z.number().int().nonnegative(),
  toolUseId: z.string().min(1).max(500),
  preview: z.literal(true).optional()
})
export type ChatToolDetailRef = z.infer<typeof chatToolDetailRefSchema>

const chatTextBlockRefSchema = chatToolDetailRefSchema
  .omit({ toolUseId: true, preview: true })
  .extend({
    kind: z.enum(['thinking', 'text']),
    messageId: z.string().min(1).max(500),
    blockOrdinal: z.number().int().nonnegative().optional()
  })
export type ChatTextBlockRef = z.infer<typeof chatTextBlockRefSchema>

const chatResultCopyRefSchema = chatToolDetailRefSchema
  .omit({ toolUseId: true, preview: true })
  .extend({ kind: z.literal('result-copy'), timestamp: z.number() })
export type ChatResultCopyRef = z.infer<typeof chatResultCopyRefSchema>
const chatTextDetailRefSchema = z.union([chatTextBlockRefSchema, chatResultCopyRefSchema])
export type ChatTextDetailRef = z.infer<typeof chatTextDetailRefSchema>
export type ChatRowDetailRef = ChatToolDetailRef | ChatTextDetailRef

export function chatRowDetailIdentity(ref: ChatRowDetailRef): string {
  return JSON.stringify(
    'toolUseId' in ref
      ? [ref.toolUseId, ref.preview]
      : ref.kind === 'result-copy'
        ? [ref.kind, ref.timestamp]
        : [ref.kind, ref.messageId, ref.blockOrdinal]
  )
}

const revision = z.string().regex(/^[a-f0-9]{64}$/)

/** Keep even a heavily escaped chunk below the direct transport's message limit. */
export const CHAT_TOOL_DETAIL_CHARS = 64 * 1024
export const chatToolDetailInputSchema = z.object({
  tabId: z.string().min(1).max(500),
  detail: z.union([chatTextDetailRefSchema, chatToolDetailRefSchema]),
  offset: z.number().int().nonnegative(),
  revision: revision.optional()
})

export const chatToolDetailChunkSchema = z
  .object({
    data: z.string().min(1).max(CHAT_TOOL_DETAIL_CHARS),
    revision,
    next: z.number().int().positive().nullable()
  })
  .nullable()
export type ChatToolDetailChunk = z.infer<typeof chatToolDetailChunkSchema>

export interface ChatToolSearchResult {
  pages: number[]
  windowedPages?: number[]
  toolUseIds: string[]
  textMatches?: { epoch: number; rows: number[] }
}
