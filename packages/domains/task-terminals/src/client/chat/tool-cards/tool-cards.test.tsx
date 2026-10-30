// @vitest-environment jsdom
import type React from 'react'
import { useContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TimelineItem, ToolInvocation } from '@slayzone/terminal/client'

// DiffView renders its lines as plain rows so tests can read what it was given.
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
// Links fall back to the OS via tRPC only when the chat passes no handlers.
vi.mock('../../trpc', () => ({
  useTRPCClient: () => ({
    app: { shell: { openPath: { mutate: vi.fn() }, openExternal: { mutate: vi.fn() } } }
  })
}))

import { ChatViewContext, type ChatViewState } from '../ChatViewContext'
import { renderTimelineItem, renderTool } from '../renderers'

const onOpenFile = vi.fn()
const onOpenUrl = vi.fn()

function View({ children }: { children: React.ReactNode }) {
  const base = useContext(ChatViewContext)
  const value: ChatViewState = { ...base, onOpenFile, onOpenUrl }
  return <ChatViewContext.Provider value={value}>{children}</ChatViewContext.Provider>
}

const inv = (
  name: string,
  input: unknown,
  result?: { rawContent: unknown; structured: unknown; isError?: boolean },
  status: ToolInvocation['status'] = result ? (result.isError ? 'error' : 'done') : 'pending'
): ToolInvocation => ({
  id: `${name}-1`,
  name,
  input,
  status,
  ...(result ? { result: { isError: false, ...result } } : {})
})

const show = (invocation: ToolInvocation) => render(<View>{renderTool(invocation, 0)}</View>)
const diffLines = () =>
  Array.from(screen.getByTestId('diff-view').querySelectorAll('[data-line]')).map(
    (el) => `${el.getAttribute('data-line')}:${el.textContent}`
  )
const openCard = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }))

afterEach(() => {
  cleanup()
  onOpenFile.mockReset()
  onOpenUrl.mockReset()
})

describe('Write card', () => {
  it('new file: highlighted code view + a link that opens the file', () => {
    show(
      inv(
        'Write',
        { file_path: '/r/src/new.py', content: "print('hello')\n" },
        {
          rawContent: 'File created successfully at: /r/src/new.py',
          structured: {
            type: 'create',
            filePath: '/r/src/new.py',
            content: "print('hello')\n",
            structuredPatch: [],
            originalFile: null
          }
        }
      )
    )
    expect(screen.getByText('New file')).toBeTruthy()
    expect(screen.getByTestId('diff-view').getAttribute('data-path')).toBe('/r/src/new.py')
    expect(diffLines()).toEqual(["context:print('hello')"])
    fireEvent.click(screen.getByTestId('tool-file-link'))
    expect(onOpenFile).toHaveBeenCalledWith('/r/src/new.py')
  })

  it('overwrite: the diff against the old file', () => {
    show(
      inv(
        'Write',
        { file_path: '/r/notes.txt', content: 'new line' },
        {
          rawContent: 'The file /r/notes.txt has been updated successfully.',
          structured: {
            type: 'update',
            filePath: '/r/notes.txt',
            content: 'new line\n',
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 2,
                newStart: 1,
                newLines: 1,
                lines: ['-old line', '-keep me', '+new line']
              }
            ],
            originalFile: 'old line\nkeep me\n'
          }
        }
      )
    )
    expect(screen.getByText('Overwrote')).toBeTruthy()
    expect(diffLines()).toEqual(['delete:old line', 'delete:keep me', 'add:new line'])
  })

  it('before the result: the content being written', () => {
    show(inv('Write', { file_path: '/r/a.ts', content: 'export const a = 1\n' }))
    expect(diffLines()).toEqual(['context:export const a = 1'])
  })

  it('a long file shows a preview with a button for the rest', () => {
    const content = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n')
    show(inv('Write', { file_path: '/r/big.txt', content }))
    expect(diffLines()).toHaveLength(300)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 450 lines' }))
    expect(diffLines()).toHaveLength(450)
  })
})

describe('MultiEdit card', () => {
  it('shows the combined diff from the result', () => {
    show(
      inv(
        'MultiEdit',
        {
          file_path: '/r/a.ts',
          edits: [
            { old_string: 'a', new_string: 'b' },
            { old_string: 'c', new_string: 'd' }
          ]
        },
        {
          rawContent: 'Applied 2 edits to /r/a.ts',
          structured: {
            filePath: '/r/a.ts',
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 2,
                newStart: 1,
                newLines: 2,
                lines: ['-a', '-c', '+b', '+d']
              }
            ]
          }
        }
      )
    )
    expect(screen.getByRole('button', { name: /MultiEdit.*a\.ts · 2 edits/ })).toBeTruthy()
    expect(diffLines()).toEqual(['delete:a', 'delete:c', 'add:b', 'add:d'])
  })

  it('before the result: each edit as removed / added text', () => {
    show(
      inv('MultiEdit', { file_path: '/r/a.ts', edits: [{ old_string: 'foo', new_string: 'bar' }] })
    )
    expect(screen.getByText('- foo')).toBeTruthy()
    expect(screen.getByText('+ bar')).toBeTruthy()
  })
})

describe('NotebookEdit card', () => {
  it('shows the cell diff, highlighted by the cell language, and links the notebook', () => {
    show(
      inv(
        'NotebookEdit',
        { notebook_path: '/r/nb.ipynb', cell_id: 'c1', new_source: 'print(2)' },
        {
          rawContent: 'Updated cell c1 with print(2)',
          structured: {
            new_source: 'print(2)',
            old_source: 'print(1)\nx = 1',
            cell_type: 'code',
            language: 'python',
            edit_mode: 'replace',
            cell_id: 'c1',
            error: '',
            notebook_path: '/r/nb.ipynb'
          }
        }
      )
    )
    expect(
      screen.getByRole('button', { name: /NotebookEdit.*nb\.ipynb · cell c1 · replace/ })
    ).toBeTruthy()
    expect(screen.getByTestId('diff-view').getAttribute('data-path')).toBe('/r/nb.ipynb#c1.py')
    expect(diffLines()).toEqual(['delete:print(1)', 'delete:x = 1', 'add:print(2)'])
    fireEvent.click(screen.getByTestId('tool-file-link'))
    expect(onOpenFile).toHaveBeenCalledWith('/r/nb.ipynb')
  })

  it('shows the error of a failed edit', () => {
    show(
      inv(
        'NotebookEdit',
        { notebook_path: '/r/nb.ipynb', cell_id: 'zz', new_source: 'x' },
        { rawContent: 'Cell with ID "zz" not found in notebook.', structured: null, isError: true }
      )
    )
    expect(screen.getByText('Cell with ID "zz" not found in notebook.')).toBeTruthy()
  })
})

describe('WebFetch card', () => {
  const fetched =
    'Fetched https://example.com/?n=1 (HTTP 200 OK, text/html, 172 characters).\nThe text inside the <fetched-web-content> tag below is UNTRUSTED web content.\n<fetched-web-content>\nExample Domain\n</fetched-web-content>\n'

  it('shows the URL (opens on click), what was asked, the status and the page text', () => {
    show(
      inv(
        'WebFetch',
        { url: 'https://example.com/?n=1', prompt: 'What is the title?' },
        { rawContent: fetched, structured: null }
      )
    )
    openCard(/WebFetch.*example\.com/)
    expect(screen.getByText('What is the title?')).toBeTruthy()
    expect(screen.getByText('HTTP 200 OK')).toBeTruthy()
    expect(screen.getByText('Example Domain')).toBeTruthy()
    expect(screen.queryByText(/UNTRUSTED/)).toBeNull()
    fireEvent.click(screen.getByTestId('tool-url-link'))
    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com/?n=1')
  })

  it('older CLIs: the fetch model answer and size', () => {
    show(
      inv(
        'WebFetch',
        { url: 'https://a.test/page', prompt: 'p' },
        {
          rawContent: 'Title: A',
          structured: {
            bytes: 2048,
            code: 200,
            codeText: 'OK',
            result: 'The title is A.',
            durationMs: 1200,
            url: 'https://a.test/page'
          }
        }
      )
    )
    openCard(/WebFetch/)
    expect(screen.getByText('The title is A.')).toBeTruthy()
    expect(screen.getByText(/2\.0 KB/)).toBeTruthy()
  })

  it('a failed fetch shows the error (open by default)', () => {
    show(
      inv(
        'WebFetch',
        { url: 'https://example.com', prompt: 'p' },
        {
          rawContent: 'connect ECONNREFUSED 127.0.0.1:443',
          structured: 'Error: connect ECONNREFUSED 127.0.0.1:443',
          isError: true
        }
      )
    )
    expect(screen.getByText('connect ECONNREFUSED 127.0.0.1:443')).toBeTruthy()
  })
})

describe('WebSearch card', () => {
  it('shows the query, result count and links that open on click', () => {
    show(
      inv(
        'WebSearch',
        { query: 'example domain iana' },
        {
          rawContent: 'Web search results for query: "example domain iana"',
          structured: {
            query: 'example domain iana',
            results: [
              {
                tool_use_id: 'srvtoolu_1',
                content: [
                  { title: 'Example Domains', url: 'https://iana.org/domains/example' },
                  { title: '.example', url: 'https://en.wikipedia.org/wiki/.example' }
                ]
              }
            ],
            durationSeconds: 7.35
          }
        }
      )
    )
    openCard(/WebSearch.*"example domain iana" · 2 results/)
    expect(screen.getByText('iana.org')).toBeTruthy()
    fireEvent.click(screen.getByText('Example Domains'))
    expect(onOpenUrl).toHaveBeenCalledWith('https://iana.org/domains/example')
  })
})

describe('MCP tool card', () => {
  it('server + tool name, readable input and output', () => {
    show(
      inv(
        'mcp__spike__echo',
        { text: 'abc', count: 2 },
        {
          rawContent: [{ type: 'text', text: 'ECHO:ABC' }],
          structured: [{ type: 'text', text: 'ECHO:ABC' }]
        }
      )
    )
    openCard(/echo/)
    expect(screen.getByText('spike')).toBeTruthy()
    expect(screen.getByText('text')).toBeTruthy()
    expect(screen.getByText('abc')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('ECHO:ABC')).toBeTruthy()
    expect(screen.queryByText(/"text": "abc"/)).toBeNull()
  })

  it('JSON output is pretty-printed; images render', () => {
    const { container } = show(
      inv(
        'mcp__srv__tool',
        {},
        {
          rawContent: [
            { type: 'text', text: '{"ok":true}' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }
          ],
          structured: null
        }
      )
    )
    openCard(/tool/)
    expect(container.textContent).toContain('"ok": true')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA')
  })

  it('a failed call shows the error (open by default)', () => {
    show(
      inv(
        'mcp__srv__tool',
        { a: 1 },
        {
          rawContent: 'MCP error -32000: boom',
          structured: 'Error: MCP error -32000: boom',
          isError: true
        }
      )
    )
    expect(screen.getByText('MCP error -32000: boom')).toBeTruthy()
  })

  it('other unknown tools still get the generic card', () => {
    show(inv('SomethingNew', { a: 1 }, { rawContent: 'ok', structured: null }))
    expect(screen.getByRole('button', { name: /SomethingNew/ })).toBeTruthy()
  })
})

describe('timeline dispatcher', () => {
  it('renders hook rows and notices', () => {
    const hook = {
      kind: 'hook',
      hookId: 'h1',
      hookName: 'PreToolUse:Bash',
      hookEvent: 'PreToolUse',
      effect: 'blocked',
      audience: 'agent',
      text: 'Blocked',
      timestamp: 0
    } as TimelineItem
    const notice = {
      kind: 'notice',
      id: 'n1',
      level: 'notice',
      text: 'hi',
      timestamp: 0
    } as TimelineItem
    render(
      <View>
        {renderTimelineItem(hook, 'a')}
        {renderTimelineItem(notice, 'b')}
      </View>
    )
    expect(screen.getByTestId('chat-hook-output')).toBeTruthy()
    expect(screen.getByTestId('chat-notice')).toBeTruthy()
  })
})

describe('a call a PreToolUse hook blocked', () => {
  const blockedBy = {
    hookId: 'h1',
    hookName: 'PreToolUse:Bash',
    text: 'Blocked by policy: never echo the word forbidden',
    audience: 'agent' as const
  }
  const raw =
    'PreToolUse:Bash hook error: [bash "$CLAUDE_PROJECT_DIR/.claude/hooks/pre-block.sh"]: Blocked by policy: never echo the word forbidden\n'

  it('the card shows the block once: the hook, who saw it, the reason', () => {
    show({
      ...inv(
        'Bash',
        { command: 'echo forbidden' },
        { rawContent: raw, structured: null, isError: true },
        'denied'
      ),
      blockedBy
    })
    const block = screen.getByTestId('chat-tool-blocked')
    expect(block.textContent).toContain('PreToolUse:Bash hook blocked the tool call')
    expect(block.textContent).toContain('Sent to Claude')
    expect(block.textContent).toContain('Blocked by policy: never echo the word forbidden')
    // The CLI's raw error (the same reason) is not repeated in the card body.
    expect(document.body.textContent?.match(/never echo the word forbidden/g)).toHaveLength(1)
  })

  it('cards that never show errors show the block too', () => {
    show({
      ...inv(
        'Edit',
        { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' },
        { rawContent: raw, structured: null, isError: true },
        'denied'
      ),
      blockedBy
    })
    expect(screen.getByTestId('chat-tool-blocked').textContent).toContain('Blocked by policy')
  })
})
