/**
 * Bounded git text (FU1 S5), shared by renderer, hub and computer: what a paged
 * git-text read names, what one page answers, and the marker an expired cursor
 * fails with (in the message, so it survives any transport).
 */

/** The marker an unknown, foreign or expired git-text cursor fails with. */
export const GIT_TEXT_EXPIRED = 'GIT_TEXT_EXPIRED'

/** Whether `err` is {@link GIT_TEXT_EXPIRED}: start the read again from its first page. */
export function isGitTextExpired(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return message.includes(GIT_TEXT_EXPIRED)
}

/** A diff's display options, as the panel sends them. */
export interface GitDiffTextOpts {
  contextLines?: string
  ignoreWhitespace?: boolean
}

/** One text a paged read covers. `fromPath`: a renamed file's old path (pairs the rename). */
export type GitTextSource =
  | {
      kind: 'fileDiff'
      filePath: string
      staged: boolean
      fromPath?: string
      opts?: GitDiffTextOpts
    }
  | {
      kind: 'rangeFileDiff'
      fromSha: string
      toSha: string
      filePath: string
      fromPath?: string
      opts?: GitDiffTextOpts
    }
  | { kind: 'untrackedDiff'; filePath: string }
  | { kind: 'stashDiff'; index: number }

/** One page of a text. `cursor` null = the last page; `totalBytes` = the whole text's UTF-8 size. */
export interface GitTextPage {
  text: string
  cursor: string | null
  totalBytes: number
}

/** Files of a working diff whose patches a paged snapshot left out. */
export interface GitDiffDeferred {
  /** Unstaged (or, in range mode, the range's) files, in git's order. */
  unstaged: string[]
  staged: string[]
  /** Old paths of renamed/copied files in the lists above (`new path → old path`). */
  renamedFrom: Record<string, string>
  /** Changes whenever any deferred file's content changes: refetch them. */
  fingerprint: string
}

/** One batch of per-file patches (`getFileDiffsPage`, paged `getUntrackedFileDiffs`). */
export interface GitFileDiffsPage {
  diffs: Record<string, string>
  /** Files not answered in this batch (over the budget): ask again with them. */
  deferred: string[]
  /** Files whose own patch is over the budget: read them with `readGitText`. */
  large: string[]
}

/** The flat `readGitText` input (as the git-op contract carries it) as a source. */
export function gitTextSourceOf(i: {
  kind: GitTextSource['kind']
  filePath?: string
  fromPath?: string
  staged?: boolean
  index?: number
  fromSha?: string
  toSha?: string
  opts?: GitDiffTextOpts
}): GitTextSource {
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`readGitText ${i.kind}: ${what} required`)
    return v
  }
  switch (i.kind) {
    case 'fileDiff':
      return {
        kind: 'fileDiff',
        filePath: need(i.filePath, 'filePath'),
        staged: i.staged === true,
        ...(i.fromPath ? { fromPath: i.fromPath } : {}),
        ...(i.opts ? { opts: i.opts } : {})
      }
    case 'rangeFileDiff':
      return {
        kind: 'rangeFileDiff',
        fromSha: need(i.fromSha, 'fromSha'),
        toSha: need(i.toSha, 'toSha'),
        filePath: need(i.filePath, 'filePath'),
        ...(i.fromPath ? { fromPath: i.fromPath } : {}),
        ...(i.opts ? { opts: i.opts } : {})
      }
    case 'untrackedDiff':
      return { kind: 'untrackedDiff', filePath: need(i.filePath, 'filePath') }
    case 'stashDiff':
      return { kind: 'stashDiff', index: need(i.index, 'index') }
  }
}
