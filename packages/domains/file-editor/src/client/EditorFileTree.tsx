import { useState, useCallback, useEffect, useRef, useMemo, forwardRef, useImperativeHandle } from 'react'
import { track } from '@slayzone/telemetry/client'
import {
  File,
  FilePlus,
  FolderPlus,
  Folder,
  FolderOpen,
  Pencil,
  Trash2,
  Scissors,
  Copy,
  CopyPlus,
  ClipboardPaste,
  FolderSearch,
  ArrowUpRight,
  Link2
} from 'lucide-react'
import {
  cn,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  Input
} from '@slayzone/ui'
import type { DirEntry, GitFileStatus } from '../shared'
import { FileIcon } from './FileIcon'

const INDENT_PX = 20
const BASE_PAD = 12

const STATUS_PRIORITY: Record<GitFileStatus, number> = {
  conflicted: 6, modified: 5, deleted: 4, staged: 3, added: 2, renamed: 1, untracked: 0
}

const GIT_STATUS_INFO: Record<GitFileStatus, { letter: string; colorClass: string }> = {
  modified:  { letter: 'M', colorClass: 'text-amber-400' },
  deleted:   { letter: 'D', colorClass: 'text-amber-400' },
  staged:    { letter: 'S', colorClass: 'text-green-400' },
  added:     { letter: 'A', colorClass: 'text-green-400' },
  renamed:   { letter: 'R', colorClass: 'text-green-400' },
  untracked: { letter: 'U', colorClass: 'text-muted-foreground' },
  conflicted:{ letter: 'C', colorClass: 'text-red-400' },
}

function gitStatusColor(status: GitFileStatus | undefined): string | undefined {
  return status ? GIT_STATUS_INFO[status]?.colorClass : undefined
}

function GitStatusBadge({ status }: { status: GitFileStatus | undefined }) {
  if (!status) return null
  const info = GIT_STATUS_INFO[status]
  return <span className={cn('ml-auto text-[10px] font-medium shrink-0', info.colorClass)}>{info.letter}</span>
}

interface CompactedEntry {
  entry: DirEntry
  displayName: string
  /** All dir paths in a compacted chain (including the leaf). Empty for files / non-compacted dirs. */
  chainPaths: string[]
}

function compactChildren(parentPath: string, dirContents: Map<string, DirEntry[]>): CompactedEntry[] {
  const children = dirContents.get(parentPath) ?? []
  return children.map((child) => {
    if (child.type !== 'directory') {
      return { entry: child, displayName: child.name, chainPaths: [] }
    }
    // Walk single-child directory chains
    const segments = [child.name]
    const chain = [child.path]
    let current = child
    while (true) {
      const sub = dirContents.get(current.path)
      if (!sub || sub.length !== 1 || sub[0].type !== 'directory') break
      current = sub[0]
      segments.push(current.name)
      chain.push(current.path)
    }
    return {
      entry: current, // leaf directory
      displayName: segments.join('/'),
      chainPaths: chain
    }
  })
}

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

export interface EditorFileTreeHandle {
  scrollToPath: (path: string) => void
}

export const EditorFileTree = forwardRef<EditorFileTreeHandle, EditorFileTreeProps>(function EditorFileTree({ projectPath, onOpenFile, onFileRenamed, activeFilePath, refreshKey, expandedFolders: controlledExpanded, onExpandedFoldersChange }, ref) {
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
      update(controlledRef.current)
    } else {
      setInternalExpanded(update)
    }
  }, [onExpandedFoldersChange])
  const [creating, setCreating] = useState<{ parentPath: string; type: 'file' | 'directory' } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const willCreateRef = useRef(false)
  const createInputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) requestAnimationFrame(() => node.focus())
  }, [])
  const preventAutoFocus = useCallback((e: Event) => {
    if (willCreateRef.current) { e.preventDefault(); willCreateRef.current = false }
  }, [])
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameValueRef = useRef('')

  // --- Drag and drop state ---
  const dragPathRef = useRef<string | null>(null)
  const dragTypeRef = useRef<'file' | 'directory' | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dropCounterRef = useRef<Map<string, number>>(new Map())

  // --- Multi-select state ---
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)

  // --- Focus state for keyboard navigation ---
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const treeContainerRef = useRef<HTMLDivElement>(null)

  // --- Internal clipboard for copy/cut ---
  const [clipboard, setClipboard] = useState<{ paths: string[]; mode: 'copy' | 'cut' } | null>(null)

  // --- Git status ---
  const [gitStatus, setGitStatus] = useState<Map<string, GitFileStatus>>(new Map())

  useEffect(() => {
    let cancelled = false
    window.api.fs.gitStatus(projectPath).then((result) => {
      if (cancelled || !result.isGitRepo) return
      setGitStatus(new Map(Object.entries(result.files)))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [projectPath, refreshKey])

  const dirGitStatus = useMemo(() => {
    const dirs = new Map<string, GitFileStatus>()
    for (const [filePath, status] of gitStatus) {
      const parts = filePath.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dirPath = parts.slice(0, i).join('/')
        const current = dirs.get(dirPath)
        if (!current || STATUS_PRIORITY[status] > STATUS_PRIORITY[current]) {
          dirs.set(dirPath, status)
        }
      }
    }
    return dirs
  }, [gitStatus])

  // --- Flat visible entries for keyboard nav + shift-click ---
  const visibleEntries = useMemo(() => {
    const result: Array<{ entry: DirEntry; depth: number; displayName: string; chainPaths: string[] }> = []
    function walk(parentPath: string, depth: number) {
      for (const c of compactChildren(parentPath, dirContents)) {
        result.push({ entry: c.entry, depth, displayName: c.displayName, chainPaths: c.chainPaths })
        if (c.entry.type === 'directory' && expandedFolders.has(c.entry.path)) {
          walk(c.entry.path, depth + 1)
        }
      }
    }
    walk('', 0)
    return result
  }, [dirContents, expandedFolders])

  const loadDir = useCallback(
    async (dirPath: string) => {
      const items = await window.api.fs.readDir(projectPath, dirPath)
      setDirContents((prev) => {
        const next = new Map(prev)
        next.set(dirPath, items)
        return next
      })
      return items
    },
    [projectPath]
  )

  // Load root + persisted expanded folders on mount
  useEffect(() => {
    loadDir('')
    expandedFolders.forEach((dir) => loadDir(dir))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDir])

  // Reload expanded dirs on external file changes + clear collapsed folder caches
  useEffect(() => {
    if (!refreshKey) return
    loadDir('')
    expandedFolders.forEach((dir) => loadDir(dir))
    setDirContents((prev) => {
      const keep = new Set(['', ...expandedFolders])
      let changed = false
      for (const key of prev.keys()) {
        if (!keep.has(key)) { changed = true; break }
      }
      if (!changed) return prev
      const next = new Map<string, DirEntry[]>()
      for (const key of keep) {
        const val = prev.get(key)
        if (val) next.set(key, val)
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // --- Imperative handle for scroll-to-path ---
  useImperativeHandle(ref, () => ({
    scrollToPath: (filePath: string) => {
      const el = treeContainerRef.current?.querySelector(`[data-path="${CSS.escape(filePath)}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    }
  }), [])

  const handleToggleFolder = useCallback(
    async (folderPath: string, chainPaths?: string[]) => {
      const allPaths = chainPaths?.length ? chainPaths : [folderPath]

      if (expandedFolders.has(folderPath)) {
        // Collapsing — remove all chain paths
        setExpandedFolders((prev) => {
          const next = new Set(prev)
          for (const p of allPaths) next.delete(p)
          return next
        })
        return
      }

      // Expanding — load chain + auto-expand single-child dirs
      const toExpand = [...allPaths]
      const loaded = new Map<string, DirEntry[]>()

      const getOrLoad = async (dirPath: string): Promise<DirEntry[]> => {
        const cached = dirContents.get(dirPath) ?? loaded.get(dirPath)
        if (cached) return cached
        const items = await loadDir(dirPath)
        loaded.set(dirPath, items)
        return items
      }

      for (const p of allPaths) {
        await getOrLoad(p)
      }

      // Auto-expand until we hit a dir with 2+ children (or file/empty)
      let leaf = folderPath
      for (let i = 0; i < 20; i++) {
        const children = await getOrLoad(leaf)
        if (children.length === 1 && children[0].type === 'directory') {
          toExpand.push(children[0].path)
          leaf = children[0].path
        } else {
          break
        }
      }

      setExpandedFolders((prev) => {
        const next = new Set(prev)
        for (const p of toExpand) next.add(p)
        return next
      })
    },
    [loadDir, dirContents, expandedFolders]
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
    [projectPath, loadDir]
  )

  const handleDeleteSelected = useCallback(
    (entry: DirEntry) => {
      const paths = selectedPaths.has(entry.path) && selectedPaths.size > 1
        ? [...selectedPaths]
        : [entry.path]
      if (paths.length > 1) {
        setConfirmDelete(paths)
      } else {
        executeDelete(paths)
      }
    },
    [selectedPaths, executeDelete]
  )

  const startCreate = useCallback((parentPath: string, type: 'file' | 'directory') => {
    willCreateRef.current = true
    setCreating({ parentPath, type })
    if (parentPath) {
      setExpandedFolders((prev) => new Set([...prev, parentPath]))
      if (!dirContents.has(parentPath)) loadDir(parentPath)
    }
  }, [dirContents, loadDir])

  const startRename = useCallback((entry: DirEntry) => {
    setRenaming(entry.path)
    setRenameValue(entry.name)
    renameValueRef.current = entry.name
  }, [])

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus()
  }, [renaming])

  // --- Auto-scroll focused entry into view ---
  useEffect(() => {
    if (!focusedPath) return
    const el = treeContainerRef.current?.querySelector(`[data-path="${CSS.escape(focusedPath)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusedPath])

  // --- Clipboard operations ---
  const getEffectiveSelection = useCallback((entry: DirEntry): string[] => {
    if (selectedPaths.has(entry.path) && selectedPaths.size > 1) return [...selectedPaths]
    return [entry.path]
  }, [selectedPaths])

  const handleCopy = useCallback((paths: string[]) => {
    setClipboard({ paths, mode: 'copy' })
    track('file_copied')
  }, [])

  const handleCut = useCallback((paths: string[]) => {
    setClipboard({ paths, mode: 'cut' })
    track('file_cut')
  }, [])

  const resolveCollision = useCallback((basePath: string, parentDir: string): string => {
    const siblings = dirContents.get(parentDir) ?? []
    const names = new Set(siblings.map(s => s.name))
    const name = basePath.includes('/') ? basePath.slice(basePath.lastIndexOf('/') + 1) : basePath
    if (!names.has(name)) return basePath

    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
    const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
    for (let i = 1; ; i++) {
      const candidate = `${stem} (${i})${ext}`
      if (!names.has(candidate)) return parentDir ? `${parentDir}/${candidate}` : candidate
    }
  }, [dirContents])

  const handlePaste = useCallback(async (targetDir: string) => {
    if (!clipboard) return
    // Ensure target dir is loaded
    if (!dirContents.has(targetDir)) await loadDir(targetDir)
    const dirsToReload = new Set<string>([targetDir])
    for (const srcPath of clipboard.paths) {
      const name = srcPath.includes('/') ? srcPath.slice(srcPath.lastIndexOf('/') + 1) : srcPath
      const rawDest = targetDir ? `${targetDir}/${name}` : name
      const destPath = resolveCollision(rawDest, targetDir)
      try {
        if (clipboard.mode === 'copy') {
          await window.api.fs.copy(projectPath, srcPath, destPath)
        } else {
          await window.api.fs.rename(projectPath, srcPath, destPath)
          onFileRenamed?.(srcPath, destPath)
          const srcParent = srcPath.includes('/') ? srcPath.slice(0, srcPath.lastIndexOf('/')) : ''
          dirsToReload.add(srcParent)
        }
      } catch (err) {
        console.error('Paste failed:', err)
      }
    }
    if (clipboard.mode === 'cut') setClipboard(null)
    track('file_pasted')
    for (const dir of dirsToReload) await loadDir(dir)
  }, [clipboard, projectPath, loadDir, resolveCollision, onFileRenamed, dirContents])

  const handleDuplicate = useCallback(async (entries: DirEntry[]) => {
    const dirsToReload = new Set<string>()
    for (const entry of entries) {
      const parentDir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
      const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.')) : ''
      const stem = entry.name.includes('.') ? entry.name.slice(0, entry.name.lastIndexOf('.')) : entry.name
      const siblings = dirContents.get(parentDir) ?? []
      const names = new Set(siblings.map(s => s.name))
      let destName = `${stem} (copy)${ext}`
      if (names.has(destName)) {
        for (let i = 2; ; i++) {
          destName = `${stem} (copy ${i})${ext}`
          if (!names.has(destName)) break
        }
      }
      const destPath = parentDir ? `${parentDir}/${destName}` : destName
      try {
        await window.api.fs.copy(projectPath, entry.path, destPath)
        dirsToReload.add(parentDir)
      } catch (err) {
        console.error('Duplicate failed:', err)
      }
    }
    track('file_duplicated')
    for (const dir of dirsToReload) await loadDir(dir)
  }, [projectPath, dirContents, loadDir])

  const handleCopyPath = useCallback((entry: DirEntry, absolute: boolean) => {
    const text = absolute ? `${projectPath}/${entry.path}` : entry.path
    navigator.clipboard.writeText(text)
    track('path_copied')
  }, [projectPath])

  const handleRevealInFinder = useCallback((entry: DirEntry) => {
    window.api.fs.showInFinder(projectPath, entry.path)
    track('reveal_in_finder')
  }, [projectPath])

  // --- Click handler with modifier support ---
  const handleEntryClick = useCallback((e: React.MouseEvent, entry: DirEntry, chainPaths?: string[]) => {
    const isMeta = e.metaKey || e.ctrlKey
    const isShift = e.shiftKey

    if (isMeta) {
      setSelectedPaths(prev => {
        const next = new Set(prev)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
      lastClickedRef.current = entry.path
    } else if (isShift && lastClickedRef.current) {
      const startIdx = visibleEntries.findIndex(v => v.entry.path === lastClickedRef.current)
      const endIdx = visibleEntries.findIndex(v => v.entry.path === entry.path)
      if (startIdx >= 0 && endIdx >= 0) {
        const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
        const range = new Set(visibleEntries.slice(lo, hi + 1).map(v => v.entry.path))
        setSelectedPaths(range)
      }
    } else {
      setSelectedPaths(new Set([entry.path]))
      lastClickedRef.current = entry.path
      if (entry.type === 'file') onOpenFile(entry.path)
      else handleToggleFolder(entry.path, chainPaths)
    }
    setFocusedPath(entry.path)
  }, [visibleEntries, onOpenFile, handleToggleFolder])

  // --- Drag and drop handlers ---
  const handleDragStart = useCallback((e: React.DragEvent, entry: DirEntry) => {
    dragPathRef.current = entry.path
    dragTypeRef.current = entry.type
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      // If entry is in selection, encode all selected paths
      const paths = selectedPaths.has(entry.path) && selectedPaths.size > 1
        ? [...selectedPaths]
        : [entry.path]
      e.dataTransfer.setData('application/x-slayzone-tree', JSON.stringify(paths))
    }
  }, [selectedPaths])

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

  // --- Keyboard navigation ---
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't intercept when inside an input (create/rename)
    if ((e.target as HTMLElement).tagName === 'INPUT') return

    const meta = e.metaKey || e.ctrlKey

    if (meta && e.key === 'ArrowLeft') {
      e.preventDefault()
      setExpandedFolders(new Set())
      return
    }

    if (meta && e.key === 'c') {
      e.preventDefault()
      const paths = selectedPaths.size > 0 ? [...selectedPaths] : focusedPath ? [focusedPath] : []
      if (paths.length) handleCopy(paths)
      return
    }

    if (meta && e.key === 'x') {
      e.preventDefault()
      const paths = selectedPaths.size > 0 ? [...selectedPaths] : focusedPath ? [focusedPath] : []
      if (paths.length) handleCut(paths)
      return
    }

    if (meta && e.key === 'v') {
      e.preventDefault()
      if (!clipboard) return
      let targetDir = ''
      if (focusedPath) {
        const focused = visibleEntries.find(v => v.entry.path === focusedPath)
        if (focused) {
          targetDir = focused.entry.type === 'directory'
            ? focused.entry.path
            : focused.entry.path.includes('/') ? focused.entry.path.slice(0, focused.entry.path.lastIndexOf('/')) : ''
        }
      }
      handlePaste(targetDir)
      return
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      const paths = selectedPaths.size > 0 ? [...selectedPaths] : focusedPath ? [focusedPath] : []
      if (!paths.length) return
      if (paths.length > 1) {
        setConfirmDelete(paths)
      } else {
        executeDelete(paths).then(() => setFocusedPath(null))
      }
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      setFocusedPath(null)
      setSelectedPaths(new Set())
      if (clipboard?.mode === 'cut') setClipboard(null)
      treeContainerRef.current?.blur()
      return
    }

    const currentIdx = focusedPath
      ? visibleEntries.findIndex(v => v.entry.path === focusedPath)
      : -1

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const nextIdx = currentIdx + 1
      if (nextIdx < visibleEntries.length) {
        setFocusedPath(visibleEntries[nextIdx].entry.path)
        if (!e.shiftKey) setSelectedPaths(new Set([visibleEntries[nextIdx].entry.path]))
      }
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prevIdx = currentIdx <= 0 ? 0 : currentIdx - 1
      if (visibleEntries.length > 0) {
        setFocusedPath(visibleEntries[prevIdx].entry.path)
        if (!e.shiftKey) setSelectedPaths(new Set([visibleEntries[prevIdx].entry.path]))
      }
      return
    }

    if (e.key === 'ArrowRight') {
      e.preventDefault()
      if (currentIdx < 0) return
      const { entry, chainPaths } = visibleEntries[currentIdx]
      if (entry.type === 'directory') {
        if (!expandedFolders.has(entry.path)) {
          handleToggleFolder(entry.path, chainPaths.length ? chainPaths : undefined)
        } else {
          // Move focus to first child
          if (currentIdx + 1 < visibleEntries.length) {
            const nextEntry = visibleEntries[currentIdx + 1]
            // Verify it's actually a child
            if (nextEntry.entry.path.startsWith(entry.path + '/')) {
              setFocusedPath(nextEntry.entry.path)
              setSelectedPaths(new Set([nextEntry.entry.path]))
            }
          }
        }
      }
      return
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (currentIdx < 0) return
      const { entry, chainPaths } = visibleEntries[currentIdx]
      if (entry.type === 'directory' && expandedFolders.has(entry.path)) {
        handleToggleFolder(entry.path, chainPaths.length ? chainPaths : undefined)
      } else {
        // Move focus to parent
        const parentPath = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
        if (parentPath) {
          setFocusedPath(parentPath)
          setSelectedPaths(new Set([parentPath]))
        }
      }
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      if (currentIdx < 0) return
      const entry = visibleEntries[currentIdx].entry
      if (entry.type === 'file') onOpenFile(entry.path)
      else handleToggleFolder(entry.path)
      return
    }
  }, [focusedPath, selectedPaths, visibleEntries, expandedFolders, clipboard,
    handleToggleFolder, onOpenFile, handleCopy, handleCut, handlePaste, executeDelete])

  // --- Context menu items builder ---
  const renderContextMenuItems = useCallback((entry: DirEntry, isFolder: boolean) => {
    const effectivePaths = getEffectiveSelection(entry)
    const effectiveEntries = effectivePaths.map(p => visibleEntries.find(v => v.entry.path === p)?.entry).filter((e): e is DirEntry => !!e)
    const parentDir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''

    return (
      <>
        {isFolder && (
          <>
            <ContextMenuItem onSelect={() => startCreate(entry.path, 'file')}>
              <FilePlus className="size-3 mr-2" /> New file
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => startCreate(entry.path, 'directory')}>
              <FolderPlus className="size-3 mr-2" /> New folder
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={() => handleCut(effectivePaths)}>
          <Scissors className="size-3 mr-2" /> Cut
          <ContextMenuShortcut>⌘X</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleCopy(effectivePaths)}>
          <Copy className="size-3 mr-2" /> Copy
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        {clipboard && (
          <ContextMenuItem onSelect={() => handlePaste(isFolder ? entry.path : parentDir)}>
            <ClipboardPaste className="size-3 mr-2" /> Paste
            <ContextMenuShortcut>⌘V</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => handleDuplicate(effectiveEntries.length > 0 ? effectiveEntries : [entry])}>
          <CopyPlus className="size-3 mr-2" /> Duplicate
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => startRename(entry)}>
          <Pencil className="size-3 mr-2" /> Rename
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleCopyPath(entry, false)}>
          <Link2 className="size-3 mr-2" /> Copy Relative Path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleCopyPath(entry, true)}>
          <Copy className="size-3 mr-2" /> Copy Path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleRevealInFinder(entry)}>
          <FolderSearch className="size-3 mr-2" /> Reveal in Finder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => handleDeleteSelected(entry)}>
          <Trash2 className="size-3 mr-2" /> Delete
        </ContextMenuItem>
      </>
    )
  }, [getEffectiveSelection, visibleEntries, clipboard, handleCut, handleCopy, handlePaste, handleDuplicate, handleCopyPath, handleRevealInFinder, handleDeleteSelected, startCreate, startRename])

  const renderEntry = (entry: DirEntry, depth: number, displayName?: string, chainPaths?: string[]) => {
    const pad = depth * INDENT_PX + BASE_PAD
    const isSelected = selectedPaths.has(entry.path)
    const isFocused = focusedPath === entry.path
    const isCut = clipboard?.mode === 'cut' && clipboard.paths.includes(entry.path)
    const label = displayName ?? entry.name

    if (entry.type === 'directory') {
      const expanded = expandedFolders.has(entry.path)
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
          {renaming === entry.path ? (
            <div style={{ paddingLeft: pad }} className="flex items-center gap-1.5 py-0.5">
              <Folder className="size-4 shrink-0 text-amber-500/80" />
              <Input
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => { setRenameValue(e.target.value); renameValueRef.current = e.target.value }}
                onKeyDownCapture={(e) => {
                  if (e.key === 'Escape') { renameValueRef.current = ''; setRenaming(null) }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRename(entry.path, renameValueRef.current)
                }}
                onBlur={() => { if (renameValueRef.current.trim()) handleRename(entry.path, renameValueRef.current) }}
                className="h-6 text-xs font-mono py-0 px-1"
                data-testid="rename-input"
              />
            </div>
          ) : (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  draggable
                  onDragStart={(e) => handleDragStart(e, entry)}
                  onDragEnd={handleDragEnd}
                  data-path={entry.path}
                  className={cn(
                    'group/folder flex w-full select-none items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-muted/50',
                    isSelected && 'bg-primary/15',
                    isFocused && 'ring-1 ring-primary/40',
                    isCut && 'opacity-40',
                    entry.ignored && 'opacity-40'
                  )}
                  style={{ paddingLeft: pad }}
                  onClick={(e) => handleEntryClick(e, entry, chainPaths)}
                >
                  {expanded
                    ? <FolderOpen className="size-4 shrink-0 text-amber-400" />
                    : <Folder className="size-4 shrink-0 text-amber-500/80" />}
                  <span className={cn("truncate font-mono", gitStatusColor(dirGitStatus.get(entry.path)), entry.ignored && 'italic')}>{label}</span>
                  <GitStatusBadge status={dirGitStatus.get(entry.path)} />
                  {entry.isSymlink && (
                    <span title="Symbolic link"><ArrowUpRight className="size-3 shrink-0 text-muted-foreground/60" /></span>
                  )}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent onCloseAutoFocus={preventAutoFocus}>
                {renderContextMenuItems(entry, true)}
              </ContextMenuContent>
            </ContextMenu>
          )}

          {expanded && compactChildren(entry.path, dirContents).map((c) =>
            renderEntry(c.entry, depth + 1, c.displayName, c.chainPaths)
          )}

          {/* Inline create input inside this folder */}
          {creating && creating.parentPath === entry.path && (
            <div style={{ paddingLeft: (depth + 1) * INDENT_PX + BASE_PAD }} className="flex items-center gap-1.5 py-0.5">
              {creating.type === 'file'
                ? <File className="size-4 shrink-0 text-muted-foreground" />
                : <Folder className="size-4 shrink-0 text-amber-500/80" />}
              <Input
                ref={createInputRef}
                placeholder={creating.type === 'file' ? 'filename' : 'folder name'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate((e.target as HTMLInputElement).value)
                  if (e.key === 'Escape') setCreating(null)
                }}
                onBlur={(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (v) handleCreate(v) }}
                className="h-6 text-xs font-mono py-0 px-1 border-0 focus-visible:ring-0 shadow-none"
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
            onChange={(e) => { setRenameValue(e.target.value); renameValueRef.current = e.target.value }}
            onKeyDownCapture={(e) => {
              if (e.key === 'Escape') { renameValueRef.current = ''; setRenaming(null) }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename(entry.path, renameValueRef.current)
            }}
            onBlur={() => { if (renameValueRef.current.trim()) handleRename(entry.path, renameValueRef.current) }}
            className="h-6 text-xs font-mono py-0 px-1"
            data-testid="rename-input"
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
              data-path={entry.path}
              className={cn(
                'flex w-full items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-muted/50',
                isSelected && 'bg-primary/15',
                entry.path === activeFilePath && !isSelected && 'bg-muted text-foreground',
                isFocused && 'ring-1 ring-primary/40',
                isCut && 'opacity-40',
                entry.ignored && 'opacity-40'
              )}
              style={{ paddingLeft: pad }}
              onClick={(e) => handleEntryClick(e, entry)}
            >
              <FileIcon fileName={entry.name} className="size-4 shrink-0 flex items-center [&>svg]:size-full" />
              <span className={cn("truncate font-mono", gitStatusColor(gitStatus.get(entry.path)), entry.ignored && 'italic')}>{entry.name}</span>
              <GitStatusBadge status={gitStatus.get(entry.path)} />
              {entry.isSymlink && (
                <span title="Symbolic link"><ArrowUpRight className="size-3 shrink-0 text-muted-foreground/60" /></span>
              )}
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent onCloseAutoFocus={preventAutoFocus}>
            {renderContextMenuItems(entry, false)}
          </ContextMenuContent>
        </ContextMenu>
      </div>
    )
  }

  const rootCompacted = compactChildren('', dirContents)
  const isRootDropHover = dropTarget === ''

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
        ref={treeContainerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className={cn(
          'h-full overflow-auto py-1 select-none text-sm bg-surface-1 outline-none',
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
        {rootCompacted.map((c) => renderEntry(c.entry, 0, c.displayName, c.chainPaths))}

        {/* Root-level create input */}
        {creating && creating.parentPath === '' && (
          <div className="px-2 py-0.5 flex items-center gap-1.5">
            {creating.type === 'file'
              ? <File className="size-4 shrink-0 text-muted-foreground" />
              : <Folder className="size-4 shrink-0 text-amber-500/80" />}
            <Input
              ref={createInputRef}
              placeholder={creating.type === 'file' ? 'filename' : 'folder name'}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate((e.target as HTMLInputElement).value)
                if (e.key === 'Escape') setCreating(null)
              }}
              onBlur={(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (v) handleCreate(v) }}
              className="h-6 text-xs font-mono py-0 px-1 border-0 focus-visible:ring-0 shadow-none"
            />
          </div>
        )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={preventAutoFocus}>
        <ContextMenuItem onSelect={() => startCreate('', 'file')}>
          <FilePlus className="size-3 mr-2" /> New file
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => startCreate('', 'directory')}>
          <FolderPlus className="size-3 mr-2" /> New folder
        </ContextMenuItem>
        {clipboard && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => handlePaste('')}>
              <ClipboardPaste className="size-3 mr-2" /> Paste
              <ContextMenuShortcut>⌘V</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>

      {/* Multi-delete confirmation */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete?.length} items?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the selected files and folders.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (confirmDelete) { executeDelete(confirmDelete); setConfirmDelete(null) } }}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ContextMenu>
  )
})
