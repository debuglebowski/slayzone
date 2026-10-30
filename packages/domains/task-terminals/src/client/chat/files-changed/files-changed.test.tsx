// @vitest-environment jsdom
/**
 * Files changed (chat E, plan 4.3): the turn's summary row, its link to the tool
 * card that made a change (revealed and opened), and the conversation's panel
 * with one combined diff per file.
 */
import type React from 'react'
import { useContext, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { TimelineItem } from '@slayzone/terminal/client'

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

import { ChatViewContext, type ChatViewState } from '../ChatViewContext'
import { renderTimelineItem } from '../renderers'
import { stableAnchorKey } from '../useChatDisplay'
import { TimelineRevealContext } from '../timeline-reveal'
import { ToolFocusContext, ToolFocusStore } from '../tool-cards/tool-focus'
import { FilesChangedPanel } from './FilesChangedPanel'

const editTool = (id: string, path: string, before: string, after: string, nested = false) =>
  ({
    kind: 'tool',
    invocation: {
      id,
      name: 'Edit',
      input: { file_path: path, old_string: 'x', new_string: 'y' },
      status: 'done',
      result: {
        rawContent: 'ok',
        isError: false,
        structured: {
          filePath: path,
          originalFile: before,
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [`-${before.trimEnd()}`, `+${after.trimEnd()}`]
            }
          ]
        }
      }
    },
    timestamp: 1,
    ...(nested ? { parentToolUseId: 'task1' } : {})
  }) as Extract<TimelineItem, { kind: 'tool' }>

const row = (files: Array<{ path: string; ids: string[]; created?: boolean }>, shell = 0) =>
  ({
    kind: 'files-changed',
    id: `files:${files.at(-1)?.ids.at(-1)}`,
    files: files.map((f) => ({
      path: f.path,
      toolUseIds: f.ids,
      additions: 1,
      deletions: f.created ? 0 : 1,
      created: f.created ?? false
    })),
    shellCommands: shell,
    timestamp: 2
  }) as Extract<TimelineItem, { kind: 'files-changed' }>

function setup(timeline: TimelineItem[], item: TimelineItem, extra: Partial<ChatViewState> = {}) {
  const reveal = vi.fn()
  const openPanel = vi.fn()
  const focus = new ToolFocusStore()
  const request = vi.spyOn(focus, 'request')
  function View({ children }: { children: React.ReactNode }) {
    const base = useContext(ChatViewContext)
    const value: ChatViewState = {
      ...base,
      cwd: '/repo',
      timeline,
      fileEditsOpenByDefault: false,
      filesPanel: { open: openPanel },
      ...extra
    }
    return (
      <ChatViewContext.Provider value={value}>
        <TimelineRevealContext.Provider value={reveal}>
          <ToolFocusContext.Provider value={focus}>{children}</ToolFocusContext.Provider>
        </TimelineRevealContext.Provider>
      </ChatViewContext.Provider>
    )
  }
  render(
    <View>
      {timeline.map((it, i) => (
        <div key={i}>{renderTimelineItem(it, i)}</div>
      ))}
      {!timeline.includes(item) && renderTimelineItem(item, 99)}
    </View>
  )
  return { reveal, openPanel, focus, request }
}

afterEach(cleanup)

describe('files-changed row', () => {
  const e1 = editTool('e1', '/repo/src/a.ts', 'one\n', 'two\n')
  const e2 = editTool('e2', '/repo/src/a.ts', 'two\n', 'three\n')

  it('says how many files changed; opens to list them, relative to the cwd', () => {
    const r = row([
      { path: '/repo/src/a.ts', ids: ['e1', 'e2'] },
      { path: '/repo/new.ts', ids: ['w1'], created: true }
    ])
    setup([e1, e2], r)
    const summary = screen.getByTestId('chat-files-changed')
    expect(summary.textContent).toContain('2 files changed')
    fireEvent.click(within(summary).getByTestId('chat-files-changed-toggle'))
    const files = within(summary).getAllByTestId('chat-files-changed-file')
    expect(files.map((f) => f.textContent)).toEqual([
      expect.stringContaining('src/a.ts'),
      expect.stringContaining('new.ts')
    ])
    expect(files[1].textContent).toContain('New')
  })

  it("a file reveals its first edit's card (the timeline's key for that row) and opens it", () => {
    const r = row([{ path: '/repo/src/a.ts', ids: ['e1', 'e2'] }])
    const { reveal, request } = setup([e1, e2], r)
    const summary = screen.getByTestId('chat-files-changed')
    fireEvent.click(within(summary).getByTestId('chat-files-changed-toggle'))
    fireEvent.click(within(summary).getByTestId('chat-files-changed-file'))
    expect(reveal).toHaveBeenCalledWith(stableAnchorKey(e1), { align: 'center' })
    expect(request).toHaveBeenCalledWith('e1')
  })

  const subAgent = (toolUseId: string, parent?: string) =>
    ({
      kind: 'sub-agent',
      phase: 'completed',
      toolUseId,
      description: 'Edit things',
      timestamp: 1,
      ...(parent ? { parentToolUseId: parent } : {})
    }) as unknown as TimelineItem

  it("a sub-agent's edit: its sub-agent row is revealed and opened, and the card in it", () => {
    const nested = editTool('n1', '/repo/b.ts', 'a\n', 'b\n', true)
    const r = row([{ path: '/repo/b.ts', ids: ['n1'] }])
    const { reveal, openPanel, request } = setup([subAgent('task1'), nested], r, {
      childIndex: new Map([['task1', [1]]])
    })
    const summary = screen.getByTestId('chat-files-changed')
    fireEvent.click(within(summary).getByTestId('chat-files-changed-toggle'))
    fireEvent.click(within(summary).getByTestId('chat-files-changed-file'))
    expect(reveal).toHaveBeenCalledWith('sub-agent:task1', { align: 'center' })
    expect(request.mock.calls).toEqual([['task1'], ['n1']])
    expect(openPanel).not.toHaveBeenCalled()
    // The row opened: the edit's card shows inside it.
    expect(screen.getByTestId('sub-agent-children')).toBeTruthy()
  })

  it("a nested sub-agent's edit reveals the outermost sub-agent row and opens the way down", () => {
    const nested = {
      ...editTool('n2', '/repo/c.ts', 'a\n', 'b\n', true),
      parentToolUseId: 'task2'
    } as TimelineItem
    const r = row([{ path: '/repo/c.ts', ids: ['n2'] }])
    const { reveal, request } = setup([subAgent('task1'), subAgent('task2', 'task1'), nested], r)
    const summary = screen.getByTestId('chat-files-changed')
    fireEvent.click(within(summary).getByTestId('chat-files-changed-toggle'))
    fireEvent.click(within(summary).getByTestId('chat-files-changed-file'))
    expect(reveal).toHaveBeenCalledWith('sub-agent:task1', { align: 'center' })
    expect(request.mock.calls).toEqual([['task1'], ['task2'], ['n2']])
  })

  it("a sub-agent's edit whose sub-agent row is not in the timeline: the panel opens at that file", () => {
    const nested = editTool('n1', '/repo/b.ts', 'a\n', 'b\n', true)
    const r = row([{ path: '/repo/b.ts', ids: ['n1'] }])
    const { reveal, openPanel } = setup([nested], r)
    const summary = screen.getByTestId('chat-files-changed')
    fireEvent.click(within(summary).getByTestId('chat-files-changed-toggle'))
    fireEvent.click(within(summary).getByTestId('chat-files-changed-file'))
    expect(reveal).not.toHaveBeenCalled()
    expect(openPanel).toHaveBeenCalledWith('/repo/b.ts')
  })

  it('with tools hidden (final replies only) the panel opens instead', () => {
    const r = row([{ path: '/repo/src/a.ts', ids: ['e1'] }])
    const { reveal, openPanel } = setup([e1], r, { finalOnly: true })
    const summary = screen.getByTestId('chat-files-changed')
    fireEvent.click(within(summary).getByTestId('chat-files-changed-toggle'))
    fireEvent.click(within(summary).getByTestId('chat-files-changed-file'))
    expect(reveal).not.toHaveBeenCalled()
    expect(openPanel).toHaveBeenCalledWith('/repo/src/a.ts')
  })

  it('"View changes" opens the panel; shell commands are said to be untracked', () => {
    const r = row([{ path: '/repo/src/a.ts', ids: ['e1'] }], 2)
    const { openPanel } = setup([e1], r)
    const summary = screen.getByTestId('chat-files-changed')
    fireEvent.click(within(summary).getByTestId('chat-files-changed-toggle'))
    expect(within(summary).getByTestId('chat-files-changed-shell-note').textContent).toMatch(
      /2 shell commands/
    )
    fireEvent.click(within(summary).getByTestId('chat-files-changed-view'))
    expect(openPanel).toHaveBeenCalledTimes(1)
    expect(openPanel.mock.calls[0][0]).toBeUndefined()
  })
})

describe('tool card focus', () => {
  it('a closed card opens when it is asked to show itself', () => {
    const e1 = editTool('e1', '/repo/a.ts', 'one\n', 'two\n')
    const { focus } = setup([e1], e1)
    expect(screen.queryByTestId('diff-view')).toBeNull()
    act(() => focus.request('e1'))
    expect(screen.getByTestId('diff-view')).toBeTruthy()
  })

  it('a card that mounts after the request (scrolled in) opens too', () => {
    const e1 = editTool('e1', '/repo/a.ts', 'one\n', 'two\n')
    const focus = new ToolFocusStore()
    focus.request('e1')
    function Later() {
      const [shown, setShown] = useState(false)
      return (
        <>
          <button onClick={() => setShown(true)}>mount</button>
          {shown && renderTimelineItem(e1, 0)}
        </>
      )
    }
    render(
      <ToolFocusContext.Provider value={focus}>
        <ChatViewContext.Provider
          value={{ ...baseView(), fileEditsOpenByDefault: false, timeline: [e1] }}
        >
          <Later />
        </ChatViewContext.Provider>
      </ToolFocusContext.Provider>
    )
    fireEvent.click(screen.getByText('mount'))
    expect(screen.getByTestId('diff-view')).toBeTruthy()
  })
})

function baseView(): ChatViewState {
  return {
    collapseSignal: 0,
    finalOnly: false,
    fileEditsOpenByDefault: true,
    showMessageMeta: true,
    search: { query: '', caseSensitive: false },
    timeline: [],
    childIndex: new Map()
  }
}

describe('files-changed panel', () => {
  it('one combined diff per file: before the first edit → after the last', () => {
    const timeline: TimelineItem[] = [
      { kind: 'user-text', text: 'go', timestamp: 0 },
      editTool('e1', '/repo/src/a.ts', 'one\n', 'two\n'),
      editTool('e2', '/repo/src/a.ts', 'two\n', 'three\n'),
      {
        kind: 'tool',
        invocation: {
          id: 'b1',
          name: 'Bash',
          input: { command: 'touch x' },
          status: 'done',
          result: { rawContent: '', structured: null, isError: false }
        },
        timestamp: 3
      }
    ]
    render(
      <FilesChangedPanel
        timeline={timeline}
        cwd="/repo"
        focusPath="/repo/src/a.ts"
        onClose={() => {}}
      />
    )
    const panel = screen.getByTestId('chat-files-panel')
    const file = within(panel).getByTestId('chat-files-panel-file')
    expect(file.getAttribute('data-path')).toBe('/repo/src/a.ts')
    expect(file.textContent).toContain('src/a.ts')
    const diff = within(file).getByTestId('diff-view')
    const changed = Array.from(diff.querySelectorAll('[data-line]'))
      .filter((l) => l.getAttribute('data-line') !== 'context')
      .map((l) => `${l.getAttribute('data-line')}:${l.textContent}`)
    expect(changed).toEqual(['delete:one', 'add:three'])
    expect(within(panel).getByTestId('chat-files-panel-shell-note').textContent).toMatch(
      /shell command/
    )
  })

  it('Esc closes it', () => {
    const onClose = vi.fn()
    render(<FilesChangedPanel timeline={[]} cwd="/repo" onClose={onClose} />)
    const panel = screen.getByTestId('chat-files-panel')
    expect(panel.textContent).toContain('No files changed')
    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
