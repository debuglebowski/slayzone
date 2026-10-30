import { applyPatch, type StructuredPatchHunk } from 'diff'
import type { FileDiff } from '@slayzone/diff-view'
import {
  CODEX_FILE_CHANGE_TOOL,
  SHELL_TOOL_NAMES,
  codexChangeContent,
  codexChangeHunks,
  codexFileChanges,
  fileChangesOf,
  selectFoldedIndexes,
  type CodexFileChange,
  type TimelineRows,
  type ToolInvocation
} from '@slayzone/terminal/client'
import { claudeEditResultToFileDiff } from '../claude-patch-to-filediff'
import { codexChangeFileDiff, notebookEditDiff, textChangeDiff } from '../tool-cards/file-diffs'

/** One call of the agent's file tools on a file. */
export interface FileEdit {
  toolUseId: string
  invocation: ToolInvocation
  /** The file just before this call; '' when the call created it; null when unknown. */
  before: string | null
  /** The file just after this call; null when unknown. */
  after: string | null
  /** Inside a sub-agent: its card sits in the sub-agent row, not on the timeline. */
  nested: boolean
  /** A Codex file change: this file's part of the call (one call can change several files). */
  codexChange?: CodexFileChange
}

/** A file the conversation changed. */
export interface SessionFileChange {
  path: string
  /** Every call that changed it, in order. */
  edits: FileEdit[]
  /** Its first change created it. */
  created: boolean
}

export interface SessionFileChanges {
  files: SessionFileChange[]
  /** Shell commands the conversation ran: files they changed are not in `files`. */
  shellCommands: number
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** `before` with the call's patch applied (what the CLI wrote), or null when it doesn't fit. */
function patched(before: string, res: Record<string, unknown>): string | null {
  const hunks = Array.isArray(res.structuredPatch) ? res.structuredPatch : null
  if (hunks && hunks.length > 0) {
    const out = applyPatch(before, {
      oldFileName: undefined,
      newFileName: undefined,
      oldHeader: undefined,
      newHeader: undefined,
      hunks: hunks as StructuredPatchHunk[]
    })
    if (typeof out === 'string') return out
  }
  const oldString = str(res.oldString)
  const newString = str(res.newString)
  if (oldString && newString !== undefined && before.includes(oldString)) {
    return res.replaceAll === true
      ? before.split(oldString).join(newString)
      : before.replace(oldString, () => newString)
  }
  return hunks && hunks.length === 0 ? before : null
}

/** The file before and after one call, as far as its result tells. */
function contentOf(invocation: ToolInvocation): { before: string | null; after: string | null } {
  const input = isRecord(invocation.input) ? invocation.input : {}
  const res = isRecord(invocation.result?.structured) ? invocation.result.structured : {}
  if (invocation.name === 'NotebookEdit') return { before: null, after: null }
  if (invocation.name === 'Write') {
    const after = str(res.content) ?? str(input.content) ?? null
    if (res.type === 'create') return { before: '', after }
    return { before: str(res.originalFile) ?? null, after }
  }
  const before = str(res.originalFile) ?? null
  return { before, after: before === null ? null : patched(before, res) }
}

/**
 * One file of a Codex file change. Codex sends a new file's content and an
 * edit's hunks: an edit's content is known when the file's previous edit left a
 * known content (`previousAfter`) — it is assumed nothing else changed the file
 * in between (Codex reports no originals to check against).
 */
function codexContentOf(
  change: CodexFileChange,
  previousAfter: string | null
): { before: string | null; after: string | null } {
  const own = codexChangeContent(change)
  if (own.before !== null && own.after !== null) return own
  const before = own.before ?? previousAfter
  if (before === null) return { before: null, after: own.after }
  if (own.after !== null) return { before, after: own.after }
  const hunks = codexChangeHunks(change)
  if (hunks.length === 0) return { before, after: before }
  const out = applyPatch(before, {
    oldFileName: undefined,
    newFileName: undefined,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: hunks as StructuredPatchHunk[]
  })
  return { before, after: typeof out === 'string' ? out : null }
}

/**
 * Every file the agent's file tools (Edit, Write, MultiEdit, NotebookEdit,
 * Codex file changes) changed in the conversation as it is now: what a rewind,
 * fork or switch folded away is left out, like on the timeline. Files in
 * first-changed order.
 */
export function collectSessionFileChanges(timeline: Readonly<TimelineRows>): SessionFileChanges {
  const folded = selectFoldedIndexes(timeline)
  const byPath = new Map<string, SessionFileChange>()
  let shellCommands = 0
  timeline.forEach((it, i) => {
    if (it?.kind !== 'tool' || folded.has(i)) return
    if (SHELL_TOOL_NAMES.has(it.invocation.name)) shellCommands++
    const changes = fileChangesOf(it.invocation)
    if (changes.length === 0) return
    const codexChanges =
      it.invocation.name === CODEX_FILE_CHANGE_TOOL ? codexFileChanges(it.invocation) : null
    for (const change of changes) {
      const entry = byPath.get(change.path)
      const codexChange = codexChanges?.find((c) => c.path === change.path)
      const previousAfter = entry ? entry.edits[entry.edits.length - 1].after : null
      const edit: FileEdit = {
        toolUseId: it.invocation.id,
        invocation: it.invocation,
        ...(codexChange
          ? { ...codexContentOf(codexChange, previousAfter), codexChange }
          : contentOf(it.invocation)),
        nested: it.parentToolUseId != null
      }
      if (entry) entry.edits.push(edit)
      else byPath.set(change.path, { path: change.path, edits: [edit], created: change.created })
    }
  })
  return { files: [...byPath.values()], shellCommands }
}

/** How many files the conversation changed (the panel button's count), without building them. */
export function countSessionFiles(timeline: Readonly<TimelineRows>): number {
  const folded = selectFoldedIndexes(timeline)
  const paths = new Set<string>()
  timeline.forEach((it, i) => {
    if (it?.kind !== 'tool' || folded.has(i)) return
    for (const change of fileChangesOf(it.invocation)) paths.add(change.path)
  })
  return paths.size
}

/** One call's own diff (what its card shows). */
export function editDiff(path: string, edit: FileEdit): FileDiff | null {
  const { invocation } = edit
  const res = invocation.result?.structured
  if (invocation.name === 'NotebookEdit') return notebookEditDiff(invocation.input, res)
  if (edit.codexChange) return codexChangeFileDiff(edit.codexChange)
  if (edit.before !== null && edit.after !== null) {
    return textChangeDiff(path, edit.before, edit.after)
  }
  return claudeEditResultToFileDiff(res)
}

export type CombinedFileDiff =
  | {
      /** One diff: the file before its first change against the file after its last. */
      mode: 'combined'
      diff: FileDiff
      /**
       * The file changed between two of the agent's edits (a shell command, the
       * user): the combined diff includes that too.
       */
      outsideChanges: boolean
    }
  | {
      /** The edits one by one: the file's content is not known throughout. */
      mode: 'separate'
      why: 'notebook' | 'unknown-content'
      edits: Array<{ edit: FileEdit; diff: FileDiff | null }>
    }

/** The panel's diff for one file (computed when it is shown — whole files go through it). */
export function combinedFileDiff(change: SessionFileChange): CombinedFileDiff {
  const { edits, path } = change
  const first = edits[0]
  const last = edits[edits.length - 1]
  const notebook = edits.some((e) => e.invocation.name === 'NotebookEdit')
  if (!notebook && first.before !== null && last.after !== null) {
    const diff = textChangeDiff(path, first.before, last.after)
    if (diff) {
      let outsideChanges = false
      for (let k = 1; k < edits.length; k++) {
        const prev = edits[k - 1].after
        const cur = edits[k].before
        if (prev !== null && cur !== null && prev !== cur) outsideChanges = true
      }
      return {
        mode: 'combined',
        diff: { ...diff, isNew: change.created },
        outsideChanges
      }
    }
  }
  return {
    mode: 'separate',
    why: notebook ? 'notebook' : 'unknown-content',
    edits: edits.map((edit) => ({ edit, diff: editDiff(path, edit) }))
  }
}
