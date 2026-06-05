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
import {
  INDENT_PX,
  BASE_PAD,
  GIT_STATUS_INFO,
  gitStatusColor,
  compactChildren
} from './EditorFileTree.utils'
import type { VisibleEntry } from './useFileTreeData'
import type { ClipboardState } from './useFileTreeClipboard'
import type { CreatingState } from './useFileTreeCrud'

export function GitStatusBadge({ status }: { status: GitFileStatus | undefined }) {
  if (!status) return null
  const info = GIT_STATUS_INFO[status]
  return (
    <span className={cn('ml-auto text-[10px] font-medium shrink-0', info.colorClass)}>
      {info.letter}
    </span>
  )
}

/** All state/handlers the recursive render functions read — assembled once by the component. */
export interface FileTreeRenderCtx {
  // state / data
  selectedPaths: Set<string>
  focusedPath: string | null
  clipboard: ClipboardState | null
  expandedFolders: Set<string>
  dropTarget: string | null
  renaming: string | null
  renameValue: string
  creating: CreatingState | null
  dirContents: Map<string, DirEntry[]>
  gitStatus: Map<string, GitFileStatus>
  dirGitStatus: Map<string, GitFileStatus>
  activeFilePath: string | null
  osHasFiles: boolean
  visibleEntries: VisibleEntry[]
  // setters / refs
  setRenameValue: (value: string) => void
  setRenaming: (value: string | null) => void
  setCreating: (value: CreatingState | null) => void
  renameInputRef: React.RefObject<HTMLInputElement | null>
  renameValueRef: React.RefObject<string>
  createInputRef: (node: HTMLInputElement | null) => void
  preventAutoFocus: (e: Event) => void
  // handlers
  handleFolderDragOver: (e: React.DragEvent, folderPath: string) => void
  handleFolderDragEnter: (e: React.DragEvent, folderPath: string) => void
  handleFolderDragLeave: (e: React.DragEvent, folderPath: string) => void
  handleFolderDrop: (e: React.DragEvent, targetDir: string) => void
  handleDragStart: (e: React.DragEvent, entry: DirEntry) => void
  handleDragEnd: () => void
  handleEntryClick: (e: React.MouseEvent, entry: DirEntry, chainPaths?: string[]) => void
  handleCreate: (name: string) => void
  handleRename: (oldPath: string, newName: string) => void
  getEffectiveSelection: (entry: DirEntry) => string[]
  startCreate: (parentPath: string, type: 'file' | 'directory') => void
  startRename: (entry: DirEntry) => void
  handleCut: (paths: string[]) => void
  handleCopy: (paths: string[]) => void
  handlePaste: (targetDir: string) => void
  handleDuplicate: (entries: DirEntry[]) => void
  handleCopyPath: (entry: DirEntry, absolute: boolean) => void
  handleRevealInFinder: (entry: DirEntry) => void
  handleDeleteSelected: (entry: DirEntry) => void
}

export function renderRenameInput(ctx: FileTreeRenderCtx, entryPath: string) {
  const { renameInputRef, renameValue, setRenameValue, renameValueRef, setRenaming, handleRename } =
    ctx
  return (
    <Input
      ref={renameInputRef}
      value={renameValue}
      onChange={(e) => {
        setRenameValue(e.target.value)
        renameValueRef.current = e.target.value
      }}
      // Capture phase: shared Input auto-blurs on Escape before bubble onKeyDown, so clearing the ref here prevents onBlur from committing.
      onKeyDownCapture={(e) => {
        if (e.key === 'Escape') {
          renameValueRef.current = ''
          setRenaming(null)
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') handleRename(entryPath, renameValueRef.current)
      }}
      onBlur={() => {
        if (renameValueRef.current.trim()) handleRename(entryPath, renameValueRef.current)
      }}
      className="h-6 text-xs font-mono py-0 px-1"
      data-testid="rename-input"
    />
  )
}

export function renderContextMenuItems(ctx: FileTreeRenderCtx, entry: DirEntry, isFolder: boolean) {
  const {
    getEffectiveSelection,
    visibleEntries,
    clipboard,
    osHasFiles,
    handleCut,
    handleCopy,
    handlePaste,
    handleDuplicate,
    handleCopyPath,
    handleRevealInFinder,
    handleDeleteSelected,
    startCreate,
    startRename
  } = ctx
  const effectivePaths = getEffectiveSelection(entry)
  const effectiveEntries = effectivePaths
    .map((p) => visibleEntries.find((v) => v.entry.path === p)?.entry)
    .filter((e): e is DirEntry => !!e)
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
      {(clipboard || osHasFiles) && (
        <ContextMenuItem onSelect={() => handlePaste(isFolder ? entry.path : parentDir)}>
          <ClipboardPaste className="size-3 mr-2" /> Paste
          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
        </ContextMenuItem>
      )}
      <ContextMenuItem
        onSelect={() => handleDuplicate(effectiveEntries.length > 0 ? effectiveEntries : [entry])}
      >
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
}

export function renderEntry(
  ctx: FileTreeRenderCtx,
  entry: DirEntry,
  depth: number,
  displayName?: string,
  chainPaths?: string[]
) {
  const {
    selectedPaths,
    focusedPath,
    clipboard,
    expandedFolders,
    dropTarget,
    renaming,
    handleFolderDragOver,
    handleFolderDragEnter,
    handleFolderDragLeave,
    handleFolderDrop,
    handleDragStart,
    handleDragEnd,
    handleEntryClick,
    dirGitStatus,
    preventAutoFocus,
    dirContents,
    creating,
    createInputRef,
    handleCreate,
    setCreating,
    gitStatus,
    activeFilePath
  } = ctx
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
            {renderRenameInput(ctx, entry.path)}
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
                {expanded ? (
                  <FolderOpen className="size-4 shrink-0 text-amber-400" />
                ) : (
                  <Folder className="size-4 shrink-0 text-amber-500/80" />
                )}
                <span
                  className={cn(
                    'truncate font-mono',
                    gitStatusColor(dirGitStatus.get(entry.path)),
                    entry.ignored && 'italic'
                  )}
                >
                  {label}
                </span>
                <GitStatusBadge status={dirGitStatus.get(entry.path)} />
                {entry.isSymlink && (
                  <span title="Symbolic link">
                    <ArrowUpRight className="size-3 shrink-0 text-muted-foreground/60" />
                  </span>
                )}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent onCloseAutoFocus={preventAutoFocus}>
              {renderContextMenuItems(ctx, entry, true)}
            </ContextMenuContent>
          </ContextMenu>
        )}

        {expanded &&
          compactChildren(entry.path, dirContents).map((c) =>
            renderEntry(ctx, c.entry, depth + 1, c.displayName, c.chainPaths)
          )}

        {/* Inline create input inside this folder */}
        {creating && creating.parentPath === entry.path && (
          <div
            style={{ paddingLeft: (depth + 1) * INDENT_PX + BASE_PAD }}
            className="flex items-center gap-1.5 py-0.5"
          >
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
    )
  }

  // File entry
  if (renaming === entry.path) {
    return (
      <div key={`f:${entry.path}`} style={{ paddingLeft: pad }}>
        {renderRenameInput(ctx, entry.path)}
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
            <FileIcon
              fileName={entry.name}
              className="size-4 shrink-0 flex items-center [&>svg]:size-full"
            />
            <span
              className={cn(
                'truncate font-mono',
                gitStatusColor(gitStatus.get(entry.path)),
                entry.ignored && 'italic'
              )}
            >
              {entry.name}
            </span>
            <GitStatusBadge status={gitStatus.get(entry.path)} />
            {entry.isSymlink && (
              <span title="Symbolic link">
                <ArrowUpRight className="size-3 shrink-0 text-muted-foreground/60" />
              </span>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={preventAutoFocus}>
          {renderContextMenuItems(ctx, entry, false)}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
