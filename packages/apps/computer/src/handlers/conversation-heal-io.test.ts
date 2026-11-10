/**
 * The conversation heal's disk access on the computer is jailed (robustness plan
 * §9): a folder the hub names outside the allowed roots is never read — the
 * locator answers "unknown" (the heal then keeps the id), the rest refuse.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeSessionFile } from '@slayzone/test-utils/fake-claude'
import type { ComputerConfig } from '../config'
import { createConversationHealIo } from './conversation-heal-io'
import type { ComputerDialer } from './types'

const dialer: ComputerDialer = { notify: () => true }
let root: string
let outside: string
let configDir: string
let savedConfigDir: string | undefined

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'computer-heal-io-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'computer-heal-io-outside-')))
  configDir = join(root, 'claude-config')
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
})
afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

function io(projects: Record<string, string> = {}) {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [root],
    capabilities: []
  }
  return createConversationHealIo({ dialer, config, log: () => {} }, () => ({
    get: (id: string) => (projects[id] ? { path: projects[id] } : null)
  }))
}

describe('conversation heal io', () => {
  it('locates transcripts under an allowed folder, by cwd or by project', async () => {
    const cwd = join(root, 'repo')
    mkdirSync(cwd, { recursive: true })
    const id = randomUUID()
    writeSessionFile({ configDir, cwd, sessionId: id, turns: [{ user: 'hi', assistant: 'yo' }] })
    const missing = randomUUID()
    const byCwd = await io().locate({ cwd, projectId: null, sessionIds: [id, missing] })
    expect(byCwd?.get(id)).toEqual({ found: true })
    expect(byCwd?.get(missing)).toEqual({ found: false })
    const byProject = await io({ p1: cwd }).locate({ cwd: '', projectId: 'p1', sessionIds: [id] })
    expect(byProject?.get(id)).toEqual({ found: true })
    expect(await io().listTranscriptIds(cwd)).toEqual([id])
  })

  it('a folder outside the allowed roots: locate is unknown, reads refuse, no branch', async () => {
    expect(await io().locate({ cwd: outside, projectId: null, sessionIds: ['x'] })).toBeNull()
    await expect(io().listTranscriptIds(outside)).rejects.toThrow()
    await expect(io().readTranscriptMeta(outside, 'x')).rejects.toThrow()
    expect(await io().currentBranch(outside)).toBeNull()
  })
})
