/**
 * Codex file changes (`codex/fileChange`): parsed from the items real codex
 * 0.159.2 sent (`fake-codex/transcripts/file-change.jsonl`), and counted in the
 * turn's `files-changed` row like Claude's file tools (one Codex item can change
 * several files; a Codex shell command counts as a shell command).
 */
import { describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { recordedCodexItems } from '@slayzone/test-utils/fake-codex/recorded'
import { initialState, reducer, type TimelineItem } from './chat-timeline'
import {
  codexChangeContent,
  codexChangeCounts,
  codexChangeHunks,
  codexFileChanges,
  parseUnifiedHunks
} from './codex-file-changes'
import { fileChangesOf } from './turn-file-changes'

const RECIPE = 'file-change'
const TOOL: Record<string, string> = {
  commandExecution: 'codex/commandExecution',
  fileChange: 'codex/fileChange'
}

/** The recorded turn as the driver maps it: started item → tool-call, completed → tool-result. */
function recordedTurnEvents(): AgentEvent[] {
  const completed = recordedCodexItems(RECIPE, 'completed')
  const events: AgentEvent[] = [{ kind: 'user-message', text: 'make a note' }]
  for (const started of recordedCodexItems(RECIPE, 'started')) {
    const name = TOOL[started.type]
    if (!name) continue
    const done = completed.find((c) => c.id === started.id)
    events.push({ kind: 'tool-call', id: started.id, name, input: started })
    if (done) {
      events.push({
        kind: 'tool-result',
        toolUseId: started.id,
        isError: done.status === 'failed' || done.status === 'declined',
        rawContent: typeof done.aggregatedOutput === 'string' ? done.aggregatedOutput : '',
        structured: done
      })
    }
  }
  events.push({
    kind: 'result',
    subtype: 'completed',
    isError: false,
    durationMs: 1,
    durationApiMs: 1,
    numTurns: 1,
    totalCostUsd: 0,
    stopReason: null,
    terminalReason: null,
    text: null,
    modelUsage: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    },
    permissionDenials: []
  })
  return events
}

const timelineOf = (events: AgentEvent[]): TimelineItem[] =>
  reducer(initialState(), { type: 'events', events }).timeline

describe('Codex file change items', () => {
  test('parses the recorded add and update changes', () => {
    const items = recordedCodexItems(RECIPE, 'completed', 'fileChange')
    const [add, update] = items.map((item) =>
      codexFileChanges({
        id: item.id,
        name: 'codex/fileChange',
        input: null,
        status: 'done',
        result: { isError: false, rawContent: '', structured: item }
      })
    )
    expect(add).toEqual([{ path: '{{cwd}}/notes.txt', kind: 'add', diff: 'hello world\n' }])
    expect(codexChangeCounts(add[0])).toEqual({ additions: 1, deletions: 0 })
    expect(codexChangeContent(add[0])).toEqual({ before: '', after: 'hello world\n' })
    expect(update[0].kind).toBe('update')
    expect(codexChangeHunks(update[0])).toEqual([
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-hello world', '+hello codex']
      }
    ])
    expect(codexChangeContent(update[0])).toEqual({ before: null, after: null })
  })

  test('a move, a delete and an older bare-string kind', () => {
    const changes = codexFileChanges({
      id: 'c',
      name: 'codex/fileChange',
      input: {
        changes: [
          {
            path: '/r/a.ts',
            kind: { type: 'update', move_path: '/r/b.ts' },
            diff: '@@ -1 +1 @@\n-x\n+y\n'
          },
          { path: '/r/gone.ts', kind: { type: 'delete' }, diff: 'old\nlines\n' },
          { path: '/r/new.ts', kind: 'add', diff: 'n\n' }
        ]
      },
      status: 'pending'
    })
    expect(changes.map((c) => [c.path, c.movedFrom, c.kind])).toEqual([
      ['/r/b.ts', '/r/a.ts', 'update'],
      ['/r/gone.ts', undefined, 'delete'],
      ['/r/new.ts', undefined, 'add']
    ])
    expect(codexChangeCounts(changes[1])).toEqual({ additions: 0, deletions: 2 })
    expect(codexChangeContent(changes[1])).toEqual({ before: 'old\nlines\n', after: '' })
  })

  test('unified hunks: headers with counts, file headers and no-newline markers skipped', () => {
    expect(
      parseUnifiedHunks(
        '--- a/x\n+++ b/x\n@@ -2,3 +2,4 @@ fn\n a\n-b\n+c\n+d\n e\n\\ No newline at end of file\n'
      )
    ).toEqual([
      { oldStart: 2, oldLines: 3, newStart: 2, newLines: 4, lines: [' a', '-b', '+c', '+d', ' e'] }
    ])
  })
})

describe('the files-changed row of a Codex turn', () => {
  test('lists the recorded file, created, with summed counts; the command counts as a shell command', () => {
    const timeline = timelineOf(recordedTurnEvents())
    const row = timeline.find((it) => it.kind === 'files-changed')
    expect(row).toMatchObject({
      kind: 'files-changed',
      files: [
        {
          path: '{{cwd}}/notes.txt',
          additions: 2,
          deletions: 1,
          created: true,
          toolUseIds: recordedCodexItems(RECIPE, 'completed', 'fileChange').map((c) => c.id)
        }
      ],
      shellCommands: 1
    })
    // The row sits right before the turn's result.
    expect(timeline[timeline.length - 2].kind).toBe('files-changed')
  })

  test('one item changing two files gives two files; a declined change gives none', () => {
    const two = {
      kind: 'tool-result' as const,
      toolUseId: 'fc',
      isError: false,
      rawContent: '',
      structured: {
        type: 'fileChange',
        id: 'fc',
        status: 'completed',
        changes: [
          { path: '/r/a.ts', kind: { type: 'add' }, diff: 'a\n' },
          {
            path: '/r/b.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1 @@\n-x\n+y\n'
          }
        ]
      }
    }
    const declined = {
      kind: 'tool-result' as const,
      toolUseId: 'fd',
      isError: true,
      rawContent: '',
      structured: {
        type: 'fileChange',
        id: 'fd',
        status: 'declined',
        changes: [{ path: '/r/c.ts', kind: { type: 'add' }, diff: 'c\n' }]
      }
    }
    const events = recordedTurnEvents()
    const result = events.pop() as AgentEvent
    events.push(
      { kind: 'tool-call', id: 'fc', name: 'codex/fileChange', input: { changes: [] } },
      two,
      { kind: 'tool-call', id: 'fd', name: 'codex/fileChange', input: { changes: [] } },
      declined,
      result
    )
    const row = timelineOf(events).find((it) => it.kind === 'files-changed')
    expect(row?.kind === 'files-changed' && row.files.map((f) => f.path)).toEqual([
      '{{cwd}}/notes.txt',
      '/r/a.ts',
      '/r/b.ts'
    ])
    expect(row?.kind === 'files-changed' && row.id).toBe('files:fc')
  })

  test('fileChangesOf: one entry per changed file (Claude tools: their one file)', () => {
    expect(
      fileChangesOf({
        id: 'e',
        name: 'Edit',
        input: { file_path: '/r/x.ts' },
        status: 'done',
        result: {
          isError: false,
          rawContent: '',
          structured: {
            filePath: '/r/x.ts',
            structuredPatch: [
              { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
            ]
          }
        }
      })
    ).toEqual([{ path: '/r/x.ts', additions: 1, deletions: 1, created: false }])
  })
})
