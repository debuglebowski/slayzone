import { existsSync, createReadStream, readFileSync, realpathSync } from 'fs'
import { open, readdir, stat } from 'fs/promises'
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

/**
 * Where Claude Code keeps its state: `CLAUDE_CONFIG_DIR` when set (the CLI reads
 * it), else `~/.claude`. Read per call — tests and the e2e harness set it.
 */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function claudeProjectDir(cwd: string): string {
  return join(claudeConfigDir(), 'projects', encodeClaudeProjectDir(cwd))
}

export function claudeTranscriptPath(cwd: string, conversationId: string): string {
  return join(claudeProjectDir(cwd), `${conversationId}.jsonl`)
}

/** Claude Code's default `cleanupPeriodDays`. */
const DEFAULT_CLEANUP_PERIOD_DAYS = 30

/**
 * How long Claude Code keeps a transcript before pruning it (`cleanupPeriodDays`
 * in `~/.claude/settings.json`, default 30), in ms. Read per call — the user can
 * edit it at any time. An unreadable/absent file means the default; a present
 * but non-numeric value means unknown (null), so callers stay conservative.
 */
export function claudeTranscriptRetentionMs(): number | null {
  let days: unknown = DEFAULT_CLEANUP_PERIOD_DAYS
  try {
    const settings = JSON.parse(readFileSync(join(claudeConfigDir(), 'settings.json'), 'utf8'))
    if (settings && typeof settings === 'object' && 'cleanupPeriodDays' in settings) {
      days = settings.cleanupPeriodDays
    }
  } catch {
    // no/invalid settings file → Claude uses its default too
  }
  return typeof days === 'number' && Number.isFinite(days) ? days * 24 * 60 * 60 * 1000 : null
}

/** Does the transcript for `conversationId` exist in `cwd`'s project dir? */
export function claudeTranscriptExists(cwd: string, conversationId: string): boolean {
  return existsSync(claudeTranscriptPath(cwd, conversationId))
}

/** Where a session's transcript is, and where `claude --resume` should start. */
export interface ClaudeTranscriptLocation {
  /** Absolute path of `<id>.jsonl`. */
  path: string
  /**
   * The folder the session last worked in, when it is NOT the folder the caller
   * asked about: a session that used EnterWorktree keeps its transcript only under
   * the worktree's project dir. Set only when that folder exists, passes
   * `isAllowedDir`, and is the folder whose project dir holds the file (so the
   * CLI started there finds it in its own project dir). Null = resume in the
   * folder asked about (the file is there, or no recorded folder qualifies; the
   * CLI then finds a cross-project session by id itself).
   */
  resumeCwd: string | null
}

export interface LocateClaudeTranscriptOptions {
  /** A computer's path jail. Absent = every folder allowed. */
  isAllowedDir?: (dir: string) => boolean
}

/** A Claude session id is a uuid; anything that could leave the projects dir is refused. */
function isSafeSessionId(id: string): boolean {
  return id.length > 0 && !/[\\/]|\.\./.test(id)
}

/** The project dir names a folder maps to: its real path (what the CLI sees) and as given. */
function projectDirNamesFor(cwd: string): string[] {
  if (!cwd) return []
  const names = new Set<string>()
  try {
    names.add(encodeClaudeProjectDir(realpathSync(cwd)))
  } catch {
    // Folder gone: the CLI may still have recorded it as given.
  }
  names.add(encodeClaudeProjectDir(cwd))
  return [...names]
}

async function mtimeIfFile(path: string): Promise<number | null> {
  try {
    const s = await stat(path)
    return s.isFile() ? s.mtimeMs : null
  } catch {
    return null
  }
}

/** Last chunk size read when looking for the session's current folder. */
const TAIL_CHUNK_BYTES = 64 * 1024
/** Stop looking further back than this (a folder change writes records at once). */
const TAIL_MAX_BYTES = 4 * 1024 * 1024

/**
 * The folder the session last worked in: the newest `relocated.relocatedCwd` or
 * record `cwd`, read backwards from the end of the file in chunks.
 */
async function readLastRecordedCwd(path: string): Promise<string | null> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    let end = size
    let carry = ''
    while (end > 0 && size - end < TAIL_MAX_BYTES) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES)
      const buf = Buffer.alloc(end - start)
      await fh.read(buf, 0, buf.length, start)
      const text = buf.toString('utf8') + carry
      const lines = text.split('\n')
      // The first piece may be a partial line: keep it for the next chunk.
      carry = start > 0 ? (lines.shift() ?? '') : ''
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line) continue
        try {
          const rec = JSON.parse(line) as { relocatedCwd?: unknown; cwd?: unknown }
          if (typeof rec.relocatedCwd === 'string' && rec.relocatedCwd) return rec.relocatedCwd
          if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd
        } catch {
          // A line the CLI is still writing.
        }
      }
      end = start
    }
    return null
  } finally {
    await fh.close()
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Find the transcript for `sessionId` on this machine, wherever the session's
 * folder moved to. Looks in `hintCwd`'s project dir first (the common case), then
 * in every project dir. Only the exact `<id>.jsonl` counts — a
 * `.jsonl.superseded-*` copy is not a live conversation. Several copies: the
 * newest wins. Null = no transcript anywhere.
 *
 * This is the one answer to "does this conversation exist, and where do I resume
 * it": the conversation healer, the stale-resume check, and every reader of a
 * session file use it, on the machine (computer) that owns the disk.
 */
export async function locateClaudeTranscript(
  sessionId: string,
  hintCwd: string,
  opts: LocateClaudeTranscriptOptions = {}
): Promise<ClaudeTranscriptLocation | null> {
  if (!isSafeSessionId(sessionId)) return null
  const projectsRoot = join(claudeConfigDir(), 'projects')
  const fileName = `${sessionId}.jsonl`

  for (const name of projectDirNamesFor(hintCwd)) {
    const path = join(projectsRoot, name, fileName)
    if ((await mtimeIfFile(path)) != null) return { path, resumeCwd: null }
  }

  let entries: string[]
  try {
    entries = await readdir(projectsRoot)
  } catch {
    return null
  }
  let best: { path: string; dirName: string; mtime: number } | null = null
  for (const dirName of entries) {
    const path = join(projectsRoot, dirName, fileName)
    const mtime = await mtimeIfFile(path)
    if (mtime != null && (!best || mtime > best.mtime)) best = { path, dirName, mtime }
  }
  if (!best) return null

  let recorded: string | null = null
  try {
    recorded = await readLastRecordedCwd(best.path)
  } catch {
    recorded = null
  }
  const qualifies =
    recorded != null &&
    recorded !== hintCwd &&
    (opts.isAllowedDir?.(recorded) ?? true) &&
    (await isDirectory(recorded)) &&
    projectDirNamesFor(recorded).includes(best.dirName)
  return { path: best.path, resumeCwd: qualifies ? recorded : null }
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
        (p as { text: string }).text.trim().length > 0
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
  const input = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input, crlfDelay: Infinity })
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
      if (meta.gitBranch == null && typeof rec.gitBranch === 'string')
        meta.gitBranch = rec.gitBranch
      if (meta.firstTsMs == null && typeof rec.timestamp === 'string') {
        const t = Date.parse(rec.timestamp)
        if (!Number.isNaN(t)) meta.firstTsMs = t
      }
      if (!meta.hasHumanTurn && isHumanUserRecord(rec)) meta.hasHumanTurn = true
      if (meta.cwd && meta.firstTsMs != null && meta.gitBranch != null && meta.hasHumanTurn) break
    }
  } finally {
    // rl.close() does NOT close `input`: on an early break the fd stays open. The
    // healer re-reads every transcript, so each pass leaked one fd per file until
    // the hub hit its fd limit and every spawn (git included) failed.
    rl.close()
    input.destroy()
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
