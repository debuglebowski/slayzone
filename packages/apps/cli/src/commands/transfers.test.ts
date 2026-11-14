import { execFileSync } from 'node:child_process'
import { Command } from 'commander'
import { afterEach, expect, test, vi } from 'vitest'
import { apiGet, apiPost } from '../api'
import {
  registerTaskTransfers,
  registerProjectTransfers,
  hasTransferDestination
} from './transfers'
import { fishScript, zshScript, bashScript } from './completions'

vi.mock('../api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

function program() {
  const root = new Command('slay').enablePositionalOptions().option('--hub <source>')
  const tasks = root.command('tasks')
  const projects = root.command('projects')
  registerTaskTransfers(tasks)
  registerProjectTransfers(projects)
  return root
}

test('copy destination hub stays separate from root source hub; no-wait avoids polling', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.mocked(apiPost).mockResolvedValue({
    data: { id: 'transfer', mode: 'copy', status: 'running', step: 'export' }
  })
  const root = program()
  await root.parseAsync(
    [
      '--hub',
      'source',
      'tasks',
      'copy',
      'task',
      '--project',
      'Destination',
      '--hub',
      'target',
      '--no-subtasks',
      '--title',
      'Fork',
      '--no-wait'
    ],
    { from: 'user' }
  )
  expect(root.opts().hub).toBe('source')
  expect(apiPost).toHaveBeenCalledWith(
    '/api/tasks/task/copy',
    expect.objectContaining({
      project: 'Destination',
      hub: 'target',
      includeSubtasks: false,
      includeSessions: false,
      title: 'Fork'
    })
  )
  expect(apiGet).not.toHaveBeenCalled()
})

test('project copy supports same hub and name', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.mocked(apiPost).mockResolvedValue({ data: { id: 'transfer', status: 'done' } })
  await program().parseAsync(['projects', 'copy', 'Source project', '--name', 'Fork'], {
    from: 'user'
  })
  expect(apiPost).toHaveBeenCalledWith(
    '/api/projects/Source%20project/copy',
    expect.objectContaining({ name: 'Fork', hub: undefined, includeSessions: false })
  )
})

test('transfer control uses journal endpoint', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.mocked(apiPost).mockResolvedValue({ data: { id: 'transfer' } })
  await program().parseAsync(['tasks', 'moves', 'cancel', 'transfer'], { from: 'user' })
  expect(apiPost).toHaveBeenCalledWith('/api/task-moves/transfer/cancel', {})
})

test('all shells complete transfer commands, nested actions and flags', () => {
  for (const script of [fishScript(program()), zshScript(program()), bashScript(program())]) {
    expect(script).toContain('copy')
    expect(script).toContain('pause')
    expect(script).toContain('--project')
  }
})

test('bash completes nested transfer actions and destination flags', () => {
  const script = bashScript(program())
  const complete = (words: string, index: number) =>
    execFileSync(
      'bash',
      [
        '-c',
        `${script}\nCOMP_WORDS=(${words}); COMP_CWORD=${index}; _slay_completions; printf '%s\\n' "\${COMPREPLY[@]}"`
      ],
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
  expect(complete('slay tasks moves pa', 3)).toEqual(['pause'])
  expect(complete('slay tasks copy task --pro', 4)).toEqual(['--project'])
})

test('destination scoping is limited to transfers', () => {
  expect(hasTransferDestination(['--hub', 'source', 'tasks', 'copy'])).toBe(true)
  expect(hasTransferDestination(['projects', 'move', 'project'])).toBe(true)
  expect(hasTransferDestination(['tasks', 'list', '--hub', 'source'])).toBe(false)
})
