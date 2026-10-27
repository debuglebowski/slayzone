import { writeFileSync, mkdtempSync, mkdirSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  encodeClaudeProjectDir,
  readClaudeTranscriptMeta,
  claudeTranscriptRetentionMs
} from './claude-transcripts'

// ---- encodeClaudeProjectDir (verified against real ~/.claude/projects names) ----
describe('encodeClaudeProjectDir', () => {
  test('plain path encodes', () => {
    expect(encodeClaudeProjectDir('/Users/Kalle/dev/projects/slayzone')).toBe(
      '-Users-Kalle-dev-projects-slayzone'
    )
  })
  test('dot becomes dash (no run collapsing)', () => {
    expect(encodeClaudeProjectDir('/Users/Kalle/.superset/worktrees/babel')).toBe(
      '-Users-Kalle--superset-worktrees-babel'
    )
  })
  test('underscore becomes dash', () => {
    expect(encodeClaudeProjectDir('/private/tmp/claudecap2_q_f50ypm')).toBe(
      '-private-tmp-claudecap2-q-f50ypm'
    )
  })
  test('existing dash preserved', () => {
    expect(encodeClaudeProjectDir('/Users/Kalle/dev/projects/slayzone-chromium')).toBe(
      '-Users-Kalle-dev-projects-slayzone-chromium'
    )
  })
})

const dir = mkdtempSync(join(tmpdir(), 'ct-'))

// Header lines (no identity fields) then a sidechain user, then a real human turn.
const lines = [
  JSON.stringify({ type: 'last-prompt' }),
  JSON.stringify({ type: 'mode', mode: 'normal' }),
  JSON.stringify({
    type: 'user',
    cwd: '/repo',
    gitBranch: 'main',
    timestamp: '2026-06-03T21:23:29.751Z',
    isSidechain: true,
    message: { content: [{ type: 'tool_result', content: 'x' }] }
  }),
  JSON.stringify({
    type: 'user',
    cwd: '/repo',
    gitBranch: 'main',
    timestamp: '2026-06-03T21:23:30.000Z',
    message: { content: 'hello human' }
  })
]

describe('readClaudeTranscriptMeta', () => {
  let meta: Awaited<ReturnType<typeof readClaudeTranscriptMeta>>
  beforeAll(async () => {
    const file = join(dir, 'x.jsonl')
    writeFileSync(file, lines.join('\n') + '\n')
    meta = await readClaudeTranscriptMeta(file)
  })
  test('reads cwd', () => {
    expect(meta.cwd).toBe('/repo')
  })
  test('reads gitBranch', () => {
    expect(meta.gitBranch).toBe('main')
  })
  test('reads first timestamp', () => {
    expect(meta.firstTsMs).toBe(Date.parse('2026-06-03T21:23:29.751Z'))
  })
  test('detects a real human turn', () => {
    expect(meta.hasHumanTurn).toBe(true)
  })

  // A transcript that is ONLY sidechain / tool_result has no human turn.
  describe('sidechain-only transcript', () => {
    let meta2: Awaited<ReturnType<typeof readClaudeTranscriptMeta>>
    beforeAll(async () => {
      const file2 = join(dir, 'y.jsonl')
      writeFileSync(
        file2,
        [
          JSON.stringify({ type: 'mode' }),
          JSON.stringify({
            type: 'user',
            cwd: '/repo',
            gitBranch: 'main',
            timestamp: '2026-06-03T10:00:00.000Z',
            isSidechain: true,
            message: { content: 'agent subprompt' }
          }),
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'hi' }] }
          })
        ].join('\n') + '\n'
      )
      meta2 = await readClaudeTranscriptMeta(file2)
    })
    test('sidechain-only → no human turn', () => {
      expect(meta2.hasHumanTurn).toBe(false)
    })
    test('still reads cwd from sidechain record', () => {
      expect(meta2.cwd).toBe('/repo')
    })
  })

  // ---- early exit must close the file (the healer re-reads every transcript;
  // a leaked fd per read exhausted the hub and broke every spawn, git included) ----
  test('early exit closes the transcript (no fd leak over 20 reads)', async () => {
    const big = join(dir, 'big.jsonl')
    const filler = JSON.stringify({ type: 'progress', pad: 'x'.repeat(200) })
    writeFileSync(
      big,
      [lines[3], ...Array.from({ length: 20_000 }, () => filler)].join('\n') + '\n'
    )
    const openFds = (): number => readdirSync('/dev/fd').length
    const fdsBefore = openFds()
    for (let i = 0; i < 20; i++) await readClaudeTranscriptMeta(big)
    await new Promise((r) => setTimeout(r, 100))
    const leaked = openFds() - fdsBefore
    expect(
      leaked,
      `early exit closes the transcript (leaked ${leaked} fds over 20 reads)`
    ).toBeLessThanOrEqual(0)
  })
})

// ---- claudeTranscriptRetentionMs (`cleanupPeriodDays` in ~/.claude/settings.json) ----
describe('claudeTranscriptRetentionMs', () => {
  const DAY = 24 * 60 * 60 * 1000
  const home = mkdtempSync(join(tmpdir(), 'ct-home-'))
  const prevHome = process.env.HOME
  beforeAll(() => {
    process.env.HOME = home
  })
  afterAll(() => {
    process.env.HOME = prevHome
  })
  const settings = (body: string): void => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), body)
  }
  test('no settings file → Claude default 30d', () => {
    expect(claudeTranscriptRetentionMs()).toBe(30 * DAY)
  })
  test('reads cleanupPeriodDays', () => {
    settings('{"cleanupPeriodDays": 90}')
    expect(claudeTranscriptRetentionMs()).toBe(90 * DAY)
  })
  test('key absent → default', () => {
    settings('{"model": "x"}')
    expect(claudeTranscriptRetentionMs()).toBe(30 * DAY)
  })
  test('non-numeric → unknown', () => {
    settings('{"cleanupPeriodDays": "soon"}')
    expect(claudeTranscriptRetentionMs()).toBe(null)
  })
  test('unparseable file → default', () => {
    settings('not json')
    expect(claudeTranscriptRetentionMs()).toBe(30 * DAY)
  })
})
