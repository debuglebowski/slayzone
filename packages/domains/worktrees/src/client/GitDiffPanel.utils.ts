import type { FileDiff as FileDiffType } from './parse-diff'
import type { FileEntry } from './GitDiffPanel.types'

export function deriveStatus(path: string, diffs: FileDiffType[]): 'M' | 'A' | 'D' {
  const diff = diffs.find((d) => d.path === path)
  if (diff?.isNew) return 'A'
  if (diff?.isDeleted) return 'D'
  return 'M'
}

// Honest display: ingestion now stores '' for prompts it can't reliably
// capture (raw PTY stdin). Legacy rows written before that policy may contain
// control chars or CSI-debris like `[I [O [A` — treat them as empty too so
// users never see garbled text.
export function cleanPromptForDisplay(raw: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]/.test(raw)) return ''
  // CSI debris left after upstream stripped ESC:
  //   `[I`/`[O`, `[A-D`, `[H`/`[F` — focus/arrow/home/end
  //   `[<digits>~`                 — bracketed paste, function keys, PgUp/PgDn
  //   `[<digits>;<digits><letter>` — cursor position with modifiers
  //   `[<digits><letter>`          — CUU/CUD/CUF/CUB with count
  if (/\[[IOABCDHF](?![A-Za-z])/.test(raw)) return ''
  if (/\[\d+[;~A-Za-z]/.test(raw)) return ''
  return raw
}

export const STATUS_COLORS: Record<FileEntry['status'], string> = {
  M: 'text-yellow-600 dark:text-yellow-400',
  A: 'text-green-600 dark:text-green-400',
  D: 'text-red-600 dark:text-red-400',
  '?': 'text-muted-foreground'
}

export const getEntryPath = (entry: FileEntry) => entry.path

// Fix 6 — Huge files stall continuous-flow because DiffView's line-level
// virtualizer falls back to plain rendering when nested inside the outer row
// virtualizer (see findScrollParent in DiffView.tsx). Threading an outer scroll
// parent into the inner virtualizer requires reworking DiffView's scroll-parent
// discovery + scrollMargin handling for nested virtualizers — a future
// improvement. For now, auto-collapse huge files on first sight so the user
// pays the render cost only when they opt in by expanding.
export const HUGE_FILE_THRESHOLD = 1000
