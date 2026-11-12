import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { claudeTranscriptPath } from '@slayzone/terminal/claude-transcripts'
import { ptyHistoryDir } from '../pty-history'
import {
  createSessionMoveFiles,
  sessionMoveFileRefSchema,
  type SessionMoveFileEntry,
  type SessionMoveFiles
} from './session-move-files'

const TASK = 'task-1'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const SCROLLBACK = `${'a'.repeat(40)}.txt`

let root: string
let savedConfigDir: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slz-move-files-'))
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
})
afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  rmSync(root, { recursive: true, force: true })
})

/** One computer's side of one hub: its own state dir, project folders and ledger. */
function side(name: string, opts: { folder?: string | null; sessions?: string[] } = {}) {
  const stateDir = join(root, `${name}-state`)
  const folder = opts.folder === undefined ? join(root, `${name}-project`) : opts.folder
  if (folder) mkdirSync(folder, { recursive: true })
  const files = createSessionMoveFiles({
    stateDir,
    hubScope: `hub-${name}`,
    projectFolder: () => folder,
    sessionIds: () => opts.sessions ?? []
  })
  return {
    files,
    stateDir,
    folder,
    scrollbackDir: join(ptyHistoryDir(stateDir, `hub-${name}`), TASK)
  }
}
type Side = ReturnType<typeof side>

function putTranscript(folder: string, sessionId: string, text: string) {
  const path = claudeTranscriptPath(folder, sessionId)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
function putScrollback(s: Side, text: string) {
  mkdirSync(s.scrollbackDir, { recursive: true })
  writeFileSync(join(s.scrollbackDir, SCROLLBACK), text)
}

/** What the app does: ask what the target lacks, read it in chunks, write it. */
async function copy(from: Side, to: Side, chunk = 7) {
  const listed = await from.files.list(TASK, 'p')
  const missing = to.files.missing(TASK, 'p', listed)
  for (const file of missing) {
    let offset = file.offset
    for (;;) {
      const part = await from.files.read(TASK, 'p', file.ref, offset, chunk)
      to.files.write({
        taskId: TASK,
        projectId: 'p',
        ref: file.ref,
        offset,
        data: part.data,
        ...(part.eof ? { complete: { size: file.size, hash: file.hash } } : {})
      })
      offset += Buffer.from(part.data, 'base64').length
      if (part.eof) break
    }
  }
  return { listed, missing }
}
const transcriptRef = (sessionId: string) => ({ kind: 'claude-transcript' as const, sessionId })

describe('a moved task’s session files', () => {
  test('a transcript goes under the target’s project folder, the scrollback keeps its name', async () => {
    const A = side('a', { sessions: ['sess-1'] })
    const B = side('b')
    const transcript = '{"type":"user"}\n{"type":"assistant"}\n'
    putTranscript(A.folder!, 'sess-1', transcript)
    putScrollback(A, 'terminal output\r\n')

    const { listed } = await copy(A, B)
    expect(listed.map((f) => f.ref)).toEqual([
      { kind: 'pty-history', name: SCROLLBACK },
      transcriptRef('sess-1')
    ])
    expect(readFileSync(claudeTranscriptPath(B.folder!, 'sess-1'), 'utf8')).toBe(transcript)
    expect(readFileSync(join(B.scrollbackDir, SCROLLBACK), 'utf8')).toBe('terminal output\r\n')
  })

  test('a transcript is found where the CLI left it, not only under the task’s folder', async () => {
    const A = side('a', { sessions: ['sess-1'] })
    const elsewhere = join(root, 'a-worktree')
    putTranscript(elsewhere, 'sess-1', 'moved folders\n')
    const listed = await A.files.list(TASK, 'p')
    expect(listed).toEqual([
      { ref: transcriptRef('sess-1'), size: 14, hash: sha('moved folders\n') }
    ])
  })

  test('only sessions the task’s ledger names are read', async () => {
    const A = side('a', { sessions: ['mine'] })
    putTranscript(A.folder!, 'mine', 'm\n')
    putTranscript(A.folder!, 'someone-elses', 's\n')
    expect((await A.files.list(TASK, 'p')).map((f) => f.ref)).toEqual([transcriptRef('mine')])
  })

  test('what the target already holds is not asked for again; a staged copy resumes', async () => {
    const A = side('a', { sessions: ['sess-1'] })
    const B = side('b')
    putTranscript(A.folder!, 'sess-1', '0123456789')
    const [entry] = await A.files.list(TASK, 'p')
    // The first chunk landed, then the app quit.
    const first = await A.files.read(TASK, 'p', entry.ref, 0, 4)
    B.files.write({ taskId: TASK, projectId: 'p', ref: entry.ref, offset: 0, data: first.data })
    expect(B.files.missing(TASK, 'p', [entry])).toEqual([{ ...entry, offset: 4 }])

    await copy(A, B)
    expect(B.files.readPlaced(TASK, 'p', entry.ref)).toBe('0123456789')
    expect(B.files.missing(TASK, 'p', [entry])).toEqual([])
  })

  test('a copy that does not match its hash is refused and leaves nothing behind', async () => {
    const A = side('a', { sessions: ['sess-1'] })
    const B = side('b')
    putTranscript(A.folder!, 'sess-1', 'abcdef')
    const [entry] = await A.files.list(TASK, 'p')
    const all = await A.files.read(TASK, 'p', entry.ref, 0, 100)
    expect(() =>
      B.files.write({
        taskId: TASK,
        projectId: 'p',
        ref: entry.ref,
        offset: 0,
        data: Buffer.from('tampered').toString('base64'),
        complete: { size: entry.size, hash: entry.hash }
      })
    ).toThrow(/hash|match/)
    expect(all.eof).toBe(true)
    expect(B.files.readPlaced(TASK, 'p', entry.ref)).toBeNull()
    expect(B.files.missing(TASK, 'p', [entry])).toEqual([{ ...entry, offset: 0 }])
  })

  test('a task coming back: the grown transcript replaces the old one, a diverged one stays', async () => {
    const A = side('a', { sessions: ['sess-1', 'sess-2'] })
    const B = side('b', { sessions: ['sess-1', 'sess-2'] })
    // Hub A holds what the task had when it left.
    putTranscript(A.folder!, 'sess-1', 'line 1\n')
    putTranscript(A.folder!, 'sess-2', 'A wrote this\n')
    putScrollback(A, 'old scrollback')
    // On B both grew; sess-2 also differs from the start.
    putTranscript(B.folder!, 'sess-1', 'line 1\nline 2 on B\n')
    putTranscript(B.folder!, 'sess-2', 'B wrote this\n')
    putScrollback(B, 'old scrollback and more')

    await copy(B, A)
    expect(readFileSync(claudeTranscriptPath(A.folder!, 'sess-1'), 'utf8')).toBe(
      'line 1\nline 2 on B\n'
    )
    // Neither is the start of the other: the copy already there is kept.
    expect(readFileSync(claudeTranscriptPath(A.folder!, 'sess-2'), 'utf8')).toBe('A wrote this\n')
    // The scrollback arriving is the task's latest.
    expect(readFileSync(join(A.scrollbackDir, SCROLLBACK), 'utf8')).toBe('old scrollback and more')
  })

  test('with no project folder on the target, transcripts are not asked for but scrollback is', async () => {
    const A = side('a', { sessions: ['sess-1'] })
    const B = side('b', { folder: null })
    putTranscript(A.folder!, 'sess-1', 'x\n')
    putScrollback(A, 'out')
    const { missing } = await copy(A, B)
    expect(missing.map((f) => f.ref)).toEqual([{ kind: 'pty-history', name: SCROLLBACK }])
  })

  test('a canceled move’s staged copies are dropped', async () => {
    const A = side('a', { sessions: ['sess-1'] })
    const B = side('b')
    putTranscript(A.folder!, 'sess-1', 'abcdef')
    const [entry] = await A.files.list(TASK, 'p')
    const part = await A.files.read(TASK, 'p', entry.ref, 0, 3)
    B.files.write({ taskId: TASK, projectId: 'p', ref: entry.ref, offset: 0, data: part.data })
    B.files.discardStaging(TASK, 'p', [entry.ref])
    expect(B.files.missing(TASK, 'p', [entry])).toEqual([{ ...entry, offset: 0 }])
  })

  test('references that could leave the folders are refused', () => {
    expect(
      sessionMoveFileRefSchema.safeParse({ kind: 'claude-transcript', sessionId: '../x' }).success
    ).toBe(false)
    expect(
      sessionMoveFileRefSchema.safeParse({ kind: 'claude-transcript', sessionId: 'a/b' }).success
    ).toBe(false)
    expect(
      sessionMoveFileRefSchema.safeParse({ kind: 'pty-history', name: '../../x.txt' }).success
    ).toBe(false)
    expect(
      sessionMoveFileRefSchema.safeParse({ kind: 'pty-history', name: 'abc.txt' }).success
    ).toBe(false)
    expect(
      sessionMoveFileRefSchema.safeParse({ kind: 'claude-transcript', sessionId: 'a1b2-c3' })
        .success
    ).toBe(true)
  })

  test('a task id that could leave the scrollback folder is refused', async () => {
    const A = side('a')
    await expect(A.files.list('../escape', 'p')).rejects.toThrow(/Invalid task id/)
  })
})

// Keep the type exports used: the entry shape is what the app relays.
export type { SessionMoveFileEntry, SessionMoveFiles }
