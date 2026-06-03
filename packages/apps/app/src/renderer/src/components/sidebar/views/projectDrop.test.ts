/**
 * resolveProjectDrop — the shared drag-drop decision matrix for both views.
 * Pure, no electron/react. Run: npx tsx .../views/projectDrop.test.ts
 */
import type { TopLevelEntryRef } from '@slayzone/projects/shared'
import { test, expect, describe } from '../../../../../../../../shared/test-utils/ipc-harness.js'
import {
  resolveProjectDrop,
  dropModeFromPointer,
  pointerYFromEvent,
  type DropInput,
  type DropMode
} from './projectDrop.js'

// Scenario: top level = [pA, G(=[m1,m2]), pB]; refs order pA, G, pB.
const TOP: TopLevelEntryRef[] = [
  { kind: 'project', id: 'pA' },
  { kind: 'group', id: 'G' },
  { kind: 'project', id: 'pB' }
]
const MEMBERS: Record<string, string[]> = { G: ['m1', 'm2'] }
const members = (g: string): string[] => MEMBERS[g] ?? []

function input(partial: {
  active: DropInput['active']
  over: DropInput['over']
  mode: DropMode
}): DropInput {
  return { ...partial, topLevel: TOP, members }
}

await describe('dropModeFromPointer (pointer, not dragged-rect center)', async () => {
  const rect = { top: 100, height: 30 } // thirds: <110 before, >120 after, else merge
  test('top third → before', () => expect(dropModeFromPointer(104, rect)).toBe('before'))
  test('middle third → merge', () => expect(dropModeFromPointer(115, rect)).toBe('merge'))
  test('bottom third → after', () => expect(dropModeFromPointer(126, rect)).toBe('after'))
  test('null pointer → merge', () => expect(dropModeFromPointer(null, rect)).toBe('merge'))
  test('pointerYFromEvent = activator clientY + delta.y', () => {
    expect(pointerYFromEvent({ activatorEvent: { clientY: 200 } as Event, delta: { y: 15 } })).toBe(215)
    expect(pointerYFromEvent({ activatorEvent: null, delta: { y: 15 } })).toBeNull()
  })
})

await describe('resolveProjectDrop', async () => {
  test('top-level project onto top-level project MIDDLE → createFolder [target, dragged]', () => {
    const a = resolveProjectDrop(
      input({ active: { id: 'pA', group: null }, over: { kind: 'project', id: 'pB', group: null }, mode: 'merge' })
    )
    expect(a).toEqual({ type: 'createFolder', projectIds: ['pB', 'pA'] })
  })

  test('project onto group MIDDLE → join at end', () => {
    const a = resolveProjectDrop(
      input({ active: { id: 'pA', group: null }, over: { kind: 'group', id: 'G', group: null }, mode: 'merge' })
    )
    expect(a).toEqual({ type: 'join', groupId: 'G', projectId: 'pA', index: 2 })
  })

  test('project onto group BOTTOM edge (after) → reorderTop around the folder', () => {
    const a = resolveProjectDrop(
      input({ active: { id: 'pA', group: null }, over: { kind: 'group', id: 'G', group: null }, mode: 'after' })
    )
    expect(a.type).toBe('reorderTop')
    if (a.type === 'reorderTop') {
      expect(a.refs.map((r) => `${r.kind}:${r.id}`)).toEqual(['group:G', 'project:pA', 'project:pB'])
    }
  })

  test('member onto group edge → moveOut to top level around the folder', () => {
    const a = resolveProjectDrop(
      input({ active: { id: 'm1', group: 'G' }, over: { kind: 'group', id: 'G', group: null }, mode: 'before' })
    )
    expect(a).toEqual({ type: 'moveOut', projectId: 'm1', index: 1 })
  })

  test('project onto member MIDDLE (diff group) → join at member index', () => {
    const a = resolveProjectDrop(
      input({ active: { id: 'pA', group: null }, over: { kind: 'project', id: 'm2', group: 'G' }, mode: 'merge' })
    )
    expect(a).toEqual({ type: 'join', groupId: 'G', projectId: 'pA', index: 1 })
  })

  test('member reordered within its group (after m2)', () => {
    const a = resolveProjectDrop(
      input({ active: { id: 'm1', group: 'G' }, over: { kind: 'project', id: 'm2', group: 'G' }, mode: 'after' })
    )
    expect(a).toEqual({ type: 'reorderWithin', groupId: 'G', projectIds: ['m2', 'm1'] })
  })

  test('member dragged onto top-level row edge → moveOut at that slot', () => {
    const a = resolveProjectDrop(
      input({ active: { id: 'm1', group: 'G' }, over: { kind: 'project', id: 'pB', group: null }, mode: 'before' })
    )
    // pB is index 2 in top level
    expect(a).toEqual({ type: 'moveOut', projectId: 'm1', index: 2 })
  })

  test('top-level reorder: pB before pA', () => {
    const a = resolveProjectDrop(
      input({ active: { id: 'pB', group: null }, over: { kind: 'project', id: 'pA', group: null }, mode: 'before' })
    )
    expect(a.type).toBe('reorderTop')
    if (a.type === 'reorderTop') {
      expect(a.refs.map((r) => `${r.kind}:${r.id}`)).toEqual(['project:pB', 'project:pA', 'group:G'])
    }
  })

  test('folder dragged → reorderTop (merge ignored)', () => {
    const merge = resolveProjectDrop(
      input({ active: { id: 'G', group: null, isGroup: true }, over: { kind: 'project', id: 'pA', group: null }, mode: 'merge' })
    )
    expect(merge).toEqual({ type: 'none' })
    const line = resolveProjectDrop(
      input({ active: { id: 'G', group: null, isGroup: true }, over: { kind: 'project', id: 'pB', group: null }, mode: 'after' })
    )
    expect(line.type).toBe('reorderTop')
    if (line.type === 'reorderTop') {
      expect(line.refs.map((r) => `${r.kind}:${r.id}`)).toEqual(['project:pA', 'project:pB', 'group:G'])
    }
  })

  test('no-ops: self, join own group, folder onto member', () => {
    expect(
      resolveProjectDrop(
        input({ active: { id: 'pA', group: null }, over: { kind: 'project', id: 'pA', group: null }, mode: 'merge' })
      )
    ).toEqual({ type: 'none' })
    expect(
      resolveProjectDrop(
        input({ active: { id: 'm1', group: 'G' }, over: { kind: 'group', id: 'G', group: null }, mode: 'merge' })
      )
    ).toEqual({ type: 'none' })
    expect(
      resolveProjectDrop(
        input({ active: { id: 'G', group: null, isGroup: true }, over: { kind: 'project', id: 'm1', group: 'G' }, mode: 'before' })
      )
    ).toEqual({ type: 'none' })
  })
})
