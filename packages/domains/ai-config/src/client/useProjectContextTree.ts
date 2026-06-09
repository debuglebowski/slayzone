import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import type { ContextTreeEntry } from '../shared'
import { useContextManagerStore } from './useContextManagerStore'
import { collectExpandedFolders } from './ProjectContextTree.utils'

interface UseProjectContextTreeArgs {
  projectPath: string
  projectId: string
}

/**
 * Owns the project context tree's data + editor state and every CRUD/sync handler.
 * The component consuming this stays a thin rendering layer.
 */
export function useProjectContextTree({ projectPath, projectId }: UseProjectContextTreeArgs) {
  const trpcClient = useTRPCClient()
  const [entries, setEntries] = useState<ContextTreeEntry[]>([])
  const [loading, setLoading] = useState(false)
  const selectedPath = useContextManagerStore((s) => s.projectSelectedPath)
  const setSelectedPath = useContextManagerStore((s) => s.setProjectSelectedPath)
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [showPicker, setShowPicker] = useState(false)
  const [creatingFile, setCreatingFile] = useState(false)
  const [newFilePath, setNewFilePath] = useState('')
  const storedExpandedFolders = useContextManagerStore((s) => s.projectExpandedFolders)
  const setStoredExpandedFolders = useContextManagerStore((s) => s.setProjectExpandedFolders)
  const expandedFolders = useMemo(() => new Set(storedExpandedFolders), [storedExpandedFolders])
  const setExpandedFolders = useCallback(
    (update: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      if (typeof update === 'function') {
        const next = update(expandedFolders)
        setStoredExpandedFolders([...next])
      } else {
        setStoredExpandedFolders([...update])
      }
    },
    [expandedFolders, setStoredExpandedFolders]
  )
  const [renamingEntry, setRenamingEntry] = useState<ContextTreeEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [syncing, setSyncing] = useState(false)

  const loadTree = useCallback(async () => {
    setLoading(true)
    try {
      const tree = await trpcClient.aiConfig.getContextTree.query({ projectPath, projectId })
      setEntries(tree)
      // Auto-expand all folders on first load
      const folders = collectExpandedFolders(tree)
      setExpandedFolders((prev) => (prev.size === 0 ? folders : prev))
    } finally {
      setLoading(false)
    }
  }, [trpcClient, projectPath, projectId])

  useEffect(() => {
    void loadTree()
  }, [loadTree])

  const toggleFolder = useCallback((folderPath: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folderPath)) next.delete(folderPath)
      else next.add(folderPath)
      return next
    })
  }, [])

  const openFile = async (entry: ContextTreeEntry) => {
    if (!entry.exists) {
      await trpcClient.aiConfig.writeContextFile.mutate({
        filePath: entry.path,
        content: '',
        projectPath
      })
      await loadTree()
    }
    try {
      const text = await trpcClient.aiConfig.readContextFile.query({
        filePath: entry.path,
        projectPath
      })
      setContent(text)
      setOriginalContent(text)
      setSelectedPath(entry.path)
      setMessage('')
    } catch {
      setMessage('Could not read file')
    }
  }

  const saveFile = async () => {
    if (!selectedPath) return
    setSaving(true)
    setMessage('')
    try {
      await trpcClient.aiConfig.writeContextFile.mutate({
        filePath: selectedPath,
        content,
        projectPath
      })
      setOriginalContent(content)
      setMessage('Saved')
      await loadTree()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleSync = async (entry: ContextTreeEntry) => {
    if (!entry.linkedItemId) return
    try {
      const updated = await trpcClient.aiConfig.syncLinkedFile.mutate({
        projectId,
        projectPath,
        itemId: entry.linkedItemId
      })
      setEntries((prev) => prev.map((e) => (e.path === updated.path ? updated : e)))
      if (selectedPath === entry.path) {
        const text = await trpcClient.aiConfig.readContextFile.query({
          filePath: entry.path,
          projectPath
        })
        setContent(text)
        setOriginalContent(text)
      }
      setMessage('Synced')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Sync failed')
    }
  }

  const handleUnlink = async (entry: ContextTreeEntry) => {
    if (!entry.linkedItemId) return
    await trpcClient.aiConfig.unlinkFile.mutate({ projectId, itemId: entry.linkedItemId })
    await loadTree()
  }

  const handleStartRename = (entry: ContextTreeEntry) => {
    setRenamingEntry(entry)
    setRenameValue(entry.relativePath)
  }

  const handleRename = async () => {
    if (!renamingEntry || !renameValue.trim()) return
    const newPath = renameValue.startsWith('/') ? renameValue : `${projectPath}/${renameValue}`
    try {
      await trpcClient.aiConfig.renameContextFile.mutate({
        oldPath: renamingEntry.path,
        newPath,
        projectPath
      })
      if (selectedPath === renamingEntry.path) setSelectedPath(newPath)
      await loadTree()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Rename failed')
    } finally {
      setRenamingEntry(null)
      setRenameValue('')
    }
  }

  const handleDelete = async (entry: ContextTreeEntry) => {
    await trpcClient.aiConfig.deleteContextFile.mutate({
      filePath: entry.path,
      projectPath,
      projectId
    })
    if (selectedPath === entry.path) {
      setSelectedPath(null)
      setContent('')
      setOriginalContent('')
    }
    await loadTree()
  }

  const handleCreateFile = async () => {
    if (!newFilePath.trim()) return
    const filePath = newFilePath.startsWith('/') ? newFilePath : `${projectPath}/${newFilePath}`
    try {
      await trpcClient.aiConfig.writeContextFile.mutate({
        filePath,
        content: '',
        projectPath
      })
      await loadTree()
      setCreatingFile(false)
      setNewFilePath('')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to create')
    }
  }

  const handleItemLoaded = async () => {
    setShowPicker(false)
    await loadTree()
  }

  const handleSyncAll = async () => {
    setSyncing(true)
    setMessage('')
    try {
      const result = await trpcClient.aiConfig.syncAll.mutate({ projectId, projectPath })
      const parts: string[] = []
      if (result.written.length) parts.push(`${result.written.length} written`)
      if (result.conflicts.length) parts.push(`${result.conflicts.length} conflicts`)
      setMessage(parts.join(', ') || 'Nothing to sync')
      await loadTree()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  const dirty = content !== originalContent
  const selectedEntry = entries.find((e) => e.path === selectedPath)
  const projectFiles = entries.filter((e) => !e.relativePath.startsWith('~'))
  const computerFiles = entries.filter((e) => e.relativePath.startsWith('~'))

  return {
    entries,
    loading,
    selectedPath,
    setSelectedPath,
    content,
    setContent,
    saving,
    message,
    showPicker,
    setShowPicker,
    creatingFile,
    setCreatingFile,
    newFilePath,
    setNewFilePath,
    expandedFolders,
    toggleFolder,
    renamingEntry,
    setRenamingEntry,
    renameValue,
    setRenameValue,
    syncing,
    openFile,
    saveFile,
    handleSync,
    handleUnlink,
    handleStartRename,
    handleRename,
    handleDelete,
    handleCreateFile,
    handleItemLoaded,
    handleSyncAll,
    dirty,
    selectedEntry,
    projectFiles,
    computerFiles
  }
}
