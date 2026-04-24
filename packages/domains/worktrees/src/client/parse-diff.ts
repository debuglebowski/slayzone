export interface InlineHighlight {
  start: number
  end: number
}

export interface DiffLine {
  type: 'add' | 'delete' | 'context'
  content: string
  oldLineNo: number | null
  newLineNo: number | null
  highlights?: InlineHighlight[]
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLen: number
  newStart: number
  newLen: number
  label: string
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  oldPath: string | null
  hunks: DiffHunk[]
  isBinary: boolean
  isNew: boolean
  isDeleted: boolean
  additions: number
  deletions: number
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function computeInlineHighlights(
  oldContent: string,
  newContent: string
): { oldHighlights: InlineHighlight[]; newHighlights: InlineHighlight[] } {
  const empty = { oldHighlights: [], newHighlights: [] }

  // Skip if lines are too different (less than 30% common)
  const maxLen = Math.max(oldContent.length, newContent.length)
  if (maxLen === 0) return empty

  // Find common prefix
  let prefixLen = 0
  const minLen = Math.min(oldContent.length, newContent.length)
  while (prefixLen < minLen && oldContent[prefixLen] === newContent[prefixLen]) {
    prefixLen++
  }

  // Find common suffix (not overlapping prefix)
  let suffixLen = 0
  while (
    suffixLen < minLen - prefixLen &&
    oldContent[oldContent.length - 1 - suffixLen] === newContent[newContent.length - 1 - suffixLen]
  ) {
    suffixLen++
  }

  const commonLen = prefixLen + suffixLen
  // If less than 30% is common, don't highlight — lines are too different
  if (commonLen < maxLen * 0.3) return empty
  // If everything is common (identical lines), nothing to highlight
  if (commonLen >= maxLen) return empty

  const oldStart = prefixLen
  const oldEnd = oldContent.length - suffixLen
  const newStart = prefixLen
  const newEnd = newContent.length - suffixLen

  return {
    oldHighlights: oldEnd > oldStart ? [{ start: oldStart, end: oldEnd }] : [],
    newHighlights: newEnd > newStart ? [{ start: newStart, end: newEnd }] : []
  }
}

// WeakMap-backed marker. Keying off the FileDiff identity avoids mutating
// cached parse-result objects, so the parse cache stays a pure value cache.
// Garbage-collected automatically when the FileDiff falls out of cache.
const highlightsAppliedMark = new WeakSet<FileDiff>()

/**
 * Compute inline char-level highlights for paired add/delete lines in the
 * given FileDiff. Idempotent via a module-level WeakSet — first call computes,
 * later calls are no-ops. Called lazily by `DiffView` just before a file
 * renders so offscreen files in large patches never pay the cost.
 */
export function ensureInlineHighlights(fileDiff: FileDiff): void {
  if (highlightsAppliedMark.has(fileDiff)) return
  applyInlineHighlights(fileDiff.hunks)
  highlightsAppliedMark.add(fileDiff)
}

function applyInlineHighlights(hunks: DiffHunk[]): void {
  for (const hunk of hunks) {
    const lines = hunk.lines
    let i = 0
    while (i < lines.length) {
      // Find a block of consecutive deletes followed by consecutive adds
      const delStart = i
      while (i < lines.length && lines[i].type === 'delete') i++
      const delEnd = i
      const addStart = i
      while (i < lines.length && lines[i].type === 'add') i++
      const addEnd = i

      const delCount = delEnd - delStart
      const addCount = addEnd - addStart

      // Pair up to min(del, add) lines for highlighting
      if (delCount > 0 && addCount > 0) {
        const pairCount = Math.min(delCount, addCount)
        for (let j = 0; j < pairCount; j++) {
          const { oldHighlights, newHighlights } = computeInlineHighlights(
            lines[delStart + j].content,
            lines[addStart + j].content
          )
          lines[delStart + j].highlights = oldHighlights.length > 0 ? oldHighlights : undefined
          lines[addStart + j].highlights = newHighlights.length > 0 ? newHighlights : undefined
        }
      }

      // Skip context lines
      if (i === delStart) i++
    }
  }
}

function parseUnifiedDiffImpl(patch: string): FileDiff[] {
  if (!patch.trim()) return []

  const files: FileDiff[] = []
  // Split into per-file chunks
  const chunks = patch.split(/\n(?=diff --git )/)

  for (const chunk of chunks) {
    if (!chunk.startsWith('diff --git ')) continue

    const lines = chunk.split('\n')
    const headerMatch = lines[0].match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (!headerMatch) continue

    const oldPath = headerMatch[1]
    const newPath = headerMatch[2]

    const fileDiff: FileDiff = {
      path: newPath,
      oldPath: oldPath !== newPath ? oldPath : null,
      hunks: [],
      isBinary: false,
      isNew: false,
      isDeleted: false,
      additions: 0,
      deletions: 0
    }

    let i = 1
    // Parse file header lines (before hunks)
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const line = lines[i]
      if (line.startsWith('new file mode')) fileDiff.isNew = true
      else if (line.startsWith('deleted file mode')) fileDiff.isDeleted = true
      else if (line.startsWith('Binary files')) {
        fileDiff.isBinary = true
        break
      }
      i++
    }

    if (fileDiff.isBinary) {
      files.push(fileDiff)
      continue
    }

    // Parse hunks
    while (i < lines.length) {
      const hunkMatch = lines[i].match(HUNK_HEADER)
      if (!hunkMatch) {
        i++
        continue
      }

      const hunk: DiffHunk = {
        header: lines[i],
        oldStart: parseInt(hunkMatch[1], 10),
        oldLen: hunkMatch[2] != null ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newLen: hunkMatch[4] != null ? parseInt(hunkMatch[4], 10) : 1,
        label: (hunkMatch[5] ?? '').trim(),
        lines: []
      }

      let oldLine = hunk.oldStart
      let newLine = hunk.newStart
      i++

      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
        const raw = lines[i]
        if (raw.startsWith('+')) {
          hunk.lines.push({ type: 'add', content: raw.slice(1), oldLineNo: null, newLineNo: newLine++ })
          fileDiff.additions++
        } else if (raw.startsWith('-')) {
          hunk.lines.push({ type: 'delete', content: raw.slice(1), oldLineNo: oldLine++, newLineNo: null })
          fileDiff.deletions++
        } else if (raw.startsWith(' ')) {
          hunk.lines.push({ type: 'context', content: raw.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ })
        } else if (raw.startsWith('\\')) {
          // "\ No newline at end of file" — skip
        }
        i++
      }

      fileDiff.hunks.push(hunk)
    }

    // Inline highlights are now applied lazily via `ensureInlineHighlights`,
    // called from DiffView just before a file renders. Parsing a 200-file
    // patch no longer walks every hunk to pair up adds/deletes up front.
    files.push(fileDiff)
  }

  return files
}

// ── Global LRU parse cache ───────────────────────────────────────────
// Patches are immutable-by-string, so keying on the raw patch text is safe.
// A single Map doubles as our LRU: delete-then-set on hit promotes the key
// to most-recently-used; eviction drops the oldest (first-inserted) entry.
// Shared across every GitDiffPanel instance + stash + untracked-file paths.
// Count cap bounds small-patch churn; byte cap bounds megabyte-sized patches.
const MAX_ENTRIES = 64
// 8 MB total across resolved entries — prevents unbounded growth from a few huge diffs.
const MAX_BYTES = 8 * 1024 * 1024

type ParseCacheEntry = { value: FileDiff[]; bytes: number }
const parseCache = new Map<string, ParseCacheEntry>()
let parseCacheBytes = 0

// Heuristic: patch string is the dominant input; parsed result roughly scales
// with it. `len * 4` approximates UTF-16 key (len*2) + proportional value cost.
function estimatePatchBytes(patch: string): number {
  return patch.length * 4
}

function evictParseCache(): void {
  // Evict oldest-inserted entries until both caps satisfied.
  while (parseCache.size > MAX_ENTRIES || parseCacheBytes > MAX_BYTES) {
    const iter = parseCache.keys().next()
    if (iter.done) break
    const oldestKey = iter.value
    const oldest = parseCache.get(oldestKey)
    if (oldest === undefined) break
    parseCache.delete(oldestKey)
    parseCacheBytes -= oldest.bytes
    if (parseCacheBytes < 0) parseCacheBytes = 0
  }
}

export function parseUnifiedDiff(patch: string): FileDiff[] {
  const cached = parseCache.get(patch)
  if (cached !== undefined) {
    // Promote to MRU — byte total unchanged (same entry, same size).
    parseCache.delete(patch)
    parseCache.set(patch, cached)
    return cached.value
  }
  const parsed = parseUnifiedDiffImpl(patch)
  const bytes = estimatePatchBytes(patch)
  parseCache.set(patch, { value: parsed, bytes })
  parseCacheBytes += bytes
  evictParseCache()
  return parsed
}

/** Test/diagnostic hook. Clears the module-level LRU cache. */
export function _clearParseDiffCache(): void {
  parseCache.clear()
  parseCacheBytes = 0
}
