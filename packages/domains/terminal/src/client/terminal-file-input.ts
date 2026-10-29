import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import { electronBootstrap } from '@slayzone/transport/client'
import type { useTRPCClient } from './trpc'

interface FileInputOptions {
  container: HTMLElement
  terminalRef: RefObject<XTerm | null>
  /** Enter/leave balance across child elements, so leaving a child is not leaving the terminal. */
  dragCounter: RefObject<number>
  setIsDragOver: Dispatch<SetStateAction<boolean>>
  trpcClient: ReturnType<typeof useTRPCClient>
}

/**
 * Paste and drag-drop of files/images into a terminal: each lands as its disk
 * path (a clipboard image is saved to a temp file first), inserted at the
 * prompt. Returns the cleanup.
 */
export function installTerminalFileInput({
  container,
  terminalRef,
  dragCounter,
  setIsDragOver,
  trpcClient
}: FileInputOptions): () => void {
  // Convert File to base64
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        resolve(result.split(',')[1]) // Remove data:...;base64, prefix
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  // Insert path into terminal (escape if has spaces).
  // Route through xterm paste() so bracketed-paste wraps the payload when
  // the foreground app enabled ?2004h (e.g. Claude Code) — required for
  // CC's image-from-path detection. Plain shells without bracketed paste
  // get raw bytes, same as a direct PTY write.
  const insertPath = (path: string) => {
    const escaped = path.includes(' ') ? `"${path}"` : path
    terminalRef.current?.paste(escaped)
  }

  // Process a single file. Electron 32+ removed File.path; real disk paths
  // must come from webUtils.getPathForFile, which only works in preload —
  // pass the pre-extracted path in for drop events.
  const processFile = async (
    file: File,
    mimeType?: string,
    droppedPath?: string
  ): Promise<string | null> => {
    if (droppedPath) return droppedPath
    if (mimeType?.startsWith('image/') || file.type.startsWith('image/')) {
      // Image from clipboard (screenshot, browser copy) - save to temp
      const base64 = await fileToBase64(file)
      const result = await trpcClient.app.files.saveTempImage.mutate({
        base64,
        mimeType: mimeType || file.type
      })
      if (result.success && result.path) {
        return result.path
      }
    }
    return null
  }

  const handlePaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    // Symmetric with handleDrop: preload's capture-phase paste listener
    // already resolved any filesystem paths (Finder-pasted files) via
    // webUtils. Zip by index with file items. This is a synchronous preload-
    // native call (webUtils.getPathForFile) with NO tRPC router procedure —
    // it stays on the IPC bridge.
    const pastedPaths = electronBootstrap.getPastePaths()

    const paths: string[] = []
    let fileIdx = 0

    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (!file) {
          fileIdx++
          continue
        }

        e.preventDefault()
        const path = await processFile(file, item.type, pastedPaths[fileIdx])
        if (path) paths.push(path)
        fileIdx++
      }
    }

    if (paths.length > 0) {
      insertPath(paths.join(' '))
      terminalRef.current?.focus()
    }
  }

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setIsDragOver(false)
    terminalRef.current?.focus()

    const files = e.dataTransfer?.files
    if (!files?.length) return

    // Preload's capture-phase drop listener already extracted real disk
    // paths via webUtils.getPathForFile; zip by index with the File list.
    // Synchronous preload-native call (no tRPC router procedure) — stays on
    // the IPC bridge.
    const droppedPaths = electronBootstrap.getDropPaths()

    try {
      const paths: string[] = []
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const path = await processFile(file, undefined, droppedPaths[i])
        if (path) paths.push(path)
      }

      if (paths.length > 0) {
        insertPath(paths.join(' '))
      }
    } finally {
      terminalRef.current?.focus()
    }
  }

  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer?.types.includes('Files')) {
      setIsDragOver(true)
    }
    terminalRef.current?.focus()
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) {
      setIsDragOver(false)
    }
  }

  container.addEventListener('paste', handlePaste)
  container.addEventListener('dragenter', handleDragEnter)
  container.addEventListener('drop', handleDrop)
  container.addEventListener('dragover', handleDragOver)
  container.addEventListener('dragleave', handleDragLeave)

  return () => {
    container.removeEventListener('paste', handlePaste)
    container.removeEventListener('dragenter', handleDragEnter)
    container.removeEventListener('drop', handleDrop)
    container.removeEventListener('dragover', handleDragOver)
    container.removeEventListener('dragleave', handleDragLeave)
  }
}
