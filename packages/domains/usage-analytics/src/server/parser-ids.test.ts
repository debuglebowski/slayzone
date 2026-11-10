/**
 * Every usage parser gives a record the same id however the log is read: in one
 * pass, or resumed from a cursor mid-file. The computer keeps its own cursors
 * (robustness plan §9, v209) and parses again whatever the hub did not acknowledge
 * (lost reply, restored backup): the hub's `INSERT OR IGNORE` on the id is what keeps
 * that from counting twice, so an id that depends on where the parse started would
 * double count.
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { collectUsage, type UsageCursors } from './collect'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'slz-usage-ids-')))
const saved: Record<string, string | undefined> = {}
const ENV = [
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'QWEN_CONFIG_DIR',
  'OPENCODE_DATA_DIR'
]

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k]
  for (const k of ENV) delete process.env[k]
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.XDG_DATA_HOME = join(home, '.local', 'share')
  process.env.QWEN_CONFIG_DIR = join(home, '.qwen')
  process.env.OPENCODE_DATA_DIR = join(home, 'opencode')
})
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(home, { recursive: true, force: true })
})

const jl = (o: unknown) => `${JSON.stringify(o)}\n`

/** Ids of one file's records: one pass vs. resumed after `first` was read. */
async function idsBothWays(file: string, first: string, rest: string) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, first)
  const cursors: UsageCursors = {}
  const pass1 = (await collectUsage(cursors)).find((r) => r.sourceFile === file)
  expect(pass1, 'first part parsed').toBeDefined()
  cursors[file] = { offset: pass1!.endOffset, modifiedMs: pass1!.fileMtimeMs }
  appendFileSync(file, rest)
  const later = new Date(statSync(file).mtimeMs + 5000)
  utimesSync(file, later, later)
  const pass2 = (await collectUsage(cursors)).find((r) => r.sourceFile === file)
  const resumed = [...pass1!.records, ...(pass2?.records ?? [])].map((r) => r.id)
  const whole = ((await collectUsage({})).find((r) => r.sourceFile === file)?.records ?? []).map(
    (r) => r.id
  )
  return { resumed, whole }
}

test('claude: ids do not depend on where the parse started', async () => {
  const line = (id: string) =>
    jl({
      type: 'assistant',
      requestId: `req-${id}`,
      sessionId: 's1',
      timestamp: '2026-11-01T00:00:00Z',
      message: { id: `msg-${id}`, model: 'm', usage: { input_tokens: 3, output_tokens: 4 } }
    })
  const { resumed, whole } = await idsBothWays(
    join(home, '.claude', 'projects', 'p', 's.jsonl'),
    line('a') + line('b'),
    line('c')
  )
  expect(whole).toHaveLength(3)
  expect(resumed).toEqual(whole)
})

test('codex: ids do not depend on where the parse started', async () => {
  const turn = (t: string, at: string) =>
    jl({ timestamp: at, type: 'turn_context', payload: { turn_id: t, model: 'gpt' } }) +
    jl({
      timestamp: at,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        turn_id: t,
        info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 } }
      }
    })
  const meta = jl({
    timestamp: '2026-11-01T00:00:00Z',
    type: 'session_meta',
    payload: { id: 'sess', cwd: '/w' }
  })
  const { resumed, whole } = await idsBothWays(
    join(home, '.codex', 'sessions', '2026', '11', '01', 'rollout-sess.jsonl'),
    meta + turn('t1', '2026-11-01T00:00:01Z'),
    turn('t2', '2026-11-01T00:00:02Z')
  )
  expect(whole).toHaveLength(2)
  expect(resumed).toEqual(whole)
})

test('qwen: ids do not depend on where the parse started, even without uuid/session/timestamp', async () => {
  const usage = { promptTokenCount: 5, candidatesTokenCount: 6 }
  const keyed = (u: string) =>
    jl({
      type: 'assistant',
      uuid: u,
      sessionId: 's',
      timestamp: 't',
      model: 'q',
      usageMetadata: usage
    })
  // Entries with none of uuid/sessionId/timestamp fall back to the line itself.
  const bare = (n: number) => jl({ type: 'assistant', model: `q-${n}`, usageMetadata: usage })
  const { resumed, whole } = await idsBothWays(
    join(home, '.qwen', 'projects', 'p', 'chats', 'c.jsonl'),
    keyed('u1') + bare(1),
    bare(2) + keyed('u2')
  )
  expect(whole).toHaveLength(4)
  expect(resumed).toEqual(whole)
})

test('opencode: a message re-read after it changed keeps its id', async () => {
  const dir = join(home, 'opencode', 'storage', 'message')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'msg.json')
  const msg = (output: number) =>
    JSON.stringify({ id: 'm1', sessionID: 's', modelID: 'x', tokens: { input: 1, output } })
  writeFileSync(file, msg(1))
  const cursors: UsageCursors = {}
  const first = (await collectUsage(cursors)).find((r) => r.sourceFile === file)!
  cursors[file] = { offset: first.endOffset, modifiedMs: first.fileMtimeMs }
  writeFileSync(file, msg(2))
  const later = new Date(statSync(file).mtimeMs + 5000)
  utimesSync(file, later, later)
  const second = (await collectUsage(cursors)).find((r) => r.sourceFile === file)!
  const whole = (await collectUsage({})).find((r) => r.sourceFile === file)!
  expect(first.records.map((r) => r.id)).toEqual(second.records.map((r) => r.id))
  expect(whole.records.map((r) => r.id)).toEqual(first.records.map((r) => r.id))
})
