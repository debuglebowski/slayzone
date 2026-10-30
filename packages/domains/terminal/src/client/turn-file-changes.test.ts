/**
 * The `files-changed` row (chat E, plan 4.3): at the end of each turn, which
 * files the agent's own file tools changed — built by the reducer from the
 * turn's Edit / Write / MultiEdit / NotebookEdit results, so a reload (a replay
 * of the same events) shows the same row.
 */
import { describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { initialState, reducer, type TimelineItem } from './chat-timeline'
import { fileChangeOf } from './turn-file-changes'

const call = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  parentToolUseId?: string
): AgentEvent => ({
  kind: 'tool-call',
  id,
  name,
  input,
  ...(parentToolUseId ? { parentToolUseId } : {})
})
const done = (
  toolUseId: string,
  structured: unknown,
  opts: { isError?: boolean; parentToolUseId?: string } = {}
): AgentEvent => ({
  kind: 'tool-result',
  toolUseId,
  isError: opts.isError ?? false,
  rawContent: 'ok',
  structured,
  ...(opts.parentToolUseId ? { parentToolUseId: opts.parentToolUseId } : {})
})
const turnEnd = (permissionDenials: unknown[] = []): AgentEvent => ({
  kind: 'result',
  subtype: 'success',
  isError: false,
  durationMs: 1,
  durationApiMs: 1,
  numTurns: 1,
  totalCostUsd: 0,
  stopReason: 'end_turn',
  terminalReason: 'completed',
  text: 'ok',
  modelUsage: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  permissionDenials
})
const user = (text: string): AgentEvent => ({ kind: 'user-message', text })

const editResult = (filePath: string, lines: string[]) => ({
  filePath,
  oldString: 'a',
  newString: 'b',
  originalFile: 'a\n',
  structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }],
  userModified: false,
  replaceAll: false
})

function play(events: AgentEvent[]): TimelineItem[] {
  return reducer(initialState(), { type: 'events', events }).timeline
}

const rows = (timeline: TimelineItem[]) =>
  timeline.filter(
    (it): it is Extract<TimelineItem, { kind: 'files-changed' }> => it.kind === 'files-changed'
  )

describe('files-changed row', () => {
  test('lists the files the turn changed, before its result', () => {
    const timeline = play([
      user('change things'),
      call('e1', 'Edit', { file_path: '/repo/a.ts' }),
      done('e1', editResult('/repo/a.ts', ['-a', '+b', '+c'])),
      call('w1', 'Write', { file_path: '/repo/new.ts', content: 'x\ny\n' }),
      done('w1', {
        type: 'create',
        filePath: '/repo/new.ts',
        content: 'x\ny\n',
        structuredPatch: [],
        originalFile: null
      }),
      call('b1', 'Bash', { command: 'touch z' }),
      done('b1', { stdout: '' }),
      call('e2', 'Edit', { file_path: '/repo/a.ts' }),
      done('e2', editResult('/repo/a.ts', ['-c', '+d'])),
      call('e3', 'Edit', { file_path: '/repo/broken.ts' }),
      done('e3', null, { isError: true }),
      turnEnd()
    ])
    const [row] = rows(timeline)
    expect(row).toMatchObject({
      id: 'files:e2',
      shellCommands: 1,
      files: [
        {
          path: '/repo/a.ts',
          toolUseIds: ['e1', 'e2'],
          additions: 3,
          deletions: 2,
          created: false
        },
        { path: '/repo/new.ts', toolUseIds: ['w1'], additions: 2, deletions: 0, created: true }
      ]
    })
    // The turn's last rows: the summary, then the result footer.
    expect(timeline.at(-2)).toBe(row)
    expect(timeline.at(-1)?.kind).toBe('result')
  })

  test('a turn that changed no file has no row', () => {
    const timeline = play([
      user('look'),
      call('b1', 'Bash', { command: 'ls' }),
      done('b1', { stdout: 'a' }),
      call('r1', 'Read', { file_path: '/repo/a.ts' }),
      done('r1', null),
      turnEnd()
    ])
    expect(rows(timeline)).toEqual([])
  })

  test("each turn lists only its own changes; a sub-agent's edits count", () => {
    const timeline = play([
      user('one'),
      call('e1', 'Edit', { file_path: '/repo/a.ts' }),
      done('e1', editResult('/repo/a.ts', ['-a', '+b'])),
      turnEnd(),
      user('two'),
      call('task1', 'Task', { subagent_type: 'general' }),
      call('e2', 'Edit', { file_path: '/repo/b.ts' }, 'task1'),
      done('e2', editResult('/repo/b.ts', ['+x']), { parentToolUseId: 'task1' }),
      done('task1', null),
      turnEnd()
    ])
    const [first, second] = rows(timeline)
    expect(first.files.map((f) => f.path)).toEqual(['/repo/a.ts'])
    expect(second.files.map((f) => f.path)).toEqual(['/repo/b.ts'])
    expect(second.id).toBe('files:e2')
  })

  test('a denied call changed nothing', () => {
    const timeline = play([
      user('edit'),
      call('e1', 'Edit', { file_path: '/repo/a.ts' }),
      done('e1', editResult('/repo/a.ts', ['+b'])),
      turnEnd([{ tool_use_id: 'e1' }])
    ])
    expect(rows(timeline)).toEqual([])
  })

  test('Codex file changes are not Claude file tools: no row', () => {
    const timeline = play([
      user('codex'),
      call('c1', 'codex/fileChange', { changes: [] }),
      done('c1', { changes: [] }),
      turnEnd()
    ])
    expect(rows(timeline)).toEqual([])
  })

  test('replaying the same events builds the same row (reload)', () => {
    const events = [
      user('x'),
      call('e1', 'Edit', { file_path: '/repo/a.ts' }),
      done('e1', editResult('/repo/a.ts', ['+b'])),
      turnEnd()
    ]
    expect(rows(play(events))).toEqual(rows(play(events)))
  })
})

describe('fileChangeOf', () => {
  const inv = (name: string, input: unknown, structured: unknown) => ({
    id: 't',
    name,
    input,
    status: 'done' as const,
    result: { rawContent: 'ok', structured, isError: false }
  })

  test('an overwrite counts its patch; a notebook cell has no line counts', () => {
    expect(
      fileChangeOf(
        inv(
          'Write',
          { file_path: '/r/a' },
          {
            type: 'update',
            filePath: '/r/a',
            content: 'n',
            structuredPatch: [
              { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-o', '+n'] }
            ]
          }
        )
      )
    ).toEqual({ path: '/r/a', additions: 1, deletions: 1, created: false })
    expect(
      fileChangeOf(
        inv(
          'NotebookEdit',
          { notebook_path: '/r/n.ipynb', new_source: 'x' },
          { notebook_path: '/r/n.ipynb', new_source: 'x' }
        )
      )
    ).toEqual({ path: '/r/n.ipynb', additions: null, deletions: null, created: false })
  })

  test('nothing for other tools, failures and calls without a result', () => {
    expect(fileChangeOf(inv('Read', { file_path: '/r/a' }, null))).toBeNull()
    expect(
      fileChangeOf({
        ...inv('Edit', { file_path: '/r/a' }, null),
        status: 'error',
        result: { rawContent: 'no', structured: null, isError: true }
      })
    ).toBeNull()
    expect(
      fileChangeOf({ id: 't', name: 'Edit', input: { file_path: '/r/a' }, status: 'pending' })
    ).toBeNull()
  })
})
