/**
 * A Codex task's usage is attributed to it: the session id its SessionStart hook
 * captured (`provider_config.codex.conversationId`, which the codex `--no-daemon`
 * fix makes arrive) matches the session id of the rollout's token records — on the
 * first parse AND on a later one that resumes the file mid-way.
 *
 * Regression (QA 2026-11-06, task 964073b0 "usage: QA task attribution" → 5decc957):
 * `usageAnalytics.taskCost` was 0. The resumed parse started at the saved offset,
 * past the file's `session_meta` line, so every later turn's records had no session
 * id and no cwd and could never be attributed. Lines are real codex 0.167 shapes.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { queryTaskCost, refreshUsageData, setUsageCollectRouting } from './cache'

const SESSION = '01a1b277-b4d0-7052-a200-eb63b10c21d2'
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slz-codex-usage-')))
const realHome = process.env.HOME
process.env.HOME = home
const dir = path.join(home, '.codex', 'sessions', '2026', '11', '06')
fs.mkdirSync(dir, { recursive: true })
const rollout = path.join(dir, `rollout-2026-11-06T21-05-51-${SESSION}.jsonl`)

const line = (o: unknown) => `${JSON.stringify(o)}\n`
const turn = (turnId: string, at: string, input: number, output: number) =>
  line({
    timestamp: at,
    type: 'turn_context',
    payload: { turn_id: turnId, model: 'gpt-6.1-sol' }
  }) +
  line({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      turn_id: turnId,
      info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output },
        last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output }
      }
    }
  })

const h = await createTestHarness()
const projectId = crypto.randomUUID()
const taskId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
h.db
  .prepare('INSERT INTO tasks (id, project_id, title, provider_config) VALUES (?, ?, ?, ?)')
  .run(taskId, projectId, 'Codex task', JSON.stringify({ codex: { conversationId: SESSION } }))
setUsageCollectRouting(null)

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(home, { recursive: true, force: true })
  h.cleanup()
})

test("every turn of the task's codex session counts toward the task, across refreshes", async () => {
  fs.writeFileSync(
    rollout,
    line({
      timestamp: '2026-11-06T20:11:27.004Z',
      type: 'session_meta',
      payload: { session_id: SESSION, id: SESSION, cwd: '/work/qa', cli_version: '0.167.0' }
    }) + turn('t1', '2026-11-06T20:11:30.000Z', 100, 10)
  )
  await refreshUsageData(h.slayDb)
  expect((await queryTaskCost(h.slayDb, taskId)).totalTokens).toBe(110)

  // The next turn lands after that parse: the refresh resumes at the saved offset.
  const later = new Date(fs.statSync(rollout).mtimeMs + 5000)
  fs.appendFileSync(rollout, turn('t2', '2026-11-06T20:12:56.000Z', 200, 20))
  fs.utimesSync(rollout, later, later)
  await refreshUsageData(h.slayDb)
  const cost = await queryTaskCost(h.slayDb, taskId)
  expect(cost.totalTokens).toBe(330)
  expect(cost.byProvider).toEqual([
    { provider: 'codex', model: 'gpt-6.1-sol', totalTokens: 330, sessions: 1 }
  ])
})
