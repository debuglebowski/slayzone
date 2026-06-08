import { existsSync, createReadStream } from 'fs'
import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'

/**
 * Read-only access to Claude Code's on-disk transcripts (`~/.claude/projects/
 * <encoded-cwd>/<conversationId>.jsonl`). Used by the conversation self-heal to
 * (a) check whether a stored id's transcript still exists and (b) find an
 * orphaned transcript to reconnect a phantom-pointed task to. Pure filesystem —
 * no task-domain dependency (the package graph runs task → terminal).
 *
 * See plans/conv-id-robustness-v2.md.
 */

/** Encode a cwd to Claude Code's transcript project-dir name: every
 *  non-alphanumeric char → '-' (NO collapsing of runs). Verified against real
 *  `~/.claude/projects` dir names, e.g.
 *    /Users/Kalle/dev/projects/slayzone        → -Users-Kalle-dev-projects-slayzone
 *    /Users/Kalle/.superset/worktrees/babel    → -Users-Kalle--superset-worktrees-babel
 *    /private/tmp/claudecap2_q_f50ypm          → -private-tmp-claudecap2-q-f50ypm */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function claudeProjectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', encodeClaudeProjectDir(cwd))
}

export function claudeTranscriptPath(cwd: string, conversationId: string): string {
  return join(claudeProjectDir(cwd), `${conversationId}.jsonl`)
}

/** Does the transcript for `conversationId` exist in `cwd`'s project dir? */
export function claudeTranscriptExists(cwd: string, conversationId: string): boolean {
  return existsSync(claudeTranscriptPath(cwd, conversationId))
}

export interface ClaudeTranscriptMeta {
  /** `cwd` recorded inside the transcript (lossless; compared string-exact). */
  cwd: string | null
  /** Epoch-ms of the first timestamped record, or null if none found. */
  firstTsMs: number | null
  /** `gitBranch` recorded inside the transcript, or null if absent. */
  gitBranch: string | null
  /** Has ≥1 real (non-sidechain) human user turn with text content. */
  hasHumanTurn: boolean
}

interface TranscriptRecord {
  cwd?: unknown
  gitBranch?: unknown
  timestamp?: unknown
  type?: unknown
  isSidechain?: unknown
  message?: { content?: unknown }
}

/** A `user` record is a genuine human turn (not a synthetic tool_result or a
 *  sub-agent sidechain prompt) when its message content is non-empty text. */
function isHumanUserRecord(rec: TranscriptRecord): boolean {
  if (rec.type !== 'user' || rec.isSidechain === true) return false
  const content = rec.message?.content
  if (typeof content === 'string') return content.trim().length > 0
  if (Array.isArray(content)) {
    return content.some(
      (p) =>
        p &&
        typeof p === 'object' &&
        (p as { type?: unknown }).type === 'text' &&
        typeof (p as { text?: unknown }).text === 'string' &&
        ((p as { text: string }).text).trim().length > 0
    )
  }
  return false
}

/**
 * Stream the head of a transcript to extract identity metadata. Modern transcripts
 * open with non-session lines (`last-prompt`, `mode`, `permission-mode`, …) that
 * carry none of these fields, and the order varies — so we scan line-by-line
 * (NOT a fixed-size head read) until everything is found or `maxLines` is hit.
 */
export async function readClaudeTranscriptMeta(
  filePath: string,
  maxLines = 200
): Promise<ClaudeTranscriptMeta> {
  const meta: ClaudeTranscriptMeta = {
    cwd: null,
    firstTsMs: null,
    gitBranch: null,
    hasHumanTurn: false
  }
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  try {
    let count = 0
    for await (const line of rl) {
      if (++count > maxLines) break
      const trimmed = line.trim()
      if (!trimmed) continue
      let rec: TranscriptRecord
      try {
        rec = JSON.parse(trimmed) as TranscriptRecord
      } catch {
        continue
      }
      if (meta.cwd == null && typeof rec.cwd === 'string') meta.cwd = rec.cwd
      if (meta.gitBranch == null && typeof rec.gitBranch === 'string') meta.gitBranch = rec.gitBranch
      if (meta.firstTsMs == null && typeof rec.timestamp === 'string') {
        const t = Date.parse(rec.timestamp)
        if (!Number.isNaN(t)) meta.firstTsMs = t
      }
      if (!meta.hasHumanTurn && isHumanUserRecord(rec)) meta.hasHumanTurn = true
      if (meta.cwd && meta.firstTsMs != null && meta.gitBranch != null && meta.hasHumanTurn) break
    }
  } finally {
    rl.close()
  }
  return meta
}

/** List transcript conversation ids present in `cwd`'s project dir (empty if the
 *  dir doesn't exist). Returns ids only — caller reads metadata as needed. */
export async function listClaudeTranscriptIds(cwd: string): Promise<string[]> {
  const dir = claudeProjectDir(cwd)
  if (!existsSync(dir)) return []
  try {
    const entries = await readdir(dir)
    return entries.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length))
  } catch {
    return []
  }
}
