// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ChatAttachment } from '@slayzone/terminal-contracts'
import type { ImageCodec } from './prepare-attachment'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  uploadFiles: vi.fn<(files: File[]) => Promise<Array<{ id: string; title: string }>>>()
}))

let uuid = 0
vi.mock('@slayzone/ui', async () => ({
  ...(await vi.importActual<object>('../../../../../../shared/ui/src/use-stable-callback')),
  toast: mocks.toast,
  safeRandomUUID: () => `k${++uuid}`
}))
vi.mock('@slayzone/editor/hooks', async () => ({
  ...(await vi.importActual<object>('../../../../../../shared/editor/src/use-image-paste-drop')),
  useArtifactUpload: () => ({ uploadFiles: mocks.uploadFiles, getFilePath: async () => null })
}))

import { useChatAttachments } from './useChatAttachments'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const codec: ImageCodec = {
  size: async () => ({ width: 100, height: 100 }),
  encode: async (b) => b
}
const png = (name = 'shot.png') => new File([PNG], name, { type: 'image/png' })
const text = (name = 'notes.md') => new File(['# hi\n'], name, { type: 'text/markdown' })
const docx = () => new File([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])], 'r.docx')

function setup(mode: 'claude-chat' | 'codex-chat') {
  const added: ChatAttachment[][] = []
  const hook = renderHook(() =>
    useChatAttachments({ taskId: 'task-1', mode, onAdded: (a) => added.push(a), codec })
  )
  return { hook, added }
}

beforeEach(() => {
  mocks.toast.mockReset()
  mocks.uploadFiles
    .mockReset()
    .mockImplementation(async (files) =>
      files.map((f, i) => ({ id: `art-${f.name}-${i}`, title: f.name }))
    )
})
afterEach(cleanup)

describe('useChatAttachments (Claude: images, PDFs, text)', () => {
  it('checks each file, uploads what can be sent, adds it in order as a reference', async () => {
    const { hook, added } = setup('claude-chat')
    await act(() => hook.result.current.addFiles([png(), docx(), text()]))
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/r\.docx can't be attached/))
    expect(added.flat()).toEqual([
      {
        artifactId: expect.stringMatching(/^art-shot\.png/),
        name: 'shot.png',
        kind: 'image',
        mediaType: 'image/png',
        size: PNG.length
      },
      {
        artifactId: expect.stringMatching(/^art-notes\.md/),
        name: 'notes.md',
        kind: 'text',
        mediaType: 'text/plain',
        size: 5
      }
    ])
    expect(hook.result.current.pending).toEqual([])
  })

  it('an upload failure is shown, nothing is added', async () => {
    mocks.uploadFiles.mockRejectedValue(new Error('disk full'))
    const { hook, added } = setup('claude-chat')
    await act(() => hook.result.current.addFiles([png()]))
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/shot\.png.*disk full/))
    expect(added.flat()).toEqual([])
  })

  it('a file stays pending until it is added: no render sees neither', async () => {
    let release: () => void = () => {}
    mocks.uploadFiles
      .mockImplementationOnce(async (files) => files.map((f) => ({ id: 'fast', title: f.name })))
      .mockImplementationOnce(async (files) => {
        await new Promise<void>((r) => (release = r))
        return files.map((f) => ({ id: 'slow', title: f.name }))
      })
    const seen: Array<{ pending: number; added: number }> = []
    const added: ChatAttachment[][] = []
    // `onSettled` comes once, after the files were handed over.
    const settledWith: number[] = []
    const hook = renderHook(() => {
      const r = useChatAttachments({
        taskId: 'task-1',
        mode: 'claude-chat',
        onAdded: (a) => added.push(a),
        onSettled: () => settledWith.push(added.flat().length),
        codec
      })
      seen.push({ pending: r.pending.length, added: added.flat().length })
      return r
    })
    let done: Promise<void> = Promise.resolve()
    await act(async () => {
      done = hook.result.current.addFiles([png('a.png'), png('b.png')])
    })
    // The first upload is done, the second is not: both still pending.
    expect(hook.result.current.pending).toHaveLength(2)
    expect(added).toEqual([])
    expect(settledWith).toEqual([])
    await act(async () => {
      release()
      await done
    })
    expect(added.flat()).toHaveLength(2)
    expect(settledWith).toEqual([2])
    expect(hook.result.current.pending).toEqual([])
    // Never "nothing pending" before the files were handed over.
    expect(seen.some((s) => s.pending === 0 && s.added === 0 && seen.indexOf(s) > 0)).toBe(false)
  })

  it('a failed file reports onFailed and leaves pending at once', async () => {
    mocks.uploadFiles.mockRejectedValue(new Error('disk full'))
    const onFailed = vi.fn()
    const onSettled = vi.fn()
    const hook = renderHook(() =>
      useChatAttachments({
        taskId: 'task-1',
        mode: 'claude-chat',
        onAdded: () => {},
        onFailed,
        onSettled,
        codec
      })
    )
    await act(() => hook.result.current.addFiles([png()]))
    expect(onFailed).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(hook.result.current.pending).toEqual([])
  })

  it('paste: files are attached; an Office copy (text + html + picture) pastes as text', async () => {
    const { hook, added } = setup('claude-chat')
    const clip = (types: Record<string, string>, files: File[]) => {
      const e = {
        preventDefault: vi.fn(),
        clipboardData: {
          types: [...Object.keys(types), ...(files.length ? ['Files'] : [])],
          getData: (t: string) => types[t] ?? '',
          items: files.map((f) => ({ kind: 'file', getAsFile: () => f })),
          files
        }
      }
      return e as unknown as React.ClipboardEvent
    }
    const office = clip({ 'text/plain': 'a\tb', 'text/html': '<table/>' }, [png('sheet.png')])
    await act(async () => hook.result.current.onPaste(office))
    expect(office.preventDefault).not.toHaveBeenCalled()
    const shot = clip({}, [png('screen.png')])
    await act(async () => hook.result.current.onPaste(shot))
    expect(shot.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(added.flat().map((a) => a.name)).toEqual(['screen.png']))
  })
})

describe('useChatAttachments (Codex: validated images only)', () => {
  it('refuses non-images; validates and uploads images', async () => {
    const { hook, added } = setup('codex-chat')
    await act(() => hook.result.current.addFiles([png(), text()]))
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/notes.md.*supported: image/))
    expect(added.flat().map((a) => a.name)).toEqual(['shot.png'])
  })
})

it('Codex checks actual bytes before accepting a file named as an image', async () => {
  const { hook, added } = setup('codex-chat')
  await act(() =>
    hook.result.current.addFiles([new File(['plain text'], 'fake.png', { type: 'image/png' })])
  )
  expect(added).toEqual([])
  expect(mocks.uploadFiles).not.toHaveBeenCalled()
})
