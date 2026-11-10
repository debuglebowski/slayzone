// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { createTrpcTest } from '@slayzone/transport/testing'
import { useFileEditor, isImageFile, isPdfFile, isBinaryFile } from './useFileEditor'
import { createElement } from 'react'
import { WorkspaceTargetProvider } from './workspace-target'

/** The trpc test wrapper inside a project panel's path scope (every call names one). */
function scopedWrapper(
  base: (props: { children: ReactNode }) => ReactNode
): (props: { children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(
      base,
      null,
      createElement(WorkspaceTargetProvider, { target: { projectId: 'p1' }, children })
    )
}

type FileWatchEvent = { type: 'changed' | 'deleted'; root: string; relPath: string }

interface FsStub {
  readFile: ReturnType<typeof vi.fn>
  writeFile: ReturnType<typeof vi.fn>
  emitChanged: (root: string, rel: string) => void
  emitDeleted: (root: string, rel: string) => void
  wrapper: (props: { children: ReactNode }) => ReactNode
}

// In-memory fileEditor backend behind the real tRPC client + provider: the
// three procedures the hook uses, served from `diskContent`.
function installFsStub(diskContent: Record<string, string> = {}): FsStub {
  const watchers = new Set<(event: FileWatchEvent) => void>()
  const readFile = vi.fn(async (_root: string, rel: string) => {
    if (!(rel in diskContent)) throw new Error('ENOENT')
    return { content: diskContent[rel] }
  })
  const writeFile = vi.fn(async (_root: string, rel: string, content: string) => {
    diskContent[rel] = content
  })
  const emit = (event: FileWatchEvent) => {
    for (const push of watchers) push(event)
  }
  const { wrapper } = createTrpcTest({
    procedures: {
      'fileEditor.readFile': (i) => readFile(i.rootPath, i.filePath),
      'fileEditor.writeFile': (i) => writeFile(i.rootPath, i.filePath, i.content)
    },
    subscriptions: {
      'fileEditor.watch': (_input, push) => {
        watchers.add(push)
        return () => watchers.delete(push)
      }
    }
  })
  return {
    readFile,
    writeFile,
    emitChanged: (root, rel) => emit({ type: 'changed', root, relPath: rel }),
    emitDeleted: (root, rel) => emit({ type: 'deleted', root, relPath: rel }),
    wrapper: scopedWrapper(wrapper)
  }
}

const ROOT = '/tmp/proj'

let fs: FsStub
let disk: Record<string, string>

beforeEach(() => {
  disk = {
    'a.ts': 'A',
    'b.ts': 'B',
    'src/c.ts': 'C',
    'src/nested/d.ts': 'D'
  }
  fs = installFsStub(disk)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useFileEditor — delete handling', () => {
  it('closes tab when its file is deleted on disk', async () => {
    const { result } = renderHook(() => useFileEditor(ROOT), { wrapper: fs.wrapper })
    await flush()

    await act(async () => {
      await result.current.openFile('a.ts')
    })
    await act(async () => {
      await result.current.openFile('b.ts')
    })
    expect(result.current.openFiles.map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
    expect(result.current.activeFilePath).toBe('b.ts')

    act(() => {
      fs.emitDeleted(ROOT, 'b.ts')
    })
    await flush()

    expect(result.current.openFiles.map((f) => f.path)).toEqual(['a.ts'])
    expect(result.current.activeFilePath).toBe('a.ts')
  })

  it('active becomes null when last tab deleted', async () => {
    const { result } = renderHook(() => useFileEditor(ROOT), { wrapper: fs.wrapper })
    await flush()

    await act(async () => {
      await result.current.openFile('a.ts')
    })
    expect(result.current.activeFilePath).toBe('a.ts')

    act(() => {
      fs.emitDeleted(ROOT, 'a.ts')
    })
    await flush()

    expect(result.current.openFiles).toEqual([])
    expect(result.current.activeFilePath).toBeNull()
  })

  it('closes descendants when folder deleted', async () => {
    const { result } = renderHook(() => useFileEditor(ROOT), { wrapper: fs.wrapper })
    await flush()

    await act(async () => {
      await result.current.openFile('src/c.ts')
    })
    await act(async () => {
      await result.current.openFile('src/nested/d.ts')
    })
    await act(async () => {
      await result.current.openFile('a.ts')
    })

    act(() => {
      fs.emitDeleted(ROOT, 'src')
    })
    await flush()

    expect(result.current.openFiles.map((f) => f.path)).toEqual(['a.ts'])
    expect(result.current.activeFilePath).toBe('a.ts')
  })

  it('ignores delete event for non-open file', async () => {
    const { result } = renderHook(() => useFileEditor(ROOT), { wrapper: fs.wrapper })
    await flush()

    await act(async () => {
      await result.current.openFile('a.ts')
    })

    act(() => {
      fs.emitDeleted(ROOT, 'unrelated.ts')
    })
    await flush()

    expect(result.current.openFiles.map((f) => f.path)).toEqual(['a.ts'])
  })

  it('ignores delete from different project root', async () => {
    const { result } = renderHook(() => useFileEditor(ROOT), { wrapper: fs.wrapper })
    await flush()

    await act(async () => {
      await result.current.openFile('a.ts')
    })

    act(() => {
      fs.emitDeleted('/other/proj', 'a.ts')
    })
    await flush()

    expect(result.current.openFiles.map((f) => f.path)).toEqual(['a.ts'])
  })

  it('dirty tab stays open with deleted flag when file deleted on disk', async () => {
    const { result } = renderHook(() => useFileEditor(ROOT), { wrapper: fs.wrapper })
    await flush()

    await act(async () => {
      await result.current.openFile('a.ts')
    })
    act(() => {
      result.current.updateContent('a.ts', 'A-edited')
    })
    expect(result.current.isDirty('a.ts')).toBe(true)

    act(() => {
      fs.emitDeleted(ROOT, 'a.ts')
    })
    await flush()

    expect(result.current.openFiles.map((f) => f.path)).toEqual(['a.ts'])
    expect(result.current.isFileDeleted('a.ts')).toBe(true)
    expect(result.current.isFileDiskChanged('a.ts')).toBe(true)
    expect(result.current.isDirty('a.ts')).toBe(true)
  })

  it('folder delete: clean children close, dirty child stays', async () => {
    const { result } = renderHook(() => useFileEditor(ROOT), { wrapper: fs.wrapper })
    await flush()

    await act(async () => {
      await result.current.openFile('src/c.ts')
    })
    await act(async () => {
      await result.current.openFile('src/nested/d.ts')
    })
    act(() => {
      result.current.updateContent('src/nested/d.ts', 'D-edited')
    })

    act(() => {
      fs.emitDeleted(ROOT, 'src')
    })
    await flush()

    // Dirty d.ts stays, clean c.ts closes
    expect(result.current.openFiles.map((f) => f.path)).toEqual(['src/nested/d.ts'])
    expect(result.current.isFileDeleted('src/nested/d.ts')).toBe(true)
  })

  it('saving deleted dirty file clears deleted flag (recreate)', async () => {
    const { result } = renderHook(() => useFileEditor(ROOT), { wrapper: fs.wrapper })
    await flush()

    await act(async () => {
      await result.current.openFile('a.ts')
    })
    act(() => {
      result.current.updateContent('a.ts', 'A-edited')
    })
    act(() => {
      fs.emitDeleted(ROOT, 'a.ts')
    })
    await flush()
    expect(result.current.isFileDeleted('a.ts')).toBe(true)

    await act(async () => {
      await result.current.saveFile('a.ts')
    })

    expect(result.current.isFileDeleted('a.ts')).toBe(false)
    expect(result.current.isDirty('a.ts')).toBe(false)
    expect(fs.writeFile).toHaveBeenCalledWith(ROOT, 'a.ts', 'A-edited')
  })

  it('external recreate clears deleted flag (via change event)', async () => {
    const { result } = renderHook(() => useFileEditor(ROOT), { wrapper: fs.wrapper })
    await flush()

    await act(async () => {
      await result.current.openFile('a.ts')
    })
    act(() => {
      result.current.updateContent('a.ts', 'A-edited')
    })
    act(() => {
      fs.emitDeleted(ROOT, 'a.ts')
    })
    await flush()
    expect(result.current.isFileDeleted('a.ts')).toBe(true)

    // File recreated externally → change event fires
    act(() => {
      fs.emitChanged(ROOT, 'a.ts')
    })
    await flush()

    // Still dirty → keeps local content, clears deleted, stays diskChanged
    expect(result.current.isFileDeleted('a.ts')).toBe(false)
    expect(result.current.isFileDiskChanged('a.ts')).toBe(true)
    expect(result.current.isDirty('a.ts')).toBe(true)
  })

  it('does not close tab for path that is only a prefix match (no slash)', async () => {
    const { result } = renderHook(() => useFileEditor(ROOT), { wrapper: fs.wrapper })
    await flush()

    await act(async () => {
      await result.current.openFile('src/c.ts')
    })

    // "sr" is a prefix of "src/c.ts" but not a parent folder — must NOT close
    act(() => {
      fs.emitDeleted(ROOT, 'sr')
    })
    await flush()

    expect(result.current.openFiles.map((f) => f.path)).toEqual(['src/c.ts'])
  })
})

function deferred() {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Drains the in-process tRPC round trips (several promise hops + a macrotask).
async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

/** Next writeFile call blocks until `gate` resolves, then lands on disk. */
function gateNextWrite() {
  const gate = deferred()
  fs.writeFile.mockImplementationOnce(async (_root: string, rel: string, content: string) => {
    await gate.promise
    disk[rel] = content
  })
  return gate
}

describe('useFileEditor — keystrokes during save / reload are never lost', () => {
  async function openA() {
    const hook = renderHook(() => useFileEditor(ROOT), { wrapper: fs.wrapper })
    await flush()
    await act(async () => {
      await hook.result.current.openFile('a.ts')
    })
    return hook
  }
  const contentOf = (files: { path: string; content: string | null }[], path: string) =>
    files.find((f) => f.path === path)?.content

  it('keys typed while the write is in flight stay dirty, and the save echo keeps them', async () => {
    const { result } = await openA()
    const gate = gateNextWrite()

    act(() => {
      result.current.updateContent('a.ts', 'A1')
    })
    let saving!: Promise<void>
    act(() => {
      saving = result.current.saveFile('a.ts')
    })
    await settle()
    // Typed while the write is in flight.
    act(() => {
      result.current.updateContent('a.ts', 'A12')
    })

    gate.resolve()
    await act(async () => {
      await saving
    })
    expect(disk['a.ts']).toBe('A1')
    expect(contentOf(result.current.openFiles, 'a.ts')).toBe('A12')
    expect(result.current.isDirty('a.ts')).toBe(true)

    // The save's own watcher echo: disk === what we wrote → not an outside change.
    act(() => {
      fs.emitChanged(ROOT, 'a.ts')
    })
    await settle()
    expect(contentOf(result.current.openFiles, 'a.ts')).toBe('A12')
    expect(result.current.isDirty('a.ts')).toBe(true)
    expect(result.current.isFileDiskChanged('a.ts')).toBe(false)
  })

  it('a save echo that arrives while the write is still in flight is not an outside change', async () => {
    const { result } = await openA()
    const gate = deferred()
    // Disk updates immediately, but the mutation response is delayed (hub→computer).
    fs.writeFile.mockImplementationOnce(async (_root: string, rel: string, content: string) => {
      disk[rel] = content
      await gate.promise
    })

    act(() => {
      result.current.updateContent('a.ts', 'A1')
    })
    let saving!: Promise<void>
    act(() => {
      saving = result.current.saveFile('a.ts')
    })
    await settle()
    act(() => {
      result.current.updateContent('a.ts', 'A12')
    })
    act(() => {
      fs.emitChanged(ROOT, 'a.ts')
    })
    await settle()
    expect(contentOf(result.current.openFiles, 'a.ts')).toBe('A12')
    expect(result.current.isFileDiskChanged('a.ts')).toBe(false)

    gate.resolve()
    await act(async () => {
      await saving
    })
    expect(contentOf(result.current.openFiles, 'a.ts')).toBe('A12')
    expect(result.current.isDirty('a.ts')).toBe(true)
    expect(result.current.isFileDiskChanged('a.ts')).toBe(false)
  })

  it('keys typed while a clean reload read is in flight are kept (marked disk-changed)', async () => {
    const { result } = await openA()
    const gate = deferred()
    disk['a.ts'] = 'A-external'
    fs.readFile.mockImplementationOnce(async (_root: string, rel: string) => {
      await gate.promise
      return { content: disk[rel] }
    })

    // Clean tab → the change event schedules a silent reload.
    act(() => {
      fs.emitChanged(ROOT, 'a.ts')
    })
    await settle()
    act(() => {
      result.current.updateContent('a.ts', 'A-typed')
    })
    gate.resolve()
    await settle()

    expect(contentOf(result.current.openFiles, 'a.ts')).toBe('A-typed')
    expect(result.current.isDirty('a.ts')).toBe(true)
    expect(result.current.isFileDiskChanged('a.ts')).toBe(true)
  })

  it('dirty tab + real outside change → disk-changed, buffer kept', async () => {
    const { result } = await openA()
    act(() => {
      result.current.updateContent('a.ts', 'A-local')
    })
    disk['a.ts'] = 'A-external'
    act(() => {
      fs.emitChanged(ROOT, 'a.ts')
    })
    await settle()
    expect(contentOf(result.current.openFiles, 'a.ts')).toBe('A-local')
    expect(result.current.isDirty('a.ts')).toBe(true)
    expect(result.current.isFileDiskChanged('a.ts')).toBe(true)
  })

  it('clean tab + outside change still reloads silently', async () => {
    const { result } = await openA()
    disk['a.ts'] = 'A-external'
    act(() => {
      fs.emitChanged(ROOT, 'a.ts')
    })
    await settle()
    expect(contentOf(result.current.openFiles, 'a.ts')).toBe('A-external')
    expect(result.current.isDirty('a.ts')).toBe(false)
    expect(result.current.isFileDiskChanged('a.ts')).toBe(false)
  })

  it('a save issued while another is in flight waits for it, then writes the latest buffer', async () => {
    const { result } = await openA()
    const gate = gateNextWrite()

    act(() => {
      result.current.updateContent('a.ts', 'A1')
    })
    let first!: Promise<void>
    act(() => {
      first = result.current.saveFile('a.ts')
    })
    await settle()
    act(() => {
      result.current.updateContent('a.ts', 'A12')
    })
    let second!: Promise<void>
    act(() => {
      second = result.current.saveFile('a.ts')
    })
    await settle()
    // Serialized: the second write must not race the first on disk.
    expect(fs.writeFile).toHaveBeenCalledTimes(1)

    gate.resolve()
    await act(async () => {
      await first
      await second
    })
    expect(fs.writeFile).toHaveBeenCalledTimes(2)
    expect(fs.writeFile).toHaveBeenLastCalledWith(ROOT, 'a.ts', 'A12')
    expect(disk['a.ts']).toBe('A12')
    expect(contentOf(result.current.openFiles, 'a.ts')).toBe('A12')
    expect(result.current.isDirty('a.ts')).toBe(false)
  })

  it('a failed save keeps the buffer dirty and does not block the next save', async () => {
    const { result } = await openA()
    fs.writeFile.mockImplementationOnce(async () => {
      throw new Error('computer offline')
    })
    act(() => {
      result.current.updateContent('a.ts', 'A1')
    })
    await act(async () => {
      await expect(result.current.saveFile('a.ts')).rejects.toThrow()
    })
    expect(result.current.isDirty('a.ts')).toBe(true)
    expect(disk['a.ts']).toBe('A')

    await act(async () => {
      await result.current.saveFile('a.ts')
    })
    expect(disk['a.ts']).toBe('A1')
    expect(result.current.isDirty('a.ts')).toBe(false)
  })
})

describe('file-type classifiers', () => {
  it('isImageFile matches image extensions', () => {
    expect(isImageFile('logo.png')).toBe(true)
    expect(isImageFile('a/b/pic.JPG')).toBe(true)
    expect(isImageFile('doc.pdf')).toBe(false)
    expect(isImageFile('main.ts')).toBe(false)
  })

  it('isPdfFile matches only .pdf', () => {
    expect(isPdfFile('doc.pdf')).toBe(true)
    expect(isPdfFile('REPORT.PDF')).toBe(true)
    expect(isPdfFile('logo.png')).toBe(false)
    expect(isPdfFile('notes.md')).toBe(false)
  })

  it('isBinaryFile covers images and pdfs, not text', () => {
    expect(isBinaryFile('logo.png')).toBe(true)
    expect(isBinaryFile('doc.pdf')).toBe(true)
    expect(isBinaryFile('main.ts')).toBe(false)
  })
})

describe('useFileEditor — binary files', () => {
  it('opens a pdf as binary without reading content', async () => {
    const { result } = renderHook(() => useFileEditor(ROOT), { wrapper: fs.wrapper })
    await flush()

    await act(async () => {
      await result.current.openFile('doc.pdf')
    })

    const opened = result.current.openFiles.find((f) => f.path === 'doc.pdf')
    expect(opened).toMatchObject({ path: 'doc.pdf', binary: true, content: null })
    expect(result.current.activeFilePath).toBe('doc.pdf')
    // never read the bytes as text
    expect(fs.readFile).not.toHaveBeenCalledWith(ROOT, 'doc.pdf')
  })
})
