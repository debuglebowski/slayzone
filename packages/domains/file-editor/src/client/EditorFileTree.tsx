import { useCallback, forwardRef, useImperativeHandle } from 'react'
import { File, FilePlus, FolderPlus, Folder, ClipboardPaste } from 'lucide-react'
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
import type { DirEntry } from '../shared'
import { compactChildren } from './EditorFileTree.utils'
import { useFileTreeData } from './useFileTreeData'
import { useFileTreeSelection } from './useFileTreeSelection'
import { useFileTreeClipboard } from './useFileTreeClipboard'
import { useFileTreeCrud } from './useFileTreeCrud'
import { useFileTreeDragDrop } from './useFileTreeDragDrop'
import { useFileTreeKeyboard } from './useFileTreeKeyboard'
import { renderEntry, type FileTreeRenderCtx } from './fileTreeRenders'

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
  /** Called once root directory finishes initial load */
  onReady?: () => void
}

export interface EditorFileTreeHandle {
  scrollToPath: (path: string) => void
}

export const EditorFileTree = forwardRef<EditorFileTreeHandle, EditorFileTreeProps>(
  function EditorFileTree(
    {
      projectPath,
      onOpenFile,
      onFileRenamed,
      activeFilePath,
      refreshKey,
      expandedFolders: controlledExpanded,
      onExpandedFoldersChange,
      onReady
    },
    ref
  ) {
    const {
      dirContents,
      expandedFolders,
      setExpandedFolders,
      loadDir,
      gitStatus,
      dirGitStatus,
      visibleEntries
    } = useFileTreeData({
      projectPath,
      refreshKey,
      controlledExpanded,
      onExpandedFoldersChange,
      onReady
    })

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

    const {
      selectedPaths,
      setSelectedPaths,
      focusedPath,
      setFocusedPath,
      treeContainerRef,
      handleEntryClick,
      getEffectiveSelection
    } = useFileTreeSelection({ visibleEntries, onOpenFile, handleToggleFolder })

    const {
      clipboard,
      setClipboard,
      osHasFiles,
      refreshOsClipboard,
      handleCopy,
      handleCut,
      handlePaste,
      handleDuplicate,
      handleCopyPath,
      handleRevealInFinder
    } = useFileTreeClipboard({ projectPath, loadDir, dirContents, onFileRenamed })

    const {
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
    } = useFileTreeCrud({
      projectPath,
      loadDir,
      dirContents,
      setExpandedFolders,
      onOpenFile,
      onFileRenamed,
      selectedPaths,
      setSelectedPaths
    })

    const {
      dropTarget,
      setDropTarget,
      dragPathRef,
      dropCounterRef,
      isValidDropTarget,
      handleDragStart,
      handleDragEnd,
      handleFolderDragOver,
      handleFolderDragEnter,
      handleFolderDragLeave,
      handleFolderDrop
    } = useFileTreeDragDrop({ projectPath, loadDir, setExpandedFolders, onFileRenamed, selectedPaths })

    const { handleKeyDown } = useFileTreeKeyboard({
      focusedPath,
      setFocusedPath,
      selectedPaths,
      setSelectedPaths,
      visibleEntries,
      expandedFolders,
      setExpandedFolders,
      clipboard,
      setClipboard,
      handleToggleFolder,
      onOpenFile,
      handleCopy,
      handleCut,
      handlePaste,
      executeDelete,
      setConfirmDelete,
      treeContainerRef
    })

    // --- Imperative handle for scroll-to-path ---
    useImperativeHandle(
      ref,
      () => ({
        scrollToPath: (filePath: string) => {
          const el = treeContainerRef.current?.querySelector(
            `[data-path="${CSS.escape(filePath)}"]`
          )
          el?.scrollIntoView({ block: 'nearest' })
        }
      }),
      []
    )

    const ctx: FileTreeRenderCtx = {
      selectedPaths,
      focusedPath,
      clipboard,
      expandedFolders,
      dropTarget,
      renaming,
      renameValue,
      creating,
      dirContents,
      gitStatus,
      dirGitStatus,
      activeFilePath,
      osHasFiles,
      visibleEntries,
      setRenameValue,
      setRenaming,
      setCreating,
      renameInputRef,
      renameValueRef,
      createInputRef,
      preventAutoFocus,
      handleFolderDragOver,
      handleFolderDragEnter,
      handleFolderDragLeave,
      handleFolderDrop,
      handleDragStart,
      handleDragEnd,
      handleEntryClick,
      handleCreate,
      handleRename,
      getEffectiveSelection,
      startCreate,
      startRename,
      handleCut,
      handleCopy,
      handlePaste,
      handleDuplicate,
      handleCopyPath,
      handleRevealInFinder,
      handleDeleteSelected
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
            onFocus={refreshOsClipboard}
            onMouseEnter={refreshOsClipboard}
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
            {rootCompacted.map((c) => renderEntry(ctx, c.entry, 0, c.displayName, c.chainPaths))}

            {/* Root-level create input */}
            {creating && creating.parentPath === '' && (
              <div className="px-2 py-0.5 flex items-center gap-1.5">
                {creating.type === 'file' ? (
                  <File className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Folder className="size-4 shrink-0 text-amber-500/80" />
                )}
                <Input
                  ref={createInputRef}
                  placeholder={creating.type === 'file' ? 'filename' : 'folder name'}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate((e.target as HTMLInputElement).value)
                    if (e.key === 'Escape') setCreating(null)
                  }}
                  onBlur={(e) => {
                    const v = (e.target as HTMLInputElement).value.trim()
                    if (v) handleCreate(v)
                  }}
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
          {(clipboard || osHasFiles) && (
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
        <AlertDialog
          open={!!confirmDelete}
          onOpenChange={(open) => {
            if (!open) setConfirmDelete(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {confirmDelete?.length} items?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete the selected files and folders.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (confirmDelete) {
                    executeDelete(confirmDelete)
                    setConfirmDelete(null)
                  }
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ContextMenu>
    )
  }
)
