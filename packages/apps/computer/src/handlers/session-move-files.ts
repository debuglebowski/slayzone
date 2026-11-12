/**
 * The files outside the chat store that a moved task's sessions leave on a computer
 * (cross-hub move, slice 4a-2): Claude Code's session transcripts and the task's
 * terminal scrollback. The chat itself and its ledger travel as transfers
 * (chat-runtime `session-moves`); these are plain files, copied the way a move copies
 * artifact files — a manifest, chunked reads on the source, staged chunked writes on
 * the target, a sha-256 over each file.
 *
 *  - A Claude transcript (`<CLAUDE_CONFIG_DIR>/projects/<encoded folder>/<id>.jsonl`)
 *    is found by its session id wherever the CLI left it, and written under the
 *    project folder the task has on the TARGET computer, so `claude --resume <id>`
 *    from there finds it. The transcript only grows: an older copy already there is
 *    replaced; a copy that is not a prefix of the incoming one is left alone.
 *  - Terminal scrollback (`<stateDir>/computer-runtime/pty-history/<hub>/<task>/*.txt`)
 *    is named by a hash of the terminal's session id, which a move keeps (task and
 *    tab ids stay), so each file keeps its name. The incoming copy is the task's
 *    latest: it replaces what an earlier stay left.
 *
 * Which session ids exist comes from the task's ledger (the runtime), so only
 * sessions this task knows are read. Nothing outside the CLI's own folder, this
 * hub's scrollback folder and the staging files beside the targets is touched.
 *
 * @module computer/handlers/session-move-files
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { claudeTranscriptPath, locateClaudeTranscript } from '@slayzone/terminal/claude-transcripts'
import { ptyHistoryDir } from '../pty-history'

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/
const SCROLLBACK_NAME = /^[a-f0-9]{40}\.txt$/

export const sessionMoveFileRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claude-transcript'), sessionId: z.string().regex(SAFE_SESSION_ID) }),
  z.object({ kind: z.literal('pty-history'), name: z.string().regex(SCROLLBACK_NAME) })
])
export type SessionMoveFileRef = z.infer<typeof sessionMoveFileRefSchema>

export interface SessionMoveFileEntry {
  ref: SessionMoveFileRef
  size: number
  hash: string
}

const sha256File = (path: string): string => {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let n: number
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** Whether the file at `prefix` is the start of the file at `whole`. */
function isPrefixOf(prefix: string, whole: string): boolean {
  const size = statSync(prefix).size
  if (size > statSync(whole).size) return false
  const a = openSync(prefix, 'r')
  const b = openSync(whole, 'r')
  try {
    const x = Buffer.allocUnsafe(1024 * 1024)
    const y = Buffer.allocUnsafe(1024 * 1024)
    let at = 0
    while (at < size) {
      const n = readSync(a, x, 0, Math.min(x.length, size - at), at)
      const m = readSync(b, y, 0, n, at)
      if (n === 0 || m !== n || !x.subarray(0, n).equals(y.subarray(0, n))) return false
      at += n
    }
    return true
  } finally {
    closeSync(a)
    closeSync(b)
  }
}

export function createSessionMoveFiles(opts: {
  stateDir: string
  hubScope: string
  /** The folder this computer keeps `projectId` in, or null. */
  projectFolder(projectId: string): string | null
  /** The Claude session ids the task's ledger knows. */
  sessionIds(taskId: string): string[]
}) {
  const historyDir = ptyHistoryDir(opts.stateDir, opts.hubScope)
  const scrollbackDir = (taskId: string): string => {
    if (!SAFE_TASK_ID.test(taskId)) throw new Error('Invalid task id')
    return join(historyDir, taskId)
  }

  /** Where `ref` lives on THIS computer for reading (null = not here). */
  async function sourcePath(
    taskId: string,
    projectId: string,
    ref: SessionMoveFileRef
  ): Promise<string | null> {
    if (ref.kind === 'pty-history') {
      const path = join(scrollbackDir(taskId), ref.name)
      return existsSync(path) ? path : null
    }
    const found = await locateClaudeTranscript(ref.sessionId, opts.projectFolder(projectId) ?? '')
    return found?.path ?? null
  }

  /** Where `ref` goes on THIS computer (null = no place for it here). */
  function targetPath(taskId: string, projectId: string, ref: SessionMoveFileRef): string | null {
    if (ref.kind === 'pty-history') return join(scrollbackDir(taskId), ref.name)
    const folder = opts.projectFolder(projectId)
    return folder ? claudeTranscriptPath(folder, ref.sessionId) : null
  }

  const stagingOf = (target: string): string => `${target}.slz-move.tmp`

  return {
    /** Everything of the task's sessions that is a file here. */
    async list(taskId: string, projectId: string): Promise<SessionMoveFileEntry[]> {
      const entries: SessionMoveFileEntry[] = []
      const dir = scrollbackDir(taskId)
      if (existsSync(dir))
        for (const name of readdirSync(dir).sort()) {
          if (!SCROLLBACK_NAME.test(name)) continue
          const path = join(dir, name)
          entries.push({
            ref: { kind: 'pty-history', name },
            size: statSync(path).size,
            hash: sha256File(path)
          })
        }
      for (const sessionId of [...new Set(opts.sessionIds(taskId))].sort()) {
        if (!SAFE_SESSION_ID.test(sessionId)) continue
        const path = await sourcePath(taskId, projectId, { kind: 'claude-transcript', sessionId })
        if (!path) continue
        entries.push({
          ref: { kind: 'claude-transcript', sessionId },
          size: statSync(path).size,
          hash: sha256File(path)
        })
      }
      return entries
    },

    /** Bytes `[offset, offset + length)` of a file, base64, and whether it ends there. */
    async read(
      taskId: string,
      projectId: string,
      ref: SessionMoveFileRef,
      offset: number,
      length: number
    ): Promise<{ data: string; eof: boolean }> {
      const path = await sourcePath(taskId, projectId, ref)
      if (!path) throw new Error('That session file is not on this computer')
      const size = statSync(path).size
      const buffer = Buffer.allocUnsafe(Math.max(0, Math.min(length, size - offset)))
      const fd = openSync(path, 'r')
      try {
        let read = 0
        while (read < buffer.length) {
          const n = readSync(fd, buffer, read, buffer.length - read, offset + read)
          if (n === 0) break
          read += n
        }
        return {
          data: buffer.subarray(0, read).toString('base64'),
          eof: offset + read >= size
        }
      } finally {
        closeSync(fd)
      }
    },

    /**
     * Of `entries`, the ones this computer lacks (or holds a different copy of) and
     * where its staged copy stands. A file with no place here (a transcript when the
     * task's project has no folder on this computer) is not asked for.
     */
    missing(
      taskId: string,
      projectId: string,
      entries: SessionMoveFileEntry[]
    ): Array<SessionMoveFileEntry & { offset: number }> {
      const out: Array<SessionMoveFileEntry & { offset: number }> = []
      for (const entry of entries) {
        const target = targetPath(taskId, projectId, entry.ref)
        if (!target) continue
        if (
          existsSync(target) &&
          statSync(target).size === entry.size &&
          sha256File(target) === entry.hash
        )
          continue
        const staging = stagingOf(target)
        const offset = existsSync(staging) ? Math.min(statSync(staging).size, entry.size) : 0
        out.push({ ...entry, offset })
      }
      return out
    },

    /** A chunk at `offset`; the last one (`complete`) checks the whole and puts it in place. */
    write(input: {
      taskId: string
      projectId: string
      ref: SessionMoveFileRef
      offset: number
      data: string
      complete?: { size: number; hash: string }
    }): { placed: boolean } {
      const target = targetPath(input.taskId, input.projectId, input.ref)
      if (!target) throw new Error('This computer has no place for that session file')
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      const staging = stagingOf(target)
      const have = existsSync(staging) ? statSync(staging).size : 0
      if (input.offset > have) throw new Error(`Chunk at ${input.offset}, staged ${have}`)
      if (input.offset < have) truncateSync(staging, input.offset)
      const fd = openSync(staging, 'a', 0o600)
      try {
        writeSync(fd, Buffer.from(input.data, 'base64'))
      } finally {
        closeSync(fd)
      }
      if (!input.complete) return { placed: false }
      if (
        statSync(staging).size !== input.complete.size ||
        sha256File(staging) !== input.complete.hash
      ) {
        rmSync(staging, { force: true })
        throw new Error('The copied session file does not match its hash')
      }
      // A transcript only grows: replace an older copy; leave one that is not the start
      // of this (the two diverged — which is right is not ours to say).
      if (
        input.ref.kind === 'claude-transcript' &&
        existsSync(target) &&
        !isPrefixOf(target, staging)
      ) {
        rmSync(staging, { force: true })
        return { placed: false }
      }
      renameSync(staging, target)
      return { placed: true }
    },

    /** Drop staged copies of files a move will not finish (canceled). */
    discardStaging(taskId: string, projectId: string, refs: SessionMoveFileRef[]): void {
      for (const ref of refs) {
        const target = targetPath(taskId, projectId, ref)
        if (target) rmSync(stagingOf(target), { force: true })
      }
    },

    /** For tests and diagnostics: the text of a file in place. */
    readPlaced(taskId: string, projectId: string, ref: SessionMoveFileRef): string | null {
      const target = targetPath(taskId, projectId, ref)
      return target && existsSync(target) ? readFileSync(target, 'utf8') : null
    }
  }
}

export type SessionMoveFiles = ReturnType<typeof createSessionMoveFiles>
