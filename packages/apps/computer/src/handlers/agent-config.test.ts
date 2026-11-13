/**
 * `agentConfig.fs`: the AI-config ops' filesystem, served by THIS computer — its
 * project folders (allowedRoots) and its own provider dirs under its home
 * (`~/.claude`, `~/.codex`, …), nothing else under home.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { createAgentConfigHandlers } from './agent-config'
import { runInScopeJail, type ScopeJail } from '../path-jail'

let root: string
let home: string
let call: (params: unknown) => Promise<unknown>

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'computer-agent-config-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'computer-agent-home-')))
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [root],
    capabilities: []
  }
  const handlers = createAgentConfigHandlers(
    { dialer: { notify: () => true }, config, log: () => {} },
    () => home
  )
  call = (params) =>
    Promise.resolve(
      (handlers[HubToComputerMethods.agentConfigFs] as (p: unknown) => unknown)(params)
    )
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('agentConfig.fs', () => {
  it('answers its home dir', async () => {
    expect(await call({ op: 'homedir' })).toEqual({ result: home })
  })

  it('reads and writes a project file inside its folders', async () => {
    await call({ op: 'writeFile', path: join(root, 'CLAUDE.md'), content: 'hi' })
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('hi')
    expect(await call({ op: 'readFile', path: join(root, 'CLAUDE.md') })).toEqual({ result: 'hi' })
    expect(await call({ op: 'exists', path: join(root, 'nope') })).toEqual({ result: false })
  })

  it('reaches its own provider dirs under home', async () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'global')
    expect(await call({ op: 'readFile', path: join(home, '.claude', 'CLAUDE.md') })).toEqual({
      result: 'global'
    })
    const entries = (await call({ op: 'readdir', path: join(home, '.claude') })) as {
      result: Array<{ name: string }>
    }
    expect(entries.result.map((e) => e.name).sort()).toEqual(['CLAUDE.md', 'skills'])
  })

  it('refuses the rest of home and anything outside', async () => {
    writeFileSync(join(home, '.ssh-key'), 'secret')
    await expect(call({ op: 'readFile', path: join(home, '.ssh-key') })).rejects.toThrow(/outside/)
    await expect(call({ op: 'readFile', path: '/etc/hosts' })).rejects.toThrow(/outside/)
    await expect(
      call({ op: 'rename', path: join(root, 'a'), to: join(home, '.ssh-key') })
    ).rejects.toThrow(/outside/)
  })

  it('refuses an unknown op', async () => {
    await expect(call({ op: 'chmod', path: join(root, 'a') })).rejects.toThrow()
  })
})

describe('agentConfig.fs under a path scope (§9 Phase 7c)', () => {
  const jail = (roots: string[]): ScopeJail => ({
    label: 'project p1',
    roots,
    excluded: [],
    foreign: [],
    hostReads: false
  })

  it("a project file is confined to the scope's folders", async () => {
    const mine = join(root, 'mine')
    const other = join(root, 'other')
    mkdirSync(mine)
    mkdirSync(other)
    writeFileSync(join(other, 'CLAUDE.md'), 'theirs')
    await runInScopeJail(jail([mine]), async () => {
      await call({ op: 'writeFile', path: join(mine, 'CLAUDE.md'), content: 'ok' })
      await expect(call({ op: 'readFile', path: join(other, 'CLAUDE.md') })).rejects.toThrow(
        /outside the folders of project p1/
      )
      await expect(
        call({ op: 'readFile', path: join(mine, '..', 'other', 'CLAUDE.md') })
      ).rejects.toThrow(/outside the folders of project p1/)
    })
    expect(readFileSync(join(mine, 'CLAUDE.md'), 'utf8')).toBe('ok')
  })

  it('its own provider dirs stay reachable (computer-level files), nothing else in home', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'global')
    writeFileSync(join(home, '.bashrc'), 'secret')
    await runInScopeJail(jail([root]), async () => {
      expect(await call({ op: 'readFile', path: join(home, '.claude', 'CLAUDE.md') })).toEqual({
        result: 'global'
      })
      await expect(call({ op: 'readFile', path: join(home, '.bashrc') })).rejects.toThrow()
      await expect(
        call({ op: 'readFile', path: join(home, '.claude', '..', '.bashrc') })
      ).rejects.toThrow()
    })
  })
})
