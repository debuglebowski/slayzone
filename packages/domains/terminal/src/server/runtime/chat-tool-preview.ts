import { jsonByteLength, utf8Length, type ChatHistoryDisplay } from '@slayzone/terminal-contracts'
import { isAgentLauncherToolName } from '../../shared/chat-presentation'
import type { TimelineItem, TimelineRows, ToolInvocation } from '../../shared/chat-timeline'
import { CODEX_FILE_CHANGE_TOOL } from '../../shared/codex-file-changes'
import { FILE_TOOL_NAMES, SHELL_TOOL_NAMES, fileChangesOf } from '../../shared/turn-file-changes'

const INLINE_BYTES = 4_096
const WINDOW_INLINE_BYTES = 1_024
const PREVIEW_CHARS = 384

function exceedsInlineBudget(text: string, budget: number): boolean {
  return text.length > budget || (text.length * 3 > budget && utf8Length(text) > budget)
}

function textPreview(text: string): string {
  const last = text.charCodeAt(PREVIEW_CHARS - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? PREVIEW_CHARS - 1 : PREVIEW_CHARS
  return `${text.slice(0, end)}…`
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Preserve tool-specific metadata used by collapsed headers and transcript features. */
function resultPreview(invocation: ToolInvocation, budget: number): ToolInvocation['result'] {
  const { result } = invocation
  if (!result) return result
  let { rawContent, structured } = result
  if (typeof rawContent === 'string' && exceedsInlineBudget(rawContent, budget)) {
    rawContent = textPreview(rawContent)
  } else if (Array.isArray(rawContent)) {
    // Text-only SDK blocks can be previewed together. Keep other blocks intact
    // so image refs and embedded resources remain available in collapsed cards.
    let total = 0
    let head = ''
    let textOnly = true
    for (const block of rawContent) {
      const obj = record(block)
      const text = typeof block === 'string' ? block : obj?.type === 'text' ? obj.text : null
      if (typeof text !== 'string') {
        textOnly = false
        break
      }
      if (total <= budget) total += (text.length > budget ? text.length : utf8Length(text)) + 1
      if (head.length <= PREVIEW_CHARS) head += text.slice(0, PREVIEW_CHARS + 1) + '\n'
    }
    if (textOnly && total > budget) {
      rawContent = [{ type: 'text', text: textPreview(head) }]
    }
  }
  const data = record(structured)
  if (invocation.name === 'Read') {
    const file = record(data?.file)
    if (file && typeof file.content === 'string' && exceedsInlineBudget(file.content, budget)) {
      structured = { ...data, file: { ...file, content: textPreview(file.content) } }
    }
  }
  if (invocation.name === 'Write' && typeof data?.content === 'string') {
    // Write's renderer and file counts both read the input if the result mirrors it.
    const input = record(invocation.input)
    if (exceedsInlineBudget(data.content, budget) && data.content === input?.content) {
      const { content: _content, ...metadata } = data
      structured = metadata
    }
  }
  if (invocation.name === 'codex/commandExecution' && data) {
    for (const key of ['aggregatedOutput', 'output', 'stdout', 'stderr']) {
      const text = data[key]
      if (typeof text === 'string' && exceedsInlineBudget(text, budget)) {
        structured = { ...record(structured), [key]: textPreview(text) }
      }
    }
  }
  return rawContent === result.rawContent && structured === result.structured
    ? result
    : { ...result, rawContent, structured }
}

/** Keep header fields and file identities. The recorded edit is read in full when opened. */
function fileInputPreview(input: unknown, name: string, budget: number): unknown {
  const data = record(input)
  if (!data) return input
  switch (name) {
    case 'Write':
      return previewTextFields(data, ['content'], budget)
    case 'Edit':
      return previewTextFields(data, ['old_string', 'new_string'], budget)
    case 'MultiEdit':
      return Array.isArray(data.edits) && jsonByteLength(data.edits) > budget
        ? {
            ...data,
            edits: data.edits.slice(0, 2).map((edit) => ({
              old_string: shortText(record(edit)?.old_string),
              new_string: shortText(record(edit)?.new_string)
            }))
          }
        : input
    case 'NotebookEdit':
      return previewTextFields(data, ['new_source'], budget)
    case CODEX_FILE_CHANGE_TOOL:
      return previewCodexDiffs(data, budget)
    default:
      return input
  }
}

function shortText(value: unknown): unknown {
  return typeof value === 'string' && value.length > PREVIEW_CHARS ? textPreview(value) : value
}

function previewTextFields(
  data: Record<string, unknown>,
  fields: readonly string[],
  budget: number
) {
  let preview = data
  for (const field of fields) {
    const value = data[field]
    if (typeof value === 'string' && exceedsInlineBudget(value, budget))
      preview = { ...preview, [field]: textPreview(value) }
  }
  return preview
}

function previewCodexDiffs(data: Record<string, unknown>, budget: number) {
  if (!Array.isArray(data.changes) || jsonByteLength(data.changes) <= budget) return data
  return {
    ...data,
    changes: data.changes.flatMap((change) => {
      const item = record(change)
      return item ? [{ path: item.path, kind: item.kind, diff: '' }] : []
    })
  }
}

function fileResultPreview(
  invocation: ToolInvocation,
  result: ToolInvocation['result'],
  budget: number
) {
  const data = record(result?.structured)
  if (!result || !data) return result
  let structured =
    invocation.name === CODEX_FILE_CHANGE_TOOL
      ? previewCodexDiffs(data, budget)
      : previewTextFields(
          data,
          ['content', 'originalFile', 'oldString', 'newString', 'old_source', 'new_source'],
          budget
        )
  if (Array.isArray(data.structuredPatch) && jsonByteLength(data.structuredPatch) > budget) {
    structured = { ...structured, structuredPatch: [] }
  }
  return structured === data ? result : { ...result, structured }
}

/** The saved projection remains complete. Only negotiated wire rows are compacted. */
function previewToolRow(
  item: TimelineItem,
  row: number,
  epoch: number,
  instance: string,
  hideActivityTools: boolean,
  budget: number
): TimelineItem {
  if (item.kind !== 'tool' || item.inputStreaming) return item
  const { invocation } = item
  if (
    !invocation.id ||
    invocation.id.length > 500 ||
    invocation.status === 'pending' ||
    invocation.task?.status === 'running' ||
    invocation.name === 'AskUserQuestion' ||
    invocation.name === 'ExitPlanMode'
  )
    return item

  const fileTool =
    FILE_TOOL_NAMES.has(invocation.name) || invocation.name === CODEX_FILE_CHANGE_TOOL
  const args = record(invocation.input)
  const toolDetail = { instance, epoch, row, toolUseId: invocation.id }
  // A completed root tool may still be revealed by search or file history.
  // Keep the fields a late event needs for workspace changes and background jobs.
  if (
    hideActivityTools &&
    !item.parentToolUseId &&
    invocation.status === 'done' &&
    invocation.name &&
    !isAgentLauncherToolName(invocation.name)
  ) {
    const toolInput: Record<string, unknown> = {}
    const fields = SHELL_TOOL_NAMES.has(invocation.name)
      ? ['command', 'description']
      : fileTool
        ? ['file_path', 'notebook_path']
        : []
    for (const field of fields) if (args && field in args) toolInput[field] = args[field]
    return {
      ...item,
      invocation: {
        ...invocation,
        input: Object.keys(toolInput).length ? toolInput : null,
        result: invocation.result
          ? { rawContent: null, structured: null, isError: invocation.result.isError }
          : undefined,
        task: invocation.task && { ...invocation.task, finalOutput: undefined },
        toolPreview: {
          hidden: true,
          input: true,
          ...(fileTool ? { files: fileChangesOf(invocation) } : {})
        },
        toolDetail
      }
    }
  }
  const input = fileTool
    ? fileInputPreview(invocation.input, invocation.name, budget)
    : args
      ? previewTextFields(args, Object.keys(args), budget)
      : typeof invocation.input === 'string' && exceedsInlineBudget(invocation.input, budget)
        ? textPreview(invocation.input)
        : invocation.input
  const outputPreview = resultPreview(invocation, budget)
  const result = fileTool ? fileResultPreview(invocation, outputPreview, budget) : outputPreview
  const inputChanged = input !== invocation.input
  const fileDetailChanged =
    fileTool && (inputChanged || result?.structured !== invocation.result?.structured)
  let { task } = invocation
  const finalOutput = task?.finalOutput
  if (task && finalOutput && exceedsInlineBudget(finalOutput.output, budget)) {
    task = { ...task, finalOutput: { ...finalOutput, output: textPreview(finalOutput.output) } }
  }
  if (!inputChanged && result === invocation.result && task === invocation.task) return item

  const preview: ToolInvocation = {
    ...invocation,
    input,
    result,
    task,
    ...(inputChanged || fileDetailChanged
      ? {
          toolPreview: {
            ...(inputChanged ? { input: true as const } : {}),
            ...(inputChanged && invocation.name === 'MultiEdit' && Array.isArray(args?.edits)
              ? { editCount: args.edits.length }
              : {}),
            ...(fileDetailChanged ? { files: fileChangesOf(invocation) } : {})
          }
        }
      : {}),
    toolDetail
  }
  return { ...item, invocation: preview }
}

/**
 * Two root text blocks in the same completed segment can't both be final.
 * Keep the last inline. Boundaries also cover user-message folds, interruptions,
 * and page gaps so a loaded fragment never depends on another page's contents.
 */
export function hiddenActivityTextRows(
  rows: Readonly<TimelineRows>,
  start: number,
  offset: number
): ReadonlySet<number> {
  const hidden = new Set<number>()
  let completed = false
  let hasLaterText = false
  for (let index = rows.length - 1; index >= start; index--) {
    const item = rows[index]
    if (item?.parentToolUseId != null) continue
    if (item?.kind === 'result') {
      completed = !item.isError
      hasLaterText = false
    } else if (
      !item ||
      item.kind === 'user-text' ||
      item.kind === 'interrupted' ||
      item.kind === 'turn-error' ||
      item.kind === 'conversation-branch'
    ) {
      completed = false
      hasLaterText = false
    } else if (completed && item.kind === 'text' && item.text && !item.stream) {
      if (hasLaterText) hidden.add(offset + index)
      hasLaterText = true
    }
  }
  return hidden
}

export function previewTimelineRow(
  item: TimelineItem,
  row: number,
  epoch: number,
  instance: string,
  display?: ChatHistoryDisplay,
  hideActivityText = false,
  completedTurn = false
): TimelineItem {
  const hideCompletedActivities = display?.hideActivities === true && completedTurn
  if (
    (((display?.hideThinking || (hideCompletedActivities && !item.parentToolUseId)) &&
      item.kind === 'thinking') ||
      (hideActivityText && item.kind === 'text')) &&
    !item.stream &&
    item.text &&
    item.messageId.length > 0 &&
    item.messageId.length <= 500
  ) {
    return {
      ...item,
      text: '',
      textDetail: {
        kind: item.kind,
        instance,
        epoch,
        row,
        messageId: item.messageId,
        ...(item.blockOrdinal !== undefined ? { blockOrdinal: item.blockOrdinal } : {})
      }
    }
  }
  if (
    (display?.hideActivityMessages || display?.hideActivities || display?.windowed) &&
    item.kind === 'result' &&
    item.copyText
  ) {
    return {
      ...item,
      copyText: null,
      copyDetail: { kind: 'result-copy', instance, epoch, row, timestamp: item.timestamp }
    }
  }
  return previewToolRow(
    item,
    row,
    epoch,
    instance,
    display?.hideActivityTools === true || hideCompletedActivities,
    display?.windowed ? WINDOW_INLINE_BYTES : INLINE_BYTES
  )
}
