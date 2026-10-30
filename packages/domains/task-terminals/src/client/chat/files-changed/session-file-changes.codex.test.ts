/**
 * The files-changed panel for Codex: every file Codex's file changes touched
 * (several per call), and one combined diff per file. Codex sends a new file's
 * whole content and hunks for an edit, so a file the conversation created is
 * known throughout (its edits chain from it); a file it only edited is not —
 * the panel then shows the edits one by one. Data: the items real codex 0.159.2
 * sent (`fake-codex/transcripts/file-change.jsonl`).
 */
import { describe, expect, test } from 'vitest'
import type { TimelineItem } from '@slayzone/terminal/client'
import { recordedCodexItems } from '@slayzone/test-utils/fake-codex/recorded'
import {
  collectSessionFileChanges,
  combinedFileDiff,
  countSessionFiles
} from './session-file-changes'

const lines = (diff: { hunks: Array<{ lines: Array<{ type: string; content: string }> }> }) =>
  diff.hunks.flatMap((h) => h.lines).map((l) => `${l.type}:${l.content}`)

function codexTool(item: Record<string, unknown>, status: 'done' | 'error' = 'done'): TimelineItem {
  return {
    kind: 'tool',
    invocation: {
      id: String(item.id),
      name: String(item.type) === 'fileChange' ? 'codex/fileChange' : 'codex/commandExecution',
      input: item,
      status,
      result: { isError: status === 'error', rawContent: '', structured: item }
    },
    timestamp: 1
  }
}

const recorded = (): TimelineItem[] =>
  recordedCodexItems('file-change', 'completed')
    .filter((it) => it.type === 'fileChange' || it.type === 'commandExecution')
    .map((it) => codexTool(it))

describe('Codex in the files-changed panel', () => {
  test('a created then edited file: one combined diff from nothing to its last content', () => {
    const session = collectSessionFileChanges(recorded())
    expect(session.shellCommands).toBe(1)
    expect(session.files.map((f) => [f.path, f.created, f.edits.length])).toEqual([
      ['{{cwd}}/notes.txt', true, 2]
    ])
    const combined = combinedFileDiff(session.files[0])
    expect(combined.mode).toBe('combined')
    if (combined.mode !== 'combined') return
    expect(lines(combined.diff)).toEqual(['add:hello codex'])
    expect(combined.diff.isNew).toBe(true)
    expect(countSessionFiles(recorded())).toBe(1)
  })

  test('a file only edited (content unknown): its edits one by one, each with its diff', () => {
    const edit = {
      type: 'fileChange',
      id: 'fc-1',
      status: 'completed',
      changes: [
        {
          path: '/r/a.ts',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1 +1 @@\n-x\n+y\n'
        },
        { path: '/r/b.ts', kind: { type: 'add' }, diff: 'b\n' }
      ]
    }
    const session = collectSessionFileChanges([codexTool(edit)])
    expect(session.files.map((f) => f.path)).toEqual(['/r/a.ts', '/r/b.ts'])
    const a = combinedFileDiff(session.files[0])
    expect(a.mode).toBe('separate')
    if (a.mode !== 'separate') return
    expect(a.why).toBe('unknown-content')
    expect(a.edits.map((e) => e.diff && lines(e.diff))).toEqual([['delete:x', 'add:y']])
    const b = combinedFileDiff(session.files[1])
    expect(b.mode === 'combined' && lines(b.diff)).toEqual(['add:b'])
  })

  test('a declined change is not in the panel', () => {
    const declined = {
      type: 'fileChange',
      id: 'fc-2',
      status: 'declined',
      changes: [{ path: '/r/c.ts', kind: { type: 'add' }, diff: 'c\n' }]
    }
    expect(collectSessionFileChanges([codexTool(declined, 'error')]).files).toEqual([])
  })
})
