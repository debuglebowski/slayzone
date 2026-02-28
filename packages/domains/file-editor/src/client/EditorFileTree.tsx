import { useState, useCallback, useEffect, useRef } from 'react'
import {
  FilePlus,
  FolderPlus,
  Folder,
  FolderOpen,
  Pencil,
  Trash2
} from 'lucide-react'
import {
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Input
} from '@slayzone/ui'
import type { DirEntry } from '../shared'
import { FileIcon } from './FileIcon'

const INDENT_PX = 20
const BASE_PAD = 12

interface EditorFileTreeProps {
  projectPath: string
  onOpenFile: (path: string) => void
  onFileRenamed?: (oldPath: string, newPath: string) => void
  activeFilePath: string | null
  /** Increment to trigger reload of expanded directories */
  refreshKey?: number
  /** Controlled expanded folders (optional — uses internal state if not provided) */
  expandedFolders?: Set<string>
  onExpandedFoldersChange?: (folders: Set<string>) => void
}

export function EditorFileTree({ projectPath, onOpenFile, onFileRenamed, activeFilePath, refreshKey, expandedFolders: controlledExpanded, onExpandedFoldersChange }: EditorFileTreeProps) {
  // Map of dirPath -> children entries (lazy loaded)
  const [dirContents, setDirContents] = useState<Map<string, DirEntry[]>>(new Map())
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(new Set())
  const expandedFolders = controlledExpanded ?? internalExpanded
  const controlledRef = useRef(controlledExpanded)
  controlledRef.current = controlledExpanded
  const setExpandedFolders = useCallback((updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const update = (prev: Set<string>) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      onExpandedFoldersChange?.(next)
      return next
    }
    if (controlledRef.current) {
      // Controlled mode — compute and emit, parent owns state
      update(controlledRef.current)
    } else {
      setInternalExpanded(update)
    }
  }, [onExpandedFoldersChange])
  const [creating, setCreating] = useState<{ parentPath: string; type: 'file' | 'directory' } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const createInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // --- Drag and drop state ---
  const dragPathRef = useRef<string | null>(null)
  const dragTypeRef = useRef<'file' | 'directory' | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dropCounterRef = useRef<Map<string, number>>(new Map())

  const loadDir = useCallback(
    async (dirPath: string) => {
      const items = await window.api.fs.readDir(projectPath, dirPath)
      setDirContents((prev) => {
        const next = new Map(prev)
        next.set(dirPath, items)
        return next
      })
    },
    [projectPath]
  )

  // Load root on mount
  useEffect(() => {
    loadDir('')
  }, [loadDir])

  // Reload expanded dirs on external file changes
  useEffect(() => {
    if (!refreshKey) return
    loadDir('')
    expandedFolders.forEach((dir) => loadDir(dir))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  const handleToggleFolder = useCallback(
    (folderPath: string) => {
      setExpandedFolders((prev) => {
        const next = new Set(prev)
        if (next.has(folderPath)) {
          next.delete(folderPath)
        } else {
          next.add(folderPath)
          if (!dirContents.has(folderPath)) {
            loadDir(folderPath)
          }
        }
        return next
      })
    },
    [loadDir, dirContents]
  )

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
        } else {
          await window.api.fs.createDir(projectPath, newPath)
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
        onFileRenamed?.(oldPath, newPath)
        await loadDir(parentDir)
      } catch (err) {
        console.error('Rename failed:', err)
      }
      setRenaming(null)
    },
    [renaming, projectPath, loadDir, onFileRenamed]
  )

  const handleDelete = useCallback(
    async (entry: DirEntry) => {
      try {
        await window.api.fs.delete(projectPath, entry.path)
        const parentDir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
        await loadDir(parentDir)
      } catch (err) {
        console.error('Delete failed:', err)
      }
    },
    [projectPath, loadDir]
  )

  const startCreate = useCallback((parentPath: string, type: 'file' | 'directory') => {
    setCreating({ parentPath, type })
    if (parentPath) {
      setExpandedFolders((prev) => new Set([...prev, parentPath]))
      if (!dirContents.has(parentPath)) loadDir(parentPath)
    }
  }, [dirContents, loadDir])

  const startRename = useCallback((entry: DirEntry) => {
    setRenaming(entry.path)
    setRenameValue(entry.name)
  }, [])

  useEffect(() => {
    if (creating) createInputRef.current?.focus()
  }, [creating])
  useEffect(() => {
    if (renaming) renameInputRef.current?.focus()
  }, [renaming])

  // --- Drag and drop handlers ---
  const handleDragStart = useCallback((e: React.DragEvent, entry: DirEntry) => {
    dragPathRef.current = entry.path
    dragTypeRef.current = entry.type
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('application/x-slayzone-tree', entry.path)
    }
  }, [])

  const handleDragEnd = useCallback(() => {
    dragPathRef.current = null
    dragTypeRef.current = null
    setDropTarget(null)
    dropCounterRef.current.clear()
  }, [])

  const isValidDropTarget = useCallback((targetDir: string): boolean => {
    const src = dragPathRef.current
    if (!src) return false
    if (src === targetDir) return false
    const srcParent = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''
    if (srcParent === targetDir) return false
    if (dragTypeRef.current === 'directory' && targetDir.startsWith(src + '/')) return false
    return true
  }, [])

  const handleFolderDragOver = useCallback((e: React.DragEvent, folderPath: string) => {
    if (!dragPathRef.current) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = isValidDropTarget(folderPath) ? 'move' : 'none'
    }
  }, [isValidDropTarget])

  const handleFolderDragEnter = useCallback((e: React.DragEvent, folderPath: string) => {
    if (!dragPathRef.current) return
    e.preventDefault()
    e.stopPropagation()
    const count = (dropCounterRef.current.get(folderPath) ?? 0) + 1
    dropCounterRef.current.set(folderPath, count)
    if (isValidDropTarget(folderPath)) {
      setDropTarget(folderPath)
    }
  }, [isValidDropTarget])

  const handleFolderDragLeave = useCallback((e: React.DragEvent, folderPath: string) => {
    if (!dragPathRef.current) return
    e.preventDefault()
    e.stopPropagation()
    const count = (dropCounterRef.current.get(folderPath) ?? 0) - 1
    dropCounterRef.current.set(folderPath, count)
    if (count <= 0) {
      dropCounterRef.current.delete(folderPath)
      setDropTarget((cur) => (cur === folderPath ? null : cur))
    }
  }, [])

  const handleFolderDrop = useCallback(async (e: React.DragEvent, targetDir: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    dropCounterRef.current.clear()

    // Save refs BEFORE clearing — isValidDropTarget reads them
    const srcPath = dragPathRef.current
    if (!srcPath || !isValidDropTarget(targetDir)) {
      dragPathRef.current = null
      dragTypeRef.current = null
      return
    }
    dragPathRef.current = null
    dragTypeRef.current = null

    const name = srcPath.includes('/') ? srcPath.slice(srcPath.lastIndexOf('/') + 1) : srcPath
    const newPath = targetDir ? `${targetDir}/${name}` : name
    const srcParent = srcPath.includes('/') ? srcPath.slice(0, srcPath.lastIndexOf('/')) : ''

    try {
      await window.api.fs.rename(projectPath, srcPath, newPath)
      onFileRenamed?.(srcPath, newPath)

      // Remap expanded folder paths for moved directories
      const srcPrefix = srcPath + '/'
      setExpandedFolders((prev) => {
        let changed = false
        const next = new Set<string>()
        for (const p of prev) {
          if (p === srcPath) {
            next.add(newPath)
            changed = true
          } else if (p.startsWith(srcPrefix)) {
            next.add(newPath + p.slice(srcPath.length))
            changed = true
          } else {
            next.add(p)
          }
        }
        // Also expand target so the moved item is visible
        if (!next.has(targetDir) && targetDir) {
          next.add(targetDir)
          changed = true
        }
        return changed ? next : prev
      })

      await Promise.all([loadDir(srcParent), loadDir(targetDir)])
    } catch (err) {
      console.error('Move failed:', err)
    }
  }, [projectPath, loadDir, isValidDropTarget, onFileRenamed])

  const renderEntry = (entry: DirEntry, depth: number) => {
    const pad = depth * INDENT_PX + BASE_PAD

    if (entry.type === 'directory') {
      const expanded = expandedFolders.has(entry.path)
      const children = dirContents.get(entry.path) ?? []
      const isDropHover = dropTarget === entry.path
      return (
        <div
          key={`d:${entry.path}`}
          onDragOver={(e) => handleFolderDragOver(e, entry.path)}
          onDragEnter={(e) => handleFolderDragEnter(e, entry.path)}
          onDragLeave={(e) => handleFolderDragLeave(e, entry.path)}
          onDrop={(e) => handleFolderDrop(e, entry.path)}
          className={cn(isDropHover && 'bg-primary/10 ring-1 ring-primary/30 rounded')}
        >
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button
                draggable
                onDragStart={(e) => handleDragStart(e, entry)}
                onDragEnd={handleDragEnd}
                className={cn(
                  'group/folder flex w-full select-none items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-muted/50',
                  entry.ignored && 'opacity-40'
                )}
                style={{ paddingLeft: pad }}
                onClick={() => handleToggleFolder(entry.path)}
              >
                {expanded
                  ? <FolderOpen className="size-4 shrink-0 text-amber-400" />
                  : <Folder className="size-4 shrink-0 text-amber-500/80" />}
                <span className="truncate font-mono">{entry.name}</span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => startCreate(entry.path, 'file')}>
                <FilePlus className="size-3 mr-2" /> New file
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => startCreate(entry.path, 'directory')}>
                <FolderPlus className="size-3 mr-2" /> New folder
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => startRename(entry)}>
                <Pencil className="size-3 mr-2" /> Rename
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => handleDelete(entry)}>
                <Trash2 className="size-3 mr-2" /> Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>

          {expanded && children.map((child) => renderEntry(child, depth + 1))}

          {/* Inline create input inside this folder */}
          {creating && creating.parentPath === entry.path && (
            <div style={{ paddingLeft: (depth + 1) * INDENT_PX + BASE_PAD }} className="py-0.5">
              <Input
                ref={createInputRef}
                placeholder={creating.type === 'file' ? 'filename' : 'folder name'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate((e.target as HTMLInputElement).value)
                  if (e.key === 'Escape') setCreating(null)
                }}
                onBlur={(e) => handleCreate(e.target.value)}
                className="h-6 text-xs font-mono py-0 px-1"
              />
            </div>
          )}
        </div>
      )
    }

    // File entry
    if (renaming === entry.path) {
      return (
        <div key={`f:${entry.path}`} style={{ paddingLeft: pad }}>
          <Input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename(entry.path, renameValue)
              if (e.key === 'Escape') setRenaming(null)
            }}
            onBlur={() => handleRename(entry.path, renameValue)}
            aria-label="Rename file"
            className="h-6 text-xs font-mono py-0 px-1"
          />
        </div>
      )
    }

    return (
      <div key={`f:${entry.path}`}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              draggable
              onDragStart={(e) => handleDragStart(e, entry)}
              onDragEnd={handleDragEnd}
              className={cn(
                'flex w-full items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-muted/50',
                entry.path === activeFilePath && 'bg-muted text-foreground',
                entry.ignored && 'opacity-40'
              )}
              style={{ paddingLeft: pad }}
              onClick={() => onOpenFile(entry.path)}
            >
              <FileIcon fileName={entry.name} className="size-4 shrink-0 flex items-center [&>svg]:size-full" />
              <span className="truncate font-mono">{entry.name}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => startRename(entry)}>
              <Pencil className="size-3 mr-2" /> Rename
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => handleDelete(entry)}>
              <Trash2 className="size-3 mr-2" /> Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    )
  }

  const rootEntries = dirContents.get('') ?? []
  const isRootDropHover = dropTarget === ''

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
        className={cn(
          'h-full overflow-auto py-1 select-none text-sm bg-surface-1',
          isRootDropHover && 'bg-primary/5 ring-1 ring-inset ring-primary/20 rounded'
        )}
        onDragOver={(e) => {
          if (!dragPathRef.current) return
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = isValidDropTarget('') ? 'move' : 'none'
        }}
        onDragEnter={(e) => {
          if (!dragPathRef.current) return
          e.preventDefault()
          const count = (dropCounterRef.current.get('__root') ?? 0) + 1
          dropCounterRef.current.set('__root', count)
          if (isValidDropTarget('')) setDropTarget('')
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          const count = (dropCounterRef.current.get('__root') ?? 0) - 1
          dropCounterRef.current.set('__root', count)
          if (count <= 0) {
            dropCounterRef.current.delete('__root')
            setDropTarget((cur) => (cur === '' ? null : cur))
          }
        }}
        onDrop={(e) => handleFolderDrop(e, '')}
      >
        {rootEntries.map((entry) => renderEntry(entry, 0))}

        {/* Root-level create input */}
        {creating && creating.parentPath === '' && (
          <div className="px-2 py-0.5">
            <Input
              ref={createInputRef}
              placeholder={creating.type === 'file' ? 'filename' : 'folder name'}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate((e.target as HTMLInputElement).value)
                if (e.key === 'Escape') setCreating(null)
              }}
              onBlur={(e) => handleCreate(e.target.value)}
              className="h-6 text-xs font-mono py-0 px-1"
            />
          </div>
        )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => startCreate('', 'file')}>
          <FilePlus className="size-3 mr-2" /> New file
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => startCreate('', 'directory')}>
          <FolderPlus className="size-3 mr-2" /> New folder
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
