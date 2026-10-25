import { describe, expect, it } from 'vitest'
import type { Task } from '@slayzone/task/shared'
import { mainTerminalProps, plainMainTerminalCwd } from './main-terminal-props'

const task = (extra: Partial<Task> = {}): Task =>
  ({
    id: 't',
    terminal_mode: 'claude-code',
    provider_config: { 'claude-code': { flags: '--x' } },
    worktree_path: null,
    base_dir: null,
    repo_name: null,
    ...extra
  }) as unknown as Task

const modes = [{ id: 'claude-code', initialCommand: 'claude --session-id {id} {flags}' }]

describe('mainTerminalProps', () => {
  it('derives every spawn prop from task + project + modes', () => {
    const p = mainTerminalProps(
      task({ currentConversationByMode: { 'claude-code': 'c1' } } as Partial<Task>),
      { execution_context: null },
      modes
    )
    expect(p).toEqual({
      mode: 'claude-code',
      conversationId: 'c1',
      existingConversationId: 'c1',
      conversationHydrated: true,
      supportsSessionId: true,
      providerFlags: '--x',
      executionContext: null
    })
  })

  it('an unhydrated task holds its spawn; unknown modes do not pre-mint', () => {
    const p = mainTerminalProps(task(), null, [])
    expect(p.conversationHydrated).toBe(false)
    expect(p.supportsSessionId).toBe(false)
    expect(p.conversationId).toBeUndefined()
  })
})

describe('plainMainTerminalCwd', () => {
  const project = { path: '/p', selected_repo: null }
  it('is the project root for a task with nothing bound', () => {
    expect(plainMainTerminalCwd(task(), project)).toBe('/p')
  })
  it('is null whenever the cwd needs async resolution or a different root', () => {
    expect(plainMainTerminalCwd(task({ worktree_path: '/w' }), project)).toBeNull()
    expect(plainMainTerminalCwd(task({ base_dir: '/b' }), project)).toBeNull()
    expect(plainMainTerminalCwd(task({ repo_name: 'r' }), project)).toBeNull()
    expect(plainMainTerminalCwd(task(), { path: '/p', selected_repo: 'r' })).toBeNull()
    expect(
      plainMainTerminalCwd(task(), { path: null as unknown as string, selected_repo: null })
    ).toBeNull()
  })
})
