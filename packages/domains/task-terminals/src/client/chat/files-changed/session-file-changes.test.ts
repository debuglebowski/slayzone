/**
 * The files-changed panel's data (chat E, plan 4.3): every file the agent's file
 * tools changed in the conversation, and one combined diff per file — the file
 * before its first edit against the file after its last.
 */
import { describe, expect, test } from 'vitest'
import type { TimelineItem } from '@slayzone/terminal/client'
import {
  collectSessionFileChanges,
  combinedFileDiff,
  type CombinedFileDiff,
  type SessionFileChange
} from './session-file-changes'

let n = 0
function tool(
  name: string,
  input: Record<string, unknown>,
  structured: unknown,
  opts: { status?: 'done' | 'error'; parentToolUseId?: string; id?: string } = {}
): TimelineItem {
  const id = opts.id ?? `t${++n}`
  return {
    kind: 'tool',
    invocation: {
      id,
      name,
      input,
      status: opts.status ?? 'done',
      result: { rawContent: 'ok', structured, isError: opts.status === 'error' }
    },
    timestamp: n,
    ...(opts.parentToolUseId ? { parentToolUseId: opts.parentToolUseId } : {})
  }
}

/** An Edit's result as the CLI reports it (the patch from `before` to `after`). */
function edit(path: string, before: string, oldString: string, newString: string): TimelineItem {
  const after = before.replace(oldString, newString)
  const beforeLines = before.split('\n')
  const at = beforeLines.findIndex((l) => l.includes(oldString))
  return tool(
    'Edit',
    { file_path: path, old_string: oldString, new_string: newString },
    {
      filePath: path,
      oldString,
      newString,
      originalFile: before,
      structuredPatch: [
        {
          oldStart: at + 1,
          oldLines: 1,
          newStart: at + 1,
          newLines: 1,
          lines: [`-${beforeLines[at]}`, `+${after.split('\n')[at]}`]
        }
      ],
      userModified: false,
      replaceAll: false
    }
  )
}

const user = (text: string): TimelineItem => ({ kind: 'user-text', text, timestamp: 0 })

function combined(change: SessionFileChange): Extract<CombinedFileDiff, { mode: 'combined' }> {
  const out = combinedFileDiff(change)
  if (out.mode !== 'combined') throw new Error(`expected a combined diff, got ${out.mode}`)
  return out
}
function separate(change: SessionFileChange): Extract<CombinedFileDiff, { mode: 'separate' }> {
  const out = combinedFileDiff(change)
  if (out.mode !== 'separate') throw new Error(`expected separate edits, got ${out.mode}`)
  return out
}

function lines(diff: {
  diff: { hunks: Array<{ lines: Array<{ type: string; content: string }> }> }
}): string[] {
  return diff.diff.hunks.flatMap((h) =>
    h.lines.map((l) => `${l.type === 'add' ? '+' : l.type === 'delete' ? '-' : ' '}${l.content}`)
  )
}

describe('collectSessionFileChanges', () => {
  test('one entry per file, edits in order; failures, reads and shell commands are not edits', () => {
    const v1 = 'a\nb\nc\n'
    const timeline: TimelineItem[] = [
      user('go'),
      edit('/r/x.ts', v1, 'b', 'B'),
      tool('Read', { file_path: '/r/y.ts' }, null),
      tool('Bash', { command: 'sed -i s/a/A/ x.ts' }, { stdout: '' }),
      tool('Edit', { file_path: '/r/z.ts' }, null, { status: 'error' }),
      tool(
        'Write',
        { file_path: '/r/new.ts', content: 'hello\n' },
        {
          type: 'create',
          filePath: '/r/new.ts',
          content: 'hello\n',
          structuredPatch: [],
          originalFile: null
        }
      ),
      edit('/r/x.ts', 'a\nB\nc\n', 'c', 'C')
    ]
    const { files, shellCommands } = collectSessionFileChanges(timeline)
    expect(shellCommands).toBe(1)
    expect(files.map((f) => [f.path, f.edits.length, f.created])).toEqual([
      ['/r/x.ts', 2, false],
      ['/r/new.ts', 1, true]
    ])
  })

  test('what a rewind or a switch folded away is not in the conversation any more', () => {
    const timeline: TimelineItem[] = [
      user('one'),
      edit('/r/kept.ts', 'a\n', 'a', 'b'),
      user('two'),
      edit('/r/gone.ts', 'a\n', 'a', 'b'),
      {
        kind: 'conversation-branch',
        id: 'branch-4',
        reason: 'rewound',
        hiddenFrom: 2,
        hiddenCount: 2,
        timestamp: 5
      }
    ]
    expect(collectSessionFileChanges(timeline).files.map((f) => f.path)).toEqual(['/r/kept.ts'])
  })

  test("a sub-agent's edit is marked nested (its card sits inside the sub-agent row)", () => {
    const timeline: TimelineItem[] = [
      user('go'),
      tool('Task', { subagent_type: 'x' }, null, { id: 'task1' }),
      { ...edit('/r/a.ts', 'a\n', 'a', 'b'), parentToolUseId: 'task1' } as TimelineItem
    ]
    expect(collectSessionFileChanges(timeline).files[0].edits[0].nested).toBe(true)
  })
})

describe('combinedFileDiff', () => {
  test('first edit before → last edit after, as one diff', () => {
    const v1 = 'one\ntwo\nthree\nfour\n'
    const v2 = v1.replace('two', 'TWO')
    const { files } = collectSessionFileChanges([
      user('go'),
      edit('/r/x.ts', v1, 'two', 'TWO'),
      edit('/r/x.ts', v2, 'four', 'FOUR')
    ])
    const c = combined(files[0])
    expect(c.outsideChanges).toBe(false)
    expect(lines(c).filter((l) => l[0] !== ' ')).toHaveLength(4)
    expect(lines(c)).toEqual(expect.arrayContaining(['-two', '+TWO', '-four', '+FOUR']))
  })

  test('an edit undone by a later one leaves no change', () => {
    const v1 = 'a\nb\n'
    const { files } = collectSessionFileChanges([
      user('go'),
      edit('/r/x.ts', v1, 'b', 'B'),
      edit('/r/x.ts', 'a\nB\n', 'B', 'b')
    ])
    expect(lines(combined(files[0])).filter((l) => l[0] !== ' ')).toEqual([])
  })

  test('a created file: everything is added, and it says new', () => {
    const { files } = collectSessionFileChanges([
      user('go'),
      tool(
        'Write',
        { file_path: '/r/n.ts', content: 'x\ny\n' },
        {
          type: 'create',
          filePath: '/r/n.ts',
          content: 'x\ny\n',
          structuredPatch: [],
          originalFile: null
        }
      ),
      edit('/r/n.ts', 'x\ny\n', 'y', 'Y')
    ])
    const c = combined(files[0])
    expect(c.diff.isNew).toBe(true)
    expect(lines(c)).toEqual(['+x', '+Y'])
  })

  test('a change between two edits (a shell command, the user) is flagged', () => {
    const { files } = collectSessionFileChanges([
      user('go'),
      edit('/r/x.ts', 'a\nb\n', 'b', 'B'),
      // The second edit saw `a` already changed to `A` by someone else.
      edit('/r/x.ts', 'A\nB\n', 'B', 'BB')
    ])
    const c = combined(files[0])
    expect(c.outsideChanges).toBe(true)
    expect(lines(c)).toContain('+A')
  })

  test("without the file's content before the first edit: the edits one by one", () => {
    const noOriginal = tool(
      'Edit',
      { file_path: '/r/x.ts' },
      {
        filePath: '/r/x.ts',
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
        ]
      }
    )
    const { files } = collectSessionFileChanges([user('go'), noOriginal])
    const s = separate(files[0])
    expect(s.why).toBe('unknown-content')
    expect(s.edits).toHaveLength(1)
    expect(s.edits[0].diff?.hunks[0].lines.map((l) => l.content)).toEqual(['a', 'b'])
  })

  test('a notebook: its cell edits one by one', () => {
    const { files } = collectSessionFileChanges([
      user('go'),
      tool(
        'NotebookEdit',
        { notebook_path: '/r/n.ipynb', cell_id: 'c1', new_source: 'x = 2' },
        { notebook_path: '/r/n.ipynb', cell_id: 'c1', new_source: 'x = 2', old_source: 'x = 1' }
      )
    ])
    const s = separate(files[0])
    expect(s.why).toBe('notebook')
    expect(s.edits[0].diff).not.toBeNull()
  })
})
