// Pins per-instance panel handles (docs/plans/panel-model.md step 7): a stable ref
// per instance, work queued for a panel that is not mounted yet runs once it is.
import { describe, expect, it, vi } from 'vitest'
import { InstanceHandles } from './instanceHandles'

describe('InstanceHandles', () => {
  it('keeps one ref callback per instance and resolves handles by id', () => {
    const handles = new InstanceHandles<{ name: string }>()
    expect(handles.ref('a')).toBe(handles.ref('a'))
    handles.ref('a')({ name: 'A' })
    handles.ref('b')({ name: 'B' })
    expect(handles.get('a')?.name).toBe('A')
    expect(handles.get('b')?.name).toBe('B')
    handles.ref('a')(null)
    expect(handles.get('a')).toBeNull()
    expect(handles.get(null)).toBeNull()
  })

  it('whenReady runs now on a mounted panel, else once it mounts (in order)', () => {
    const handles = new InstanceHandles<{ open: (f: string) => void }>()
    const open = vi.fn()
    handles.whenReady('editor:x', (h) => h.open('one'))
    handles.whenReady('editor:x', (h) => h.open('two'))
    expect(open).not.toHaveBeenCalled()
    handles.ref('editor:x')({ open })
    expect(open.mock.calls).toEqual([['one'], ['two']])
    handles.whenReady('editor:x', (h) => h.open('three'))
    expect(open).toHaveBeenCalledTimes(3)
  })

  it('forget drops a closed instance and the work queued for it', () => {
    const handles = new InstanceHandles<{ open: () => void }>()
    const open = vi.fn()
    handles.whenReady('editor:x', (h) => h.open())
    handles.forget('editor:x')
    handles.ref('editor:x')({ open })
    expect(open).not.toHaveBeenCalled()
  })
})
