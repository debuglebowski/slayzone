import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import { writeSessionFile } from '@slayzone/test-utils/fake-claude'
import type { ComputerConfig } from '../config'
import { createClaudeSessionHandlers } from './claude-session'
import type { ComputerDialer } from './types'

const M = HubToComputerMethods
const dialer: ComputerDialer = { notify: () => true }

let root: string
let configDir: string
let savedConfigDir: string | undefined

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'computer-claude-session-')))
  configDir = join(root, 'claude-config')
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
})
afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  rmSync(root, { recursive: true, force: true })
})

function handlers(projects: Record<string, string> = {}) {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [root],
    capabilities: []
  }
  const table = createClaudeSessionHandlers({ dialer, config, log: () => {} }, () => ({
    get: (id: string) => (projects[id] ? { path: projects[id] } : null)
  }))
  return (params: Record<string, unknown>) =>
    table[M.claudeSessionRead]({ maxRecords: 1000, maxBytes: 1_000_000, ...params }) as Promise<{
      found: boolean
      records: Array<Record<string, unknown>>
      omitted: number
    }>
}

const contentOf = (r: Record<string, unknown>): unknown =>
  (r.message as { content?: unknown } | undefined)?.content

describe('claudeSession.read', () => {
  it('returns the conversation records of the active branch, oldest first, without the bookkeeping', async () => {
    const cwd = join(root, 'repo')
    const id = randomUUID()
    writeSessionFile({
      configDir,
      cwd,
      sessionId: id,
      turns: [
        { user: 'remember APPLE', assistant: 'OK' },
        {
          user: 'run it',
          assistant: 'done',
          tool: { id: 'tu1', name: 'Bash', input: { command: 'ls' }, result: 'a.txt' }
        }
      ]
    })
    const res = await handlers()({ cwd, sessionId: id })
    expect(res.found).toBe(true)
    expect(res.omitted).toBe(0)
    expect(res.records.map((r) => r.type)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant'
    ])
    expect(contentOf(res.records[0])).toBe('remember APPLE')
    expect(contentOf(res.records[3])).toEqual([
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }
    ])
  })

  it('a rewind left a branch: only the active one comes back', async () => {
    const cwd = join(root, 'repo')
    const id = randomUUID()
    const { file, assistantUuids } = writeSessionFile({
      configDir,
      cwd,
      sessionId: id,
      turns: [
        { user: 'APPLE', assistant: 'OK' },
        { user: 'BANANA', assistant: 'OK' }
      ]
    })
    // After rewinding BANANA, the next message hangs off APPLE's answer.
    appendFileSync(
      file,
      JSON.stringify({
        type: 'user',
        uuid: randomUUID(),
        parentUuid: assistantUuids[0],
        isSidechain: false,
        message: { role: 'user', content: 'CHERRY' }
      }) + '\n'
    )
    const res = await handlers()({ cwd, sessionId: id })
    expect(res.records.filter((r) => r.type === 'user').map(contentOf)).toEqual(['APPLE', 'CHERRY'])
  })

  it('caps: the newest records, and how many older ones were left out', async () => {
    const cwd = join(root, 'repo')
    const id = randomUUID()
    writeSessionFile({
      configDir,
      cwd,
      sessionId: id,
      turns: [
        { user: 'one', assistant: 'a1' },
        { user: 'two', assistant: 'a2' },
        { user: 'three', assistant: 'a3' }
      ]
    })
    const res = await handlers()({ cwd, sessionId: id, maxRecords: 2 })
    expect(res.records.map(contentOf)).toEqual(['three', [{ type: 'text', text: 'a3' }]])
    expect(res.omitted).toBe(4)
  })

  it('shortens a huge tool result instead of dropping the record', async () => {
    const cwd = join(root, 'repo')
    const id = randomUUID()
    writeSessionFile({
      configDir,
      cwd,
      sessionId: id,
      turns: [
        {
          user: 'cat it',
          assistant: 'that was long',
          tool: { id: 'tu1', name: 'Bash', input: {}, result: 'x'.repeat(200_000) }
        }
      ]
    })
    const res = await handlers()({ cwd, sessionId: id })
    const result = res.records.find((r) => JSON.stringify(contentOf(r)).includes('tool_result'))
    expect(JSON.stringify(result).length).toBeLessThan(40_000)
    expect(JSON.stringify(result)).toContain('(shortened)')
  })

  it('resolves the project checkout when the hub sends no cwd', async () => {
    const cwd = join(root, 'checkout')
    const id = randomUUID()
    writeSessionFile({ configDir, cwd, sessionId: id, turns: [{ user: 'hi', assistant: 'hello' }] })
    const res = await handlers({ p1: cwd })({ projectId: 'p1', sessionId: id })
    expect(res.found).toBe(true)
    expect(res.records).toHaveLength(2)
  })

  it('no session file: found false', async () => {
    const res = await handlers()({ cwd: join(root, 'repo'), sessionId: randomUUID() })
    expect(res).toEqual({ found: false, records: [], omitted: 0 })
  })

  it('refuses a cwd outside the jail and an id that is not a uuid', async () => {
    await expect(handlers()({ cwd: '/etc', sessionId: randomUUID() })).rejects.toThrow()
    await expect(
      handlers()({ cwd: join(root, 'repo'), sessionId: '../../secret' })
    ).rejects.toThrow()
  })
})

// A session that used EnterWorktree keeps its file only under the worktree's
// project dir (`relocated` record). The computer owns that disk, so it answers
// where the conversation is and which folder to resume it from.
describe('claudeSession.locate', () => {
  function locate(projects: Record<string, string> = {}, allowedRoots?: string[]) {
    const config: ComputerConfig = {
      hubUrl: 'ws://localhost:0/computers',
      name: 'test',
      allowedRoots: allowedRoots ?? [root],
      capabilities: []
    }
    const table = createClaudeSessionHandlers({ dialer, config, log: () => {} }, () => ({
      get: (id: string) => (projects[id] ? { path: projects[id] } : null)
    }))
    return (params: Record<string, unknown>) =>
      table[M.claudeSessionLocate](params) as Promise<{
        sessions: Array<{ sessionId: string; found: boolean; resumeCwd: string | null }>
      }>
  }
  function moveIntoWorktree(cwd: string, worktree: string, id: string): void {
    const { file } = writeSessionFile({
      configDir,
      cwd: worktree,
      sessionId: id,
      turns: [{ user: 'enter a worktree', assistant: 'done' }]
    })
    appendFileSync(file, `${JSON.stringify({ type: 'relocated', relocatedCwd: worktree })}\n`)
    void cwd
  }

  it('a session moved into a worktree: found, resume from the worktree', async () => {
    const cwd = join(root, 'repo')
    const worktree = join(cwd, '.claude', 'worktrees', 'wt1')
    mkdirSync(worktree, { recursive: true })
    const moved = randomUUID()
    const here = randomUUID()
    const missing = randomUUID()
    moveIntoWorktree(cwd, worktree, moved)
    writeSessionFile({ configDir, cwd, sessionId: here, turns: [{ user: 'hi', assistant: 'yo' }] })
    const res = await locate()({ cwd, sessionIds: [moved, here, missing] })
    expect(res.sessions).toEqual([
      { sessionId: moved, found: true, resumeCwd: worktree },
      { sessionId: here, found: true, resumeCwd: null },
      { sessionId: missing, found: false, resumeCwd: null }
    ])
  })

  it('resolves the project checkout when the hub sends no cwd', async () => {
    const cwd = join(root, 'repo')
    const worktree = join(cwd, '.claude', 'worktrees', 'wt1')
    mkdirSync(worktree, { recursive: true })
    const id = randomUUID()
    moveIntoWorktree(cwd, worktree, id)
    const res = await locate({ p1: cwd })({ projectId: 'p1', sessionIds: [id] })
    expect(res.sessions).toEqual([{ sessionId: id, found: true, resumeCwd: worktree }])
  })

  it('never offers a resume folder outside the jail', async () => {
    const cwd = join(root, 'repo')
    const worktree = join(root, 'outside', 'wt1')
    mkdirSync(worktree, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    const id = randomUUID()
    moveIntoWorktree(cwd, worktree, id)
    const res = await locate({}, [cwd])({ cwd, sessionIds: [id] })
    expect(res.sessions).toEqual([{ sessionId: id, found: true, resumeCwd: null }])
  })

  it('refuses a cwd outside the jail', async () => {
    await expect(locate()({ cwd: '/etc', sessionIds: [randomUUID()] })).rejects.toThrow()
  })

  it('read follows a moved session too', async () => {
    const cwd = join(root, 'repo')
    const worktree = join(cwd, '.claude', 'worktrees', 'wt1')
    mkdirSync(worktree, { recursive: true })
    const id = randomUUID()
    moveIntoWorktree(cwd, worktree, id)
    const res = await handlers()({ cwd, sessionId: id })
    expect(res.found).toBe(true)
    expect(contentOf(res.records[0])).toBe('enter a worktree')
  })
})
