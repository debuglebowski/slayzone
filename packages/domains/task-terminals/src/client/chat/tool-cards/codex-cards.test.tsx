// @vitest-environment jsdom
/**
 * Codex tool cards, fed by the items real codex 0.159.2 sent
 * (`fake-codex/transcripts/*.jsonl`). The chat driver maps an item to a
 * `tool-call` (input = the started item) and a `tool-result` (structured = the
 * completed item; rawContent = a command's `aggregatedOutput`), named
 * `codex/commandExecution`, `codex/fileChange`, `codex/webSearch`,
 * `mcp/<server>/<tool>` (contract X1 → X2).
 */
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  recordedCodexItems,
  type RecordedCodexItem
} from '@slayzone/test-utils/fake-codex/recorded'
import type { CommandTaskOutput } from '@slayzone/terminal-contracts'
import type { CommandTaskView, ToolInvocation } from '@slayzone/terminal/client'

const polled: Array<{ taskId: string | undefined; running: boolean }> = []
let pollAnswer: CommandTaskOutput | undefined

vi.mock('./command-task-hooks', async () => {
  const { createContext } = await import('react')
  return {
    CommandTaskContext: createContext(null),
    useCommandTaskOutput: (taskId: string | undefined, running: boolean) => {
      polled.push({ taskId, running })
      return running ? pollAnswer : undefined
    },
    useCommandTaskActions: () => ({ stop: vi.fn(), background: vi.fn(), pending: false })
  }
})
vi.mock('@slayzone/diff-view', () => ({
  DiffView: ({
    diff
  }: {
    diff: { path: string; hunks: Array<{ lines: Array<{ type: string; content: string }> }> }
  }) => (
    <div data-testid="diff-view" data-path={diff.path}>
      {diff.hunks
        .flatMap((h) => h.lines)
        .map((l, i) => (
          <div key={i} data-line={l.type}>
            {l.content}
          </div>
        ))}
    </div>
  )
}))
vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))
vi.mock('../../trpc', () => ({
  useTRPCClient: () => ({
    app: { shell: { openPath: { mutate: vi.fn() }, openExternal: { mutate: vi.fn() } } }
  })
}))

const { renderTool } = await import('../renderers')
const { TooltipProvider } = await import('@slayzone/ui')

const TOOL_NAME: Record<string, (it: RecordedCodexItem) => string> = {
  commandExecution: () => 'codex/commandExecution',
  fileChange: () => 'codex/fileChange',
  webSearch: () => 'codex/webSearch',
  mcpToolCall: (it) => `mcp/${String(it.server)}/${String(it.tool)}`
}

/** The tool row the driver builds from a recorded item (started → call, completed → result). */
function invocationOf(
  started: RecordedCodexItem,
  completed?: RecordedCodexItem,
  over: Partial<ToolInvocation> = {}
): ToolInvocation {
  const status = completed?.status
  const isError = status === 'failed' || status === 'declined'
  return {
    id: started.id,
    name: TOOL_NAME[started.type](started),
    input: started,
    status: completed ? (isError ? 'error' : 'done') : 'pending',
    ...(completed
      ? {
          result: {
            isError,
            rawContent:
              typeof completed.aggregatedOutput === 'string' ? completed.aggregatedOutput : '',
            structured: completed
          }
        }
      : {}),
    ...over
  }
}

function recorded(recipe: string, type: string, index = 0) {
  const started = recordedCodexItems(recipe, 'started', type)[index]
  const completed = recordedCodexItems(recipe, 'completed', type).find((c) => c.id === started.id)
  if (!started || !completed) throw new Error(`no ${type} #${index} in ${recipe}`)
  return { started, completed }
}

const show = (invocation: ToolInvocation) =>
  render(<TooltipProvider>{renderTool(invocation, 0)}</TooltipProvider>)
const noRawJson = () => {
  const text = document.body.textContent ?? ''
  expect(text).not.toMatch(/"(command|cwd|changes|commandActions|aggregatedOutput|type)"\s*:/)
}
const diffLines = (root: ParentNode = document) =>
  Array.from(root.querySelectorAll('[data-testid="diff-view"] [data-line]')).map(
    (el) => `${el.getAttribute('data-line')}:${el.textContent}`
  )

beforeEach(() => {
  polled.length = 0
  pollAnswer = undefined
})
afterEach(() => cleanup())

describe('Codex command card', () => {
  it('shows the command (without the shell wrapper), exit code, duration and output', () => {
    const { started, completed } = recorded('command-exec', 'commandExecution')
    show(invocationOf(started, completed))
    const card = screen.getByTestId('tool-codex-command')
    expect(screen.getByTestId('codex-command').textContent).toBe(
      'for i in 1 2 3; do echo line $i; sleep 1; done'
    )
    expect(card.textContent).not.toContain('/bin/zsh -lc')
    expect(screen.getByTestId('codex-command-output').textContent).toBe('line 1\nline 2\nline 3\n')
    expect(screen.getByTestId('codex-command-exit').textContent).toBe('exit 0')
    expect(screen.getByTestId('codex-command-duration').textContent).toBe('2.9s')
    noRawJson()
  })

  it('a failing command is an error with its exit code', () => {
    const { started, completed } = recorded('command-exec', 'commandExecution')
    show(
      invocationOf(started, { ...completed, status: 'failed', exitCode: 2 } as RecordedCodexItem)
    )
    const exit = screen.getByTestId('codex-command-exit')
    expect(exit.textContent).toBe('exit 2')
    expect(exit.className).toContain('text-destructive')
  })

  it('a declined command says so and has no output', () => {
    const { started, completed } = recorded('approval-exec', 'commandExecution', 3)
    expect(completed.status).toBe('declined')
    show(invocationOf(started, completed))
    expect(screen.getByTestId('codex-command').textContent).toBe('touch c.txt')
    expect(screen.getByTestId('tool-codex-command').textContent).toContain('Declined')
    expect(screen.queryByTestId('codex-command-output')).toBeNull()
  })

  it('shows the folder only when it is not the session folder', () => {
    const { started, completed } = recorded('command-exec', 'commandExecution')
    show(
      invocationOf({ ...started, cwd: '/elsewhere/pkg' }, { ...completed, cwd: '/elsewhere/pkg' })
    )
    expect(screen.getByTestId('codex-command-cwd').textContent).toContain('/elsewhere/pkg')
  })

  it('while it runs: a timer and the live output (the command task), no background/stop actions', () => {
    const { started } = recorded('command-exec', 'commandExecution')
    const task: CommandTaskView = {
      taskId: started.id,
      status: 'running',
      backgrounded: false,
      startedAt: Date.now() - 2_000
    }
    pollAnswer = { state: 'running', output: 'line 1\n', totalBytes: 7, truncated: false }
    show(invocationOf(started, undefined, { task }))
    expect(polled).toContainEqual({ taskId: started.id, running: true })
    expect(screen.getByTestId('bash-live-output').textContent).toBe('line 1\n')
    expect(screen.getByTestId('codex-command-elapsed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /background|stop command/i })).toBeNull()
  })

  it('an older saved row (input = {command, cwd}) still renders as a command card', () => {
    show({
      id: 'cmd-1',
      name: 'codex/commandExecution',
      input: { command: 'ls -la', cwd: '/repo' },
      status: 'done',
      result: {
        isError: false,
        rawContent: 'a.ts',
        structured: {
          type: 'commandExecution',
          id: 'cmd-1',
          status: 'completed',
          aggregatedOutput: 'a.ts'
        }
      }
    })
    expect(screen.getByTestId('codex-command').textContent).toBe('ls -la')
    expect(screen.getByTestId('codex-command-output').textContent).toBe('a.ts')
  })
})

describe('Codex file change card', () => {
  it('a new file: its content as added lines', () => {
    const { started, completed } = recorded('file-change', 'fileChange', 0)
    show(invocationOf(started, completed))
    expect(diffLines()).toEqual(['add:hello world'])
    expect(screen.getByTestId('tool-codex-file-change').textContent).toContain('notes.txt')
    noRawJson()
  })

  it('an edit: the real diff', () => {
    const { started, completed } = recorded('file-change', 'fileChange', 1)
    show(invocationOf(started, completed))
    expect(diffLines()).toEqual(['delete:hello world', 'add:hello codex'])
    expect(screen.getByTestId('tool-codex-file-change').textContent).toContain('+1')
    noRawJson()
  })

  it('several files in one change: one diff per file', () => {
    const { started, completed } = recorded('file-change', 'fileChange', 1)
    const two = {
      ...completed,
      changes: [
        ...(completed.changes as unknown[]),
        { path: '/repo/src/b.ts', kind: { type: 'add' }, diff: 'export const b = 1\n' }
      ]
    } as RecordedCodexItem
    show(invocationOf({ ...started, changes: two.changes }, two))
    const views = screen.getAllByTestId('diff-view')
    expect(views.map((v) => v.getAttribute('data-path'))).toEqual([
      expect.stringMatching(/notes\.txt$/),
      '/repo/src/b.ts'
    ])
    expect(screen.getByTestId('tool-codex-file-change').textContent).toContain('2 files')
  })

  it('shows the diff while the change waits (input only)', () => {
    const { started } = recorded('approval-file', 'fileChange', 0)
    show(invocationOf(started))
    expect(diffLines()).toEqual(['add:one.'])
  })
})

describe('Codex MCP and web search cards', () => {
  it('an MCP call: server, tool, arguments and the text it returned', () => {
    const { started, completed } = recorded('mcp-tool', 'mcpToolCall')
    show(invocationOf(started, completed))
    const card = document.body
    expect(card.textContent).toContain('echo')
    expect(card.textContent).toContain('slz_echo')
    fireEvent.click(screen.getByRole('button', { name: /echo/ }))
    expect(card.textContent).toContain('ping')
    expect(card.textContent).toContain('echo: ping')
    expect(card.textContent).not.toContain('mcpToolCall')
  })

  it('a failed MCP call shows its error', () => {
    const { started, completed } = recorded('mcp-tool', 'mcpToolCall')
    show(
      invocationOf(started, {
        ...completed,
        status: 'failed',
        result: null,
        error: { message: 'tool exploded' }
      } as RecordedCodexItem)
    )
    expect(document.body.textContent).toContain('tool exploded')
  })

  it('a web search: the query it ran (not the empty start one) and its result links', () => {
    const { started, completed } = recorded('web-search', 'webSearch')
    expect(started.query).toBe('')
    show(invocationOf(started, completed))
    expect(document.body.textContent).toContain(
      'site:github.com/openai codex CLI official repository'
    )
    fireEvent.click(screen.getByRole('button', { name: /Search/ }))
    expect(screen.getByText('codex/README.md at main · openai/codex · GitHub')).toBeTruthy()
  })
})
