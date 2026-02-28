import type { WorktreeCopyEntry } from './types'

/** Maximum number of copy entries per project */
export const MAX_COPY_ENTRIES = 100

/** Settings key for project-id based copy-entry storage (stable) */
export function copyEntriesKey(projectId: string): string {
  return `worktree_copy_files:project:${projectId}`
}

/** Legacy settings key (path-based, fragile — breaks on repo path changes) */
export function legacyCopyEntriesKey(repoPath: string): string {
  return `worktree_copy_files:${repoPath}`
}

export interface CopyEntryValidationResult {
  entries: WorktreeCopyEntry[]
  skipped: Array<{ entry: unknown; reason: string }>
}

/**
 * Validate a single copy entry.
 * Checks: non-empty path, relative path, no traversal, valid mode.
 */
export function validateCopyEntry(
  item: unknown
): { ok: true; entry: WorktreeCopyEntry } | { ok: false; reason: string } {
  if (!item || typeof item !== 'object') {
    return { ok: false, reason: 'Entry must be an object' }
  }
  const obj = item as Record<string, unknown>

  if (typeof obj.path !== 'string' || !obj.path.trim()) {
    return { ok: false, reason: 'Path must be a non-empty string' }
  }

  const trimmed = obj.path.trim()

  // Reject absolute paths
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    return { ok: false, reason: `Absolute paths not allowed: ${trimmed}` }
  }

  // Reject traversal outside root
  const normalized = trimmed.replace(/\\/g, '/')
  if (normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') {
    return { ok: false, reason: `Path escapes repository root: ${trimmed}` }
  }

  if (obj.mode !== 'copy' && obj.mode !== 'symlink') {
    return { ok: false, reason: `Mode must be 'copy' or 'symlink', got: ${String(obj.mode)}` }
  }

  return { ok: true, entry: { path: trimmed, mode: obj.mode } }
}

/**
 * Parse and validate an array of copy entries from a raw JSON string.
 * Returns valid entries and any that were skipped with reasons.
 */
export function parseCopyEntries(raw: string | null | undefined): CopyEntryValidationResult {
  if (!raw) return { entries: [], skipped: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { entries: [], skipped: [{ entry: raw, reason: 'Invalid JSON' }] }
  }

  if (!Array.isArray(parsed)) {
    return { entries: [], skipped: [{ entry: parsed, reason: 'Expected an array' }] }
  }

  const entries: WorktreeCopyEntry[] = []
  const skipped: CopyEntryValidationResult['skipped'] = []

  for (const item of parsed.slice(0, MAX_COPY_ENTRIES)) {
    const result = validateCopyEntry(item)
    if (result.ok) {
      entries.push(result.entry)
    } else {
      skipped.push({ entry: item, reason: result.reason })
    }
  }

  if (parsed.length > MAX_COPY_ENTRIES) {
    skipped.push({
      entry: null,
      reason: `Exceeded maximum of ${MAX_COPY_ENTRIES} entries (${parsed.length} provided)`
    })
  }

  return { entries, skipped }
}
