import { useState, useCallback, useRef, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC, useTRPCClient, useSubscription } from '@slayzone/transport/client'
import { track } from '@slayzone/telemetry/client'
import { useVisibleInterval } from '@slayzone/ui'
import type { EditorOpenFilesState, OpenFileOptions } from '@slayzone/file-editor/shared'

export interface OpenFile {
  path: string
  content: string | null
  originalContent: string | null
  tooLarge?: boolean
  sizeBytes?: number
  diskChanged?: boolean
  /** File was removed from disk while tab was open. Dirty tabs are kept so
   * the user can save-to-recreate or close-to-discard. */
  deleted?: boolean
  /** Non-text file rendered by dedicated viewer (image, etc.) */
  binary?: boolean
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'])
const PDF_EXTENSIONS = new Set(['pdf'])

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return !!ext && IMAGE_EXTENSIONS.has(ext)
}

export function isPdfFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return !!ext && PDF_EXTENSIONS.has(ext)
}

/** Non-text files rendered by a dedicated viewer via slz-file:// — no content read. */
export function isBinaryFile(filePath: string): boolean {
  return isImageFile(filePath) || isPdfFile(filePath)
}

export function useFileEditor(
  projectPath: string,
  initialEditorState?: EditorOpenFilesState | null
) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const writeFileMutation = useMutation(trpc.fileEditor.writeFile.mutationOptions())
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  // One-shot signal bumped whenever openFile activates a file. Lets the view
  // focus the editor on open (incl. plain Cmd+K opens with no position). Not
  // bumped by restore/file-watcher paths, so reopening a task never steals focus.
  const [focusToken, setFocusToken] = useState(0)
  const [treeRefreshKey, setTreeRefreshKey] = useState(0)
  const pendingOpen = useRef<string | null>(null)
  const treeRefreshTimer = useRef<NodeJS.Timeout | null>(null)
  // Track version per file for CodeMirror external content reload
  const [fileVersions, setFileVersions] = useState<Map<string, number>>(new Map())
  const [goToPosition, setGoToPosition] = useState<{
    filePath: string
    line: number
    col: number
  } | null>(null)

  // --- Restore persisted state on mount ---
  const [isRestoring, setIsRestoring] = useState(!!initialEditorState?.files?.length)
  const hasRestored = useRef(false)
  useEffect(() => {
    if (hasRestored.current || !initialEditorState?.files?.length) return
    hasRestored.current = true
    ;(async () => {
      for (const filePath of initialEditorState.files) {
        try {
          if (isBinaryFile(filePath)) {
            setOpenFiles((prev) => {
              if (prev.some((f) => f.path === filePath)) return prev
              return [
                ...prev,
                { path: filePath, content: null, originalContent: null, binary: true }
              ]
            })
            continue
          }
          const result = await queryClient.fetchQuery(
            trpc.fileEditor.readFile.queryOptions({ rootPath: projectPath, filePath })
          )
          if (result.tooLarge) {
            setOpenFiles((prev) => {
              if (prev.some((f) => f.path === filePath)) return prev
              return [
                ...prev,
                {
                  path: filePath,
                  content: null,
                  originalContent: null,
                  tooLarge: true,
                  sizeBytes: result.sizeBytes
                }
              ]
            })
          } else {
            setOpenFiles((prev) => {
              if (prev.some((f) => f.path === filePath)) return prev
              return [
                ...prev,
                { path: filePath, content: result.content, originalContent: result.content }
              ]
            })
          }
        } catch {
          // File deleted since last session — skip
        }
      }
      if (initialEditorState.activeFile) {
        setActiveFilePath(initialEditorState.activeFile)
      }
      setIsRestoring(false)
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- mount only

  const reloadFile = useCallback(
    async (filePath: string) => {
      try {
        // Binary files: just bump version for cache busting, no content to reload
        if (isImageFile(filePath)) {
          setFileVersions((prev) => {
            const next = new Map(prev)
            next.set(filePath, (next.get(filePath) ?? 0) + 1)
            return next
          })
          return
        }

        const result = await trpcClient.fileEditor.readFile.query({ rootPath: projectPath, filePath })
        if (result.tooLarge || result.content == null) return
        const current = openFilesRef.current.find((f) => f.path === filePath)
        if (
          current &&
          current.content === result.content &&
          current.originalContent === result.content &&
          !current.diskChanged &&
          !current.deleted
        ) {
          return
        }
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.path === filePath
              ? {
                  ...f,
                  content: result.content,
                  originalContent: result.content,
                  diskChanged: false,
                  deleted: false
                }
              : f
          )
        )
        setFileVersions((prev) => {
          const next = new Map(prev)
          next.set(filePath, (next.get(filePath) ?? 0) + 1)
          return next
        })
      } catch {
        const current = openFilesRef.current.find((f) => f.path === filePath)
        if (!current) return
        const dirty = current.content !== current.originalContent
        if (dirty) {
          setOpenFiles((prev) => {
            const next = prev.map((f) =>
              f.path === filePath ? { ...f, deleted: true, diskChanged: true } : f
            )
            openFilesRef.current = next
            return next
          })
          return
        }
        setOpenFiles((prev) => {
          const next = prev.filter((f) => f.path !== filePath)
          openFilesRef.current = next
          return next
        })
        setActiveFilePath((curActive) => {
          if (curActive !== filePath) return curActive
          const nextFiles = openFilesRef.current
          return nextFiles.length > 0 ? nextFiles[nextFiles.length - 1].path : null
        })
        setFileVersions((prev) => {
          if (!prev.has(filePath)) return prev
          const next = new Map(prev)
          next.delete(filePath)
          return next
        })
      }
    },
    [projectPath, trpcClient]
  )

  const projectPathRef = useRef(projectPath)
  projectPathRef.current = projectPath

  const openFilesRef = useRef(openFiles)
  openFilesRef.current = openFiles
  const setOpenFilesAndRef = useCallback((updater: (prev: OpenFile[]) => OpenFile[]) => {
    setOpenFiles((prev) => {
      const next = updater(prev)
      openFilesRef.current = next
      return next
    })
  }, [])

  const reloadFileRef = useRef(reloadFile)
  reloadFileRef.current = reloadFile

  // Single file-watcher subscription. The unified `watch` procedure emits both
  // 'deleted' and 'changed' events (replacing the old onFileDeleted +
  // onFileChanged IPC listener pair). Dispatch by event.type.
  useSubscription(
    trpc.fileEditor.watch.subscriptionOptions(
      { rootPath: projectPath },
      {
        onData: (event) => {
          const rootPath = event.root
          const relPath = event.relPath
          const normalize = (p: string) => p.replace(/\/+$/, '')
          if (normalize(rootPath) !== normalize(projectPathRef.current)) return

          if (event.type === 'deleted') {
            const prefix = relPath + '/'
            const isMatch = (p: string) => p === relPath || p.startsWith(prefix)

            const current = openFilesRef.current
            const matching = current.filter((f) => isMatch(f.path))
            if (matching.length === 0) return

            // Dirty files stay open (marked deleted); clean files close.
            const nextFiles: OpenFile[] = []
            const closedPaths = new Set<string>()
            for (const f of current) {
              if (!isMatch(f.path)) {
                nextFiles.push(f)
                continue
              }
              const dirty = f.content !== f.originalContent
              if (dirty) {
                nextFiles.push({ ...f, deleted: true, diskChanged: true })
              } else {
                closedPaths.add(f.path)
              }
            }
            setOpenFiles(nextFiles)

            if (closedPaths.size > 0) {
              setActiveFilePath((curActive) => {
                if (!curActive || !closedPaths.has(curActive)) return curActive
                return nextFiles.length > 0 ? nextFiles[nextFiles.length - 1].path : null
              })
              setFileVersions((prev) => {
                let changed = false
                const next = new Map<string, number>()
                for (const [k, v] of prev) {
                  if (closedPaths.has(k)) {
                    changed = true
                    continue
                  }
                  next.set(k, v)
                }
                return changed ? next : prev
              })
            }

            if (treeRefreshTimer.current) clearTimeout(treeRefreshTimer.current)
            treeRefreshTimer.current = setTimeout(() => {
              setTreeRefreshKey((k) => k + 1)
            }, 500)
            return
          }

          // event.type === 'changed'
          // Schedule tree refresh (debounced 500ms)
          if (treeRefreshTimer.current) clearTimeout(treeRefreshTimer.current)
          treeRefreshTimer.current = setTimeout(() => {
            setTreeRefreshKey((k) => k + 1)
          }, 500)

          setOpenFiles((prev) => {
            const fileIdx = prev.findIndex((f) => f.path === relPath)
            if (fileIdx === -1) return prev

            const file = prev[fileIdx]
            const isDirty = file.content !== file.originalContent

            if (isDirty) {
              // Mark as disk-changed, don't auto-reload
              const next = [...prev]
              next[fileIdx] = { ...file, diskChanged: true, deleted: false }
              return next
            }

            // Not dirty — schedule silent reload (async, outside setState)
            reloadFileRef.current(relPath)
            return prev
          })
        }
      }
    )
  )

  // Cleanup the shared debounce timer on unmount (the file-watch subscription
  // owned this previously).
  useEffect(() => {
    return () => {
      if (treeRefreshTimer.current) clearTimeout(treeRefreshTimer.current)
    }
  }, [])

  // Low-frequency fallback for missed watcher events. Only clean text files are
  // auto-reloaded; dirty tabs keep their draft and rely on the changed marker.
  useVisibleInterval(() => {
    for (const file of openFilesRef.current) {
      if (file.binary || file.tooLarge || file.content !== file.originalContent) continue
      void reloadFileRef.current(file.path)
    }
  }, 1_500)

  // --- Open / close / save ---
  const openFile = useCallback(
    async (filePath: string, options?: OpenFileOptions) => {
      const from = options?.from ?? 'sidebar'
      const activateFile = (path: string) => {
        setActiveFilePath(path)
        setFocusToken((t) => t + 1)
      }
      if (options?.position) {
        setGoToPosition({ filePath, line: options.position.line, col: options.position.col ?? 0 })
      }
      // Already open — just focus
      const existing = openFiles.find((f) => f.path === filePath)
      if (existing) {
        activateFile(filePath)
        return
      }

      if (pendingOpen.current === filePath) return
      pendingOpen.current = filePath

      try {
        // Binary files (images, PDFs) — rendered via slz-file:// protocol, no content needed
        if (isBinaryFile(filePath)) {
          setOpenFilesAndRef((prev) => {
            if (prev.some((f) => f.path === filePath)) return prev
            return [...prev, { path: filePath, content: null, originalContent: null, binary: true }]
          })
          activateFile(filePath)
          track('editor_file_opened', { from })
          return
        }

        const result = await queryClient.fetchQuery(
          trpc.fileEditor.readFile.queryOptions({ rootPath: projectPath, filePath })
        )
        if (result.tooLarge) {
          setOpenFilesAndRef((prev) => {
            if (prev.some((f) => f.path === filePath)) return prev
            return [
              ...prev,
              {
                path: filePath,
                content: null,
                originalContent: null,
                tooLarge: true,
                sizeBytes: result.sizeBytes
              }
            ]
          })
          activateFile(filePath)
          track('editor_file_opened', { from })
          return
        }
        setOpenFilesAndRef((prev) => {
          if (prev.some((f) => f.path === filePath)) return prev
          return [
            ...prev,
            { path: filePath, content: result.content, originalContent: result.content }
          ]
        })
        activateFile(filePath)
        track('editor_file_opened', { from })
      } finally {
        pendingOpen.current = null
      }
    },
    [projectPath, openFiles, queryClient, setOpenFilesAndRef, trpc]
  )

  const openFileForced = useCallback(
    async (filePath: string) => {
      try {
        const result = await queryClient.fetchQuery(
          trpc.fileEditor.readFile.queryOptions({ rootPath: projectPath, filePath, force: true })
        )
        if (result.content == null) return
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.path === filePath
              ? {
                  ...f,
                  content: result.content,
                  originalContent: result.content,
                  tooLarge: false,
                  sizeBytes: undefined
                }
              : f
          )
        )
      } catch {
        // File read failed
      }
    },
    [projectPath, queryClient, trpc]
  )

  const updateContent = useCallback((filePath: string, content: string) => {
    setOpenFiles((prev) => prev.map((f) => (f.path === filePath ? { ...f, content } : f)))
  }, [])

  const saveFile = useCallback(
    async (filePath: string) => {
      const file = openFiles.find((f) => f.path === filePath)
      if (!file || file.content == null || file.content === file.originalContent) return
      await writeFileMutation.mutateAsync({
        rootPath: projectPath,
        filePath,
        content: file.content
      })
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === filePath
            ? { ...f, originalContent: f.content, diskChanged: false, deleted: false }
            : f
        )
      )
    },
    [projectPath, openFiles]
  )

  const closeFile = useCallback(
    (filePath: string) => {
      setOpenFiles((prev) => {
        const next = prev.filter((f) => f.path !== filePath)
        return next
      })
      setActiveFilePath((current) => {
        if (current !== filePath) return current
        const remaining = openFiles.filter((f) => f.path !== filePath)
        return remaining.length > 0 ? remaining[remaining.length - 1].path : null
      })
      setFileVersions((prev) => {
        const next = new Map(prev)
        next.delete(filePath)
        return next
      })
    },
    [openFiles]
  )

  // Bulk close. `keepDirty` preserves dirty files in place so user can't lose work.
  const closeFilesByPredicate = useCallback(
    (shouldClose: (file: OpenFile) => boolean, keepDirty: boolean) => {
      const removed = new Set<string>()
      setOpenFiles((prev) => {
        const next: OpenFile[] = []
        for (const f of prev) {
          const dirty = f.content !== f.originalContent
          const close = shouldClose(f) && (!keepDirty || !dirty)
          if (close) {
            removed.add(f.path)
          } else {
            next.push(f)
          }
        }
        return next.length === prev.length ? prev : next
      })
      if (removed.size === 0) return
      setActiveFilePath((current) => {
        if (!current || !removed.has(current)) return current
        const remaining = openFilesRef.current.filter((f) => !removed.has(f.path))
        return remaining.length > 0 ? remaining[remaining.length - 1].path : null
      })
      setFileVersions((prev) => {
        const next = new Map<string, number>()
        for (const [k, v] of prev) {
          if (!removed.has(k)) next.set(k, v)
        }
        return next
      })
    },
    []
  )

  const closeOtherFiles = useCallback(
    (filePath: string) => closeFilesByPredicate((f) => f.path !== filePath, true),
    [closeFilesByPredicate]
  )

  const closeFilesToRight = useCallback(
    (filePath: string) => {
      const idx = openFilesRef.current.findIndex((f) => f.path === filePath)
      if (idx === -1) return
      const rightPaths = new Set(openFilesRef.current.slice(idx + 1).map((f) => f.path))
      closeFilesByPredicate((f) => rightPaths.has(f.path), true)
    },
    [closeFilesByPredicate]
  )

  const closeSavedFiles = useCallback(
    () => closeFilesByPredicate(() => true, true),
    [closeFilesByPredicate]
  )

  const closeAllFiles = useCallback(
    () => closeFilesByPredicate(() => true, false),
    [closeFilesByPredicate]
  )

  const isDirty = useCallback(
    (filePath: string) => {
      const file = openFiles.find((f) => f.path === filePath)
      return file ? file.content !== file.originalContent : false
    },
    [openFiles]
  )

  const hasDirtyFiles = openFiles.some((f) => f.content !== f.originalContent)

  const isFileDiskChanged = useCallback(
    (filePath: string) => {
      const file = openFiles.find((f) => f.path === filePath)
      return file?.diskChanged ?? false
    },
    [openFiles]
  )

  const isFileDeleted = useCallback(
    (filePath: string) => {
      const file = openFiles.find((f) => f.path === filePath)
      return file?.deleted ?? false
    },
    [openFiles]
  )

  const renameOpenFile = useCallback((oldPath: string, newPath: string) => {
    // Remap exact match + children (folder moves: "src" → "lib/src" updates "src/index.ts" → "lib/src/index.ts")
    const prefix = oldPath + '/'
    const remap = (p: string) =>
      p === oldPath ? newPath : p.startsWith(prefix) ? newPath + p.slice(oldPath.length) : null

    setOpenFiles((prev) =>
      prev.map((f) => {
        const mapped = remap(f.path)
        return mapped ? { ...f, path: mapped } : f
      })
    )
    setActiveFilePath((current) => {
      if (!current) return current
      return remap(current) ?? current
    })
    setFileVersions((prev) => {
      let changed = false
      const next = new Map<string, number>()
      for (const [k, v] of prev) {
        const mapped = remap(k)
        if (mapped) {
          next.set(mapped, v)
          changed = true
        } else {
          next.set(k, v)
        }
      }
      return changed ? next : prev
    })
  }, [])

  const activeFile = openFiles.find((f) => f.path === activeFilePath) ?? null

  const refreshTree = useCallback(() => {
    setTreeRefreshKey((k) => k + 1)
  }, [])

  return {
    openFiles,
    activeFile,
    activeFilePath,
    setActiveFilePath,
    openFile,
    openFileForced,
    updateContent,
    saveFile,
    closeFile,
    closeOtherFiles,
    closeFilesToRight,
    closeSavedFiles,
    closeAllFiles,
    isDirty,
    hasDirtyFiles,
    isFileDiskChanged,
    isFileDeleted,
    renameOpenFile,
    refreshTree,
    isRestoring,
    treeRefreshKey,
    fileVersions,
    goToPosition,
    focusToken,
    clearGoToPosition: useCallback(() => setGoToPosition(null), [])
  }
}
