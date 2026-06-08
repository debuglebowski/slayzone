import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { encodeClaudeProjectDir, readClaudeTranscriptMeta } from './claude-transcripts'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

// ---- encodeClaudeProjectDir (verified against real ~/.claude/projects names) ----
assert(
  encodeClaudeProjectDir('/Users/Kalle/dev/projects/slayzone') === '-Users-Kalle-dev-projects-slayzone',
  'plain path encodes'
)
assert(
  encodeClaudeProjectDir('/Users/Kalle/.superset/worktrees/babel') === '-Users-Kalle--superset-worktrees-babel',
  'dot becomes dash (no run collapsing)'
)
assert(
  encodeClaudeProjectDir('/private/tmp/claudecap2_q_f50ypm') === '-private-tmp-claudecap2-q-f50ypm',
  'underscore becomes dash'
)
assert(
  encodeClaudeProjectDir('/Users/Kalle/dev/projects/slayzone-chromium') ===
    '-Users-Kalle-dev-projects-slayzone-chromium',
  'existing dash preserved'
)

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ct-'))
  const file = join(dir, 'x.jsonl')

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
  writeFileSync(file, lines.join('\n') + '\n')

  const meta = await readClaudeTranscriptMeta(file)
  assert(meta.cwd === '/repo', 'reads cwd')
  assert(meta.gitBranch === 'main', 'reads gitBranch')
  assert(meta.firstTsMs === Date.parse('2026-06-03T21:23:29.751Z'), 'reads first timestamp')
  assert(meta.hasHumanTurn === true, 'detects a real human turn')

  // A transcript that is ONLY sidechain / tool_result has no human turn.
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
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
    ].join('\n') + '\n'
  )
  const meta2 = await readClaudeTranscriptMeta(file2)
  assert(meta2.hasHumanTurn === false, 'sidechain-only → no human turn')
  assert(meta2.cwd === '/repo', 'still reads cwd from sidechain record')

  console.log('claude-transcripts: all passed')
}

void main()
