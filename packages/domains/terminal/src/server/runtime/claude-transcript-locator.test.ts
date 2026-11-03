import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { encodeClaudeProjectDir } from '../claude-transcripts'
import {
  locateClaudeTranscripts,
  setClaudeTranscriptLocator,
  type ClaudeTranscriptLocateRequest
} from './claude-transcript-locator'

const configDir = mkdtempSync(join(tmpdir(), 'ctl-config-'))
const work = realpathSync(mkdtempSync(join(tmpdir(), 'ctl-work-')))
const repo = join(work, 'repo')
const worktree = join(repo, '.claude', 'worktrees', 'wt1')
const prev = process.env.CLAUDE_CONFIG_DIR
const ID = '11111111-1111-4111-8111-111111111111'
const MISSING = '22222222-2222-4222-8222-222222222222'

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = configDir
  mkdirSync(worktree, { recursive: true })
  const dir = join(configDir, 'projects', encodeClaudeProjectDir(worktree))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${ID}.jsonl`),
    `${JSON.stringify({ type: 'relocated', relocatedCwd: worktree })}\n`
  )
})
afterAll(() => {
  if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prev
})
afterEach(() => setClaudeTranscriptLocator(null))

const req = (over: Partial<ClaudeTranscriptLocateRequest> = {}): ClaudeTranscriptLocateRequest => ({
  taskId: 't1',
  computerId: null,
  projectId: null,
  cwd: repo,
  sessionIds: [ID, MISSING],
  ...over
})

describe('locateClaudeTranscripts', () => {
  test('hub-local spawn: reads this disk, finds the moved session', async () => {
    const res = await locateClaudeTranscripts(req())
    expect(res?.get(ID)).toEqual({ found: true, resumeCwd: worktree })
    expect(res?.get(MISSING)).toEqual({ found: false, resumeCwd: null })
  })

  test('computer spawn: asks the wired locator (the computer owns the disk)', async () => {
    const seen: ClaudeTranscriptLocateRequest[] = []
    setClaudeTranscriptLocator(async (r) => {
      seen.push(r)
      return [{ sessionId: ID, found: true, resumeCwd: '/remote/wt' }]
    })
    const res = await locateClaudeTranscripts(req({ computerId: 'pc', projectId: 'p1' }))
    expect(seen).toEqual([req({ computerId: 'pc', projectId: 'p1' })])
    expect(res?.get(ID)).toEqual({ found: true, resumeCwd: '/remote/wt' })
    // An id the computer did not answer for is unknown, not missing.
    expect(res?.has(MISSING)).toBe(false)
  })

  test('computer spawn with no locator wired: unknown (never the hub disk)', async () => {
    expect(await locateClaudeTranscripts(req({ computerId: 'pc' }))).toBeNull()
  })

  test('locator fails (old computer, socket drop): unknown', async () => {
    setClaudeTranscriptLocator(async () => {
      throw new Error('method not found')
    })
    expect(await locateClaudeTranscripts(req({ computerId: 'pc' }))).toBeNull()
  })

  test('no ids: empty answer, no call', async () => {
    let called = false
    setClaudeTranscriptLocator(async () => {
      called = true
      return []
    })
    expect((await locateClaudeTranscripts(req({ computerId: 'pc', sessionIds: [] })))?.size).toBe(0)
    expect(called).toBe(false)
  })
})
