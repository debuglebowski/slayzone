/**
 * Codex `fileChange` items (codex app-server ≥0.159): one item changes one or
 * more files. Each change is `{path, kind: {type: add|update|delete, move_path?},
 * diff}`, where `diff` is the whole new file for `add`, unified hunks
 * (`@@ -1 +1 @@\n-a\n+b\n`) for `update`, and the old file for `delete`.
 * The chat driver names the call `codex/fileChange`; the completed item is the
 * tool result's `structured`, the started item's `changes` its input.
 *
 * @module terminal/client/codex-file-changes
 */
import type { ToolInvocation } from './chat-timeline'

export const CODEX_FILE_CHANGE_TOOL = 'codex/fileChange'

export type CodexChangeKind = 'add' | 'update' | 'delete'

export interface CodexFileChange {
  /** The file as it is after the change (the new path of a move). */
  path: string
  /** The file before a move; absent when it was not moved. */
  movedFrom?: string
  kind: CodexChangeKind
  /** Codex's `diff`: new content (add), unified hunks (update), old content (delete). */
  diff: string
}

/** One unified-diff hunk, in jsdiff's / Claude's `structuredPatch` shape. */
export interface CodexPatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function changeKind(kind: unknown): { kind: CodexChangeKind; movePath?: string } | null {
  // 0.159.2: `{type, move_path?}`; older CLIs sent the bare type.
  const type = isRecord(kind) ? kind.type : kind
  if (type !== 'add' && type !== 'update' && type !== 'delete') return null
  const movePath = isRecord(kind) ? (str(kind.move_path) ?? str(kind.movePath)) : undefined
  return { kind: type, ...(movePath ? { movePath } : {}) }
}

/** The changes a Codex file-change call carries (completed item first, else its input). */
export function codexFileChanges(invocation: ToolInvocation): CodexFileChange[] {
  if (invocation.name !== CODEX_FILE_CHANGE_TOOL) return []
  const structured = invocation.result?.structured
  const fromResult = isRecord(structured) ? structured.changes : undefined
  const fromInput = isRecord(invocation.input) ? invocation.input.changes : undefined
  const raw = Array.isArray(fromResult) ? fromResult : Array.isArray(fromInput) ? fromInput : []
  const out: CodexFileChange[] = []
  for (const c of raw) {
    if (!isRecord(c)) continue
    const path = str(c.path)
    const kind = changeKind(c.kind)
    if (!path || !kind) continue
    out.push({
      path: kind.movePath ?? path,
      ...(kind.movePath ? { movedFrom: path } : {}),
      kind: kind.kind,
      diff: typeof c.diff === 'string' ? c.diff : ''
    })
  }
  return out
}

/** Lines of a text, without the empty one after a final newline. */
function textLines(text: string): string[] {
  if (!text) return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Unified hunks text → hunks. Text before the first `@@` (file headers) is skipped. */
export function parseUnifiedHunks(diff: string): CodexPatchHunk[] {
  const hunks: CodexPatchHunk[] = []
  let current: CodexPatchHunk | null = null
  for (const line of textLines(diff)) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: []
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    // `\ No newline at end of file` marks the line above; it is not content.
    if (line.startsWith('\\')) continue
    const prefix = line.charAt(0)
    current.lines.push(prefix === '+' || prefix === '-' || prefix === ' ' ? line : ` ${line}`)
  }
  return hunks
}

/** The change as hunks: a whole-file add / delete becomes one hunk. */
export function codexChangeHunks(change: CodexFileChange): CodexPatchHunk[] {
  if (change.kind === 'update') return parseUnifiedHunks(change.diff)
  // Some CLIs send a unified diff for add/delete too.
  if (change.diff.startsWith('@@')) return parseUnifiedHunks(change.diff)
  const lines = textLines(change.diff)
  if (lines.length === 0) return []
  return change.kind === 'add'
    ? [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: lines.length,
          lines: lines.map((l) => `+${l}`)
        }
      ]
    : [
        {
          oldStart: 1,
          oldLines: lines.length,
          newStart: 0,
          newLines: 0,
          lines: lines.map((l) => `-${l}`)
        }
      ]
}

/** Lines added / removed by one change. */
export function codexChangeCounts(change: CodexFileChange): {
  additions: number
  deletions: number
} {
  let additions = 0
  let deletions = 0
  for (const hunk of codexChangeHunks(change)) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) deletions++
    }
  }
  return { additions, deletions }
}

/**
 * The file's full content before / after the change, as far as the change
 * alone tells: an add knows both (nothing → its content), a delete both (its
 * content → nothing); an update knows neither.
 */
export function codexChangeContent(change: CodexFileChange): {
  before: string | null
  after: string | null
} {
  if (change.diff.startsWith('@@')) {
    return change.kind === 'add'
      ? { before: '', after: null }
      : change.kind === 'delete'
        ? { before: null, after: '' }
        : { before: null, after: null }
  }
  if (change.kind === 'add') return { before: '', after: change.diff }
  if (change.kind === 'delete') return { before: change.diff, after: '' }
  return { before: null, after: null }
}
