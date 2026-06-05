import { useState, useCallback, useEffect, useRef } from 'react'
import { track } from '@slayzone/telemetry/client'
import type { DirEntry } from '../shared'

export interface CreatingState {
  parentPath: string
  type: 'file' | 'directory'
}

interface UseFileTreeCrudArgs {
  projectPath: string
  loadDir: (dirPath: string) => Promise<DirEntry[]>
  dirContents: Map<string, DirEntry[]>
  setExpandedFolders: (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => void
  onOpenFile: (path: string) => void
  onFileRenamed?: (oldPath: string, newPath: string) => void
  selectedPaths: Set<string>
  setSelectedPaths: (paths: Set<string>) => void
}

export function useFileTreeCrud({
  projectPath,
  loadDir,
  dirContents,
  setExpandedFolders,
  onOpenFile,
  onFileRenamed,
  selectedPaths,
  setSelectedPaths
}: UseFileTreeCrudArgs) {
  const [creating, setCreating] = useState<CreatingState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const willCreateRef = useRef(false)
  const createInputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) requestAnimationFrame(() => node.focus())
  }, [])
  const preventAutoFocus = useCallback((e: Event) => {
    if (willCreateRef.current) {
      e.preventDefault()
      willCreateRef.current = false
    }
  }, [])
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameValueRef = useRef('')

  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)

  const handleCreate = useCallback(
    async (name: string) => {
      if (!creating || !name.trim()) {
        setCreating(null)
        return
      }
      const newPath = creating.parentPath ? `${creating.parentPath}/${name.trim()}` : name.trim()
      try {
        if (creating.type === 'file') {
          await window.api.fs.createFile(projectPath, newPath)
          track('file_created')
        } else {
          await window.api.fs.createDir(projectPath, newPath)
          track('folder_created')
        }
        await loadDir(creating.parentPath)
        if (creating.type === 'file') {
          onOpenFile(newPath)
        }
      } catch (err) {
        console.error('Create failed:', err)
      }
      setCreating(null)
    },
    [creating, projectPath, loadDir, onOpenFile]
  )

  const handleRename = useCallback(
    async (oldPath: string, newName: string) => {
      if (!newName.trim() || !renaming) {
        setRenaming(null)
        return
      }
      const parentDir = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : ''
      const newPath = parentDir ? `${parentDir}/${newName.trim()}` : newName.trim()
      try {
        await window.api.fs.rename(projectPath, oldPath, newPath)
        track('file_renamed')
        onFileRenamed?.(oldPath, newPath)
        const srcPrefix = oldPath + '/'
        setExpandedFolders((prev) => {
          let changed = false
          const next = new Set<string>()
          for (const p of prev) {
            if (p === oldPath) {
              next.add(newPath)
              changed = true
            } else if (p.startsWith(srcPrefix)) {
              next.add(newPath + p.slice(oldPath.length))
              changed = true
            } else {
              next.add(p)
            }
          }
          return changed ? next : prev
        })
        await loadDir(parentDir)
      } catch (err) {
        console.error('Rename failed:', err)
      }
      setRenaming(null)
    },
    [renaming, projectPath, loadDir, onFileRenamed, setExpandedFolders]
  )

  const executeDelete = useCallback(
    async (paths: string[]) => {
      const dirsToReload = new Set<string>()
      for (const p of paths) {
        try {
          await window.api.fs.delete(projectPath, p)
          track('file_deleted')
          dirsToReload.add(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
        } catch (err) {
          console.error('Delete failed:', err)
        }
      }
      setSelectedPaths(new Set())
      for (const dir of dirsToReload) await loadDir(dir)
    },
    [projectPath, loadDir, setSelectedPaths]
  )

  const handleDeleteSelected = useCallback(
    (entry: DirEntry) => {
      const paths =
        selectedPaths.has(entry.path) && selectedPaths.size > 1 ? [...selectedPaths] : [entry.path]
      if (paths.length > 1) {
        setConfirmDelete(paths)
      } else {
        executeDelete(paths)
      }
    },
    [selectedPaths, executeDelete]
  )

  const startCreate = useCallback(
    (parentPath: string, type: 'file' | 'directory') => {
      willCreateRef.current = true
      setCreating({ parentPath, type })
      if (parentPath) {
        setExpandedFolders((prev) => new Set([...prev, parentPath]))
        if (!dirContents.has(parentPath)) loadDir(parentPath)
      }
    },
    [dirContents, loadDir, setExpandedFolders]
  )

  const startRename = useCallback((entry: DirEntry) => {
    setRenaming(entry.path)
    setRenameValue(entry.name)
    renameValueRef.current = entry.name
  }, [])

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus()
  }, [renaming])

  return {
    creating,
    setCreating,
    renaming,
    setRenaming,
    renameValue,
    setRenameValue,
    renameInputRef,
    renameValueRef,
    createInputRef,
    preventAutoFocus,
    confirmDelete,
    setConfirmDelete,
    handleCreate,
    handleRename,
    executeDelete,
    handleDeleteSelected,
    startCreate,
    startRename
  }
}
