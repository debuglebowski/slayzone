import { useState, useCallback, useRef, useEffect } from 'react'
import { track } from '@slayzone/telemetry/client'
import type { EditorOpenFilesState, OpenFileOptions } from '@slayzone/file-editor/shared'

export interface OpenFile {
  path: string
  content: string | null
  originalContent: string | null
  tooLarge?: boolean
  sizeBytes?: number
  diskChanged?: boolean
  /** Non-text file rendered by dedicated viewer (image, etc.) */
  binary?: boolean
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'])

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return !!ext && IMAGE_EXTENSIONS.has(ext)
}

export function useFileEditor(
  projectPath: string,
  initialEditorState?: EditorOpenFilesState | null
) {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const [treeRefreshKey, setTreeRefreshKey] = useState(0)
  const pendingOpen = useRef<string | null>(null)
  const treeRefreshTimer = useRef<NodeJS.Timeout | null>(null)
  // Track version per file for CodeMirror external content reload
  const [fileVersions, setFileVersions] = useState<Map<string, number>>(new Map())
  const [goToPosition, setGoToPosition] = useState<{ filePath: string; line: number; col: number } | null>(null)

  // --- Restore persisted state on mount ---
  const [isRestoring, setIsRestoring] = useState(!!(initialEditorState?.files?.length))
  const hasRestored = useRef(false)
  useEffect(() => {
    if (hasRestored.current || !initialEditorState?.files?.length) return
    hasRestored.current = true
    ;(async () => {
      for (const filePath of initialEditorState.files) {
        try {
          if (isImageFile(filePath)) {
            setOpenFiles((prev) => {
              if (prev.some((f) => f.path === filePath)) return prev
              return [...prev, { path: filePath, content: null, originalContent: null, binary: true }]
            })
            continue
          }
          const result = await window.api.fs.readFile(projectPath, filePath)
          if (result.tooLarge) {
            setOpenFiles((prev) => {
              if (prev.some((f) => f.path === filePath)) return prev
              return [...prev, { path: filePath, content: null, originalContent: null, tooLarge: true, sizeBytes: result.sizeBytes }]
            })
          } else {
            setOpenFiles((prev) => {
              if (prev.some((f) => f.path === filePath)) return prev
              return [...prev, { path: filePath, content: result.content, originalContent: result.content }]
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

  // --- File watcher ---
  useEffect(() => {
    window.api.fs.watch(projectPath)
    return () => { window.api.fs.unwatch(projectPath) }
  }, [projectPath])

  const reloadFile = useCallback(async (filePath: string) => {
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

      const result = await window.api.fs.readFile(projectPath, filePath)
      if (result.tooLarge || result.content == null) return
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === filePath
            ? { ...f, content: result.content, originalContent: result.content, diskChanged: false }
            : f
        )
      )
      setFileVersions((prev) => {
        const next = new Map(prev)
        next.set(filePath, (next.get(filePath) ?? 0) + 1)
        return next
      })
    } catch {
      // File may have been deleted
    }
  }, [projectPath])

  const projectPathRef = useRef(projectPath)
  projectPathRef.current = projectPath

  useEffect(() => {
    const unsubscribe = window.api.fs.onFileChanged((rootPath, relPath) => {
      // Filter: only process events for this editor's project
      const normalize = (p: string) => p.replace(/\/+$/, '')
      if (normalize(rootPath) !== normalize(projectPathRef.current)) return

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
          next[fileIdx] = { ...file, diskChanged: true }
          return next
        }

        // Not dirty — schedule silent reload (async, outside setState)
        reloadFile(relPath)
        return prev
      })
    })

    return () => {
      unsubscribe()
      if (treeRefreshTimer.current) clearTimeout(treeRefreshTimer.current)
    }
  }, [reloadFile])

  // --- Open / close / save ---
  const openFile = useCallback(async (filePath: string, options?: OpenFileOptions) => {
    const from = options?.from ?? 'sidebar'
    if (options?.position) {
      setGoToPosition({ filePath, line: options.position.line, col: options.position.col ?? 0 })
    }
    // Already open — just focus
    const existing = openFiles.find((f) => f.path === filePath)
    if (existing) {
      setActiveFilePath(filePath)
      return
    }

    if (pendingOpen.current === filePath) return
    pendingOpen.current = filePath

    try {
      // Binary files (images etc.) — rendered via slz-file:// protocol, no content needed
      if (isImageFile(filePath)) {
        setOpenFiles((prev) => {
          if (prev.some((f) => f.path === filePath)) return prev
          return [...prev, { path: filePath, content: null, originalContent: null, binary: true }]
        })
        setActiveFilePath(filePath)
        track('editor_file_opened', { from })
        return
      }

      const result = await window.api.fs.readFile(projectPath, filePath)
      if (result.tooLarge) {
        setOpenFiles((prev) => {
          if (prev.some((f) => f.path === filePath)) return prev
          return [...prev, { path: filePath, content: null, originalContent: null, tooLarge: true, sizeBytes: result.sizeBytes }]
        })
        setActiveFilePath(filePath)
        track('editor_file_opened', { from })
        return
      }
      setOpenFiles((prev) => {
        if (prev.some((f) => f.path === filePath)) return prev
        return [...prev, { path: filePath, content: result.content, originalContent: result.content }]
      })
      setActiveFilePath(filePath)
      track('editor_file_opened', { from })
    } finally {
      pendingOpen.current = null
    }
  }, [projectPath, openFiles])

  const openFileForced = useCallback(async (filePath: string) => {
    try {
      const result = await window.api.fs.readFile(projectPath, filePath, true)
      if (result.content == null) return
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === filePath
            ? { ...f, content: result.content, originalContent: result.content, tooLarge: false, sizeBytes: undefined }
            : f
        )
      )
    } catch {
      // File read failed
    }
  }, [projectPath])

  const updateContent = useCallback((filePath: string, content: string) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === filePath ? { ...f, content } : f))
    )
  }, [])

  const saveFile = useCallback(async (filePath: string) => {
    const file = openFiles.find((f) => f.path === filePath)
    if (!file || file.content == null || file.content === file.originalContent) return
    await window.api.fs.writeFile(projectPath, filePath, file.content)
    setOpenFiles((prev) =>
      prev.map((f) =>
        f.path === filePath ? { ...f, originalContent: f.content, diskChanged: false } : f
      )
    )
  }, [projectPath, openFiles])

  const closeFile = useCallback((filePath: string) => {
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
  }, [openFiles])

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
    isDirty,
    hasDirtyFiles,
    isFileDiskChanged,
    renameOpenFile,
    refreshTree,
    isRestoring,
    treeRefreshKey,
    fileVersions,
    goToPosition,
    clearGoToPosition: useCallback(() => setGoToPosition(null), [])
  }
}
