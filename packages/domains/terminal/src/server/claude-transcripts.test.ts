import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  utimesSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  encodeClaudeProjectDir,
  readClaudeTranscriptMeta,
  claudeTranscriptExists,
  claudeTranscriptRetentionMs,
  locateClaudeTranscript
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

// Claude Code keeps everything under CLAUDE_CONFIG_DIR when it is set (the
// e2e harness and some users do): the self-heal must look where the CLI writes.
describe('CLAUDE_CONFIG_DIR', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'ct-config-'))
  const prev = process.env.CLAUDE_CONFIG_DIR
  beforeAll(() => {
    process.env.CLAUDE_CONFIG_DIR = configDir
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prev
  })
  test('a transcript under CLAUDE_CONFIG_DIR exists', () => {
    const dir = join(configDir, 'projects', encodeClaudeProjectDir('/work/repo'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'conv-1.jsonl'), '{}\n')
    expect(claudeTranscriptExists('/work/repo', 'conv-1')).toBe(true)
    expect(claudeTranscriptExists('/work/repo', 'conv-2')).toBe(false)
  })
  test('its settings.json sets the retention', () => {
    writeFileSync(join(configDir, 'settings.json'), '{"cleanupPeriodDays": 7}')
    expect(claudeTranscriptRetentionMs()).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

// A session that moved folders mid-run (EnterWorktree) keeps its transcript ONLY
// under the new folder's project dir. The locator must find it there and say which
// folder `claude --resume` should start in.
describe('locateClaudeTranscript', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'ct-locate-config-'))
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'ct-locate-work-')))
  const repo = join(work, 'repo')
  const worktree = join(repo, '.claude', 'worktrees', 'wt1')
  const prev = process.env.CLAUDE_CONFIG_DIR
  const projectDirOf = (cwd: string): string =>
    join(configDir, 'projects', encodeClaudeProjectDir(cwd))
  const writeTranscript = (cwd: string, id: string, records: object[], name = `${id}.jsonl`) => {
    mkdirSync(projectDirOf(cwd), { recursive: true })
    const file = join(projectDirOf(cwd), name)
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    return file
  }
  const moved = (from: string, to: string) => [
    { type: 'user', cwd: from, message: { content: 'enter a worktree' } },
    { type: 'relocated', relocatedCwd: to },
    { type: 'worktree-state', worktreeSession: { originalCwd: from, worktreePath: to } },
    { type: 'assistant', cwd: to, message: { content: [] } }
  ]
  beforeAll(() => {
    process.env.CLAUDE_CONFIG_DIR = configDir
    mkdirSync(worktree, { recursive: true })
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prev
  })

  test('in the given folder: found, resume where asked (resumeCwd null)', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const file = writeTranscript(repo, id, [{ type: 'user', cwd: repo }])
    expect(await locateClaudeTranscript(id, repo)).toEqual({ path: file, resumeCwd: null })
  })

  test('moved into a worktree: found there, resume from the worktree', async () => {
    const id = '22222222-2222-4222-8222-222222222222'
    const file = writeTranscript(worktree, id, moved(repo, worktree))
    expect(await locateClaudeTranscript(id, repo)).toEqual({ path: file, resumeCwd: worktree })
  })

  test('only a superseded copy left: not found', async () => {
    const id = '33333333-3333-4333-8333-333333333333'
    writeTranscript(worktree, id, moved(repo, worktree), `${id}.jsonl.superseded-1793705127796`)
    expect(await locateClaudeTranscript(id, repo)).toBeNull()
  })

  test('nowhere: not found', async () => {
    expect(await locateClaudeTranscript('44444444-4444-4444-8444-444444444444', repo)).toBeNull()
  })

  test('recorded folder deleted: found, resume where asked (the CLI finds it itself)', async () => {
    const id = '55555555-5555-4555-8555-555555555555'
    const gone = join(repo, '.claude', 'worktrees', 'deleted')
    const file = writeTranscript(gone, id, moved(repo, gone))
    expect(await locateClaudeTranscript(id, repo)).toEqual({ path: file, resumeCwd: null })
  })

  test('recorded folder outside the allowed roots: resume where asked', async () => {
    const id = '66666666-6666-4666-8666-666666666666'
    const file = writeTranscript(worktree, id, moved(repo, worktree))
    const located = await locateClaudeTranscript(id, repo, {
      isAllowedDir: (dir) => dir === repo
    })
    expect(located).toEqual({ path: file, resumeCwd: null })
  })

  test('recorded folder does not match the project dir the file is in: resume where asked', async () => {
    const id = '77777777-7777-4777-8777-777777777777'
    // File sits under the worktree's dir, but its records name another folder.
    const file = writeTranscript(worktree, id, moved(worktree, repo))
    expect(await locateClaudeTranscript(id, join(work, 'elsewhere'))).toEqual({
      path: file,
      resumeCwd: null
    })
  })

  test('a symlinked hint folder (e.g. /tmp → /private/tmp) finds the real-path dir', async () => {
    const id = '88888888-8888-4888-8888-888888888888'
    const link = join(work, 'repo-link')
    symlinkSync(repo, link)
    const file = writeTranscript(repo, id, [{ type: 'user', cwd: repo }])
    expect(await locateClaudeTranscript(id, link)).toEqual({ path: file, resumeCwd: null })
  })

  test('several copies: the newest wins', async () => {
    const id = '99999999-9999-4999-8999-999999999999'
    const old = writeTranscript(join(work, 'old'), id, [{ type: 'user', cwd: join(work, 'old') }])
    utimesSync(old, new Date(1_000_000), new Date(1_000_000))
    const fresh = writeTranscript(worktree, id, moved(repo, worktree))
    expect(await locateClaudeTranscript(id, repo)).toEqual({ path: fresh, resumeCwd: worktree })
  })

  test('the recorded folder is read from the tail of a large transcript', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const filler = Array.from({ length: 4000 }, (_, i) => ({
      type: 'user',
      cwd: repo,
      message: { content: `padding ${i} ${'x'.repeat(400)}` }
    }))
    const file = writeTranscript(worktree, id, [...filler, ...moved(repo, worktree)])
    expect(await locateClaudeTranscript(id, repo)).toEqual({ path: file, resumeCwd: worktree })
  })

  test('an id with path characters is refused', async () => {
    expect(await locateClaudeTranscript('../etc/passwd', repo)).toBeNull()
  })

  test('recorded folder outside the hint (the task moved to another project): resume where asked', async () => {
    // The session ran in the old project's folder, which still exists. The task now
    // lives in another project: `claude --resume` from the new folder continues the
    // conversation there — never back in the old project.
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const oldProject = join(work, 'old-project')
    const newProject = join(work, 'new-project')
    mkdirSync(oldProject, { recursive: true })
    mkdirSync(newProject, { recursive: true })
    const file = writeTranscript(oldProject, id, [{ type: 'user', cwd: oldProject }])
    expect(await locateClaudeTranscript(id, newProject)).toEqual({ path: file, resumeCwd: null })
  })

  test('no hint folder (the computer decides): still found by id', async () => {
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const file = writeTranscript(worktree, id, moved(repo, worktree))
    expect(await locateClaudeTranscript(id, '')).toEqual({ path: file, resumeCwd: worktree })
  })
})
