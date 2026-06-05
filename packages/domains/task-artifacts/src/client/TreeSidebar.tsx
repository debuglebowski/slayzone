import type { Dispatch, RefObject, SetStateAction } from 'react'
import {
  FileText,
  Folder,
  FolderOpen,
  FilePlus,
  FolderPlus,
  ClipboardPaste,
  Pencil,
  Download,
  Trash2,
  Scissors,
  Copy,
  CopyPlus,
  ArrowRight,
  ImageDown,
  FileCode,
  Archive
} from 'lucide-react'
import {
  cn,
  Input,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent
} from '@slayzone/ui'
import type { TaskArtifact, ArtifactFolder } from '@slayzone/task/shared'
import {
  getEffectiveRenderMode,
  getExtensionFromTitle,
  RENDER_MODE_INFO,
  canExportAsPdf,
  canExportAsPng,
  canExportAsHtml
} from '@slayzone/task/shared'
import { INDENT_PX, BASE_PAD } from './ArtifactsPanel.constants'
import { getArtifactIcon, formatRelativeDate } from './ArtifactsPanel.utils'

type CreatingState = { parentFolderId: string | null; type: 'file' | 'folder' } | null
type RenamingState = { id: string; type: 'artifact' | 'folder' } | null

interface TreeSidebarProps {
  artifacts: TaskArtifact[]
  folders: ArtifactFolder[]
  selectedId: string | null
  // Tree structure
  childFolders: Map<string | null, ArtifactFolder[]>
  artifactsByFolder: Map<string | null, TaskArtifact[]>
  expandedFolders: Set<string> | null
  toggleFolder: (folderId: string) => void
  moveToFolders: { id: string; name: string; path: string }[]
  // Multi-select + clipboard
  selectedIds: Set<string>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  clipboard: { ids: string[]; mode: 'copy' | 'cut' } | null
  osHasFiles: boolean
  refreshOsClipboard: () => void
  handleArtifactClick: (e: React.MouseEvent, artifactId: string) => void
  getEffectiveArtifactIds: (artifactId: string) => string[]
  handleArtifactCopy: (ids: string[]) => void
  handleArtifactCut: (ids: string[]) => void
  handleArtifactPaste: (destFolderId: string | null) => Promise<void>
  handleArtifactDuplicate: (ids: string[]) => Promise<void>
  handleDeleteSelected: (ids: string[]) => Promise<void>
  handleCopyPath: (artifactId: string) => Promise<void>
  // Inline create/rename
  creating: CreatingState
  setCreating: Dispatch<SetStateAction<CreatingState>>
  renaming: RenamingState
  renameValue: string
  setRenameValue: Dispatch<SetStateAction<string>>
  setRenaming: Dispatch<SetStateAction<RenamingState>>
  handleInlineCreate: (value: string) => void
  handleInlineRename: (value: string) => void
  startRenameArtifact: (artifact: TaskArtifact) => void
  startRenameFolder: (folder: ArtifactFolder) => void
  createInputRef: (node: HTMLInputElement | null) => void
  renameInputRef: RefObject<HTMLInputElement | null>
  preventAutoFocus: (e: Event) => void
  willCreateRef: RefObject<boolean>
  // Drag-drop
  dropTargetFolder: string | null
  handleFolderDragOver: (folderId: string) => (e: React.DragEvent) => void
  handleFolderDragLeave: () => void
  handleFolderDrop: (folderId: string) => (e: React.DragEvent) => void
  handleRootDragOver: (e: React.DragEvent) => void
  handleRootDrop: (e: React.DragEvent) => void
  handleArtifactDragStart: (artifactId: string) => (e: React.DragEvent) => void
  // Actions
  moveArtifactToFolder: (artifactId: string, folderId: string | null) => Promise<void>
  downloadFile: (id: string) => Promise<boolean>
  downloadFolder: (id: string) => Promise<boolean>
  deleteFolder: (id: string) => Promise<void>
  downloadAllAsZip: () => Promise<boolean>
  downloadAsPdf: (id: string) => Promise<boolean>
  downloadAsPng: (id: string) => Promise<boolean>
  downloadAsHtml: (id: string) => Promise<boolean>
}

/**
 * Sidebar file-tree explorer: recursive folder/artifact rows with their context
 * menus, inline create/rename inputs, drag-drop targets, and the root context menu.
 */
export function TreeSidebar(props: TreeSidebarProps) {
  const {
    artifacts,
    folders,
    selectedId,
    childFolders,
    artifactsByFolder,
    expandedFolders,
    toggleFolder,
    moveToFolders,
    selectedIds,
    setSelectedIds,
    clipboard,
    osHasFiles,
    refreshOsClipboard,
    handleArtifactClick,
    getEffectiveArtifactIds,
    handleArtifactCopy,
    handleArtifactCut,
    handleArtifactPaste,
    handleArtifactDuplicate,
    handleDeleteSelected,
    handleCopyPath,
    creating,
    setCreating,
    renaming,
    renameValue,
    setRenameValue,
    setRenaming,
    handleInlineCreate,
    handleInlineRename,
    startRenameArtifact,
    startRenameFolder,
    createInputRef,
    renameInputRef,
    preventAutoFocus,
    willCreateRef,
    dropTargetFolder,
    handleFolderDragOver,
    handleFolderDragLeave,
    handleFolderDrop,
    handleRootDragOver,
    handleRootDrop,
    handleArtifactDragStart,
    moveArtifactToFolder,
    downloadFile,
    downloadFolder,
    deleteFolder,
    downloadAllAsZip,
    downloadAsPdf,
    downloadAsPng,
    downloadAsHtml
  } = props

  // --- Render inline input ---

  const renderInlineInput = (parentFolderId: string | null, depth: number) => {
    if (!creating || creating.parentFolderId !== parentFolderId) return null
    return (
      <div
        style={{ paddingLeft: depth * INDENT_PX + BASE_PAD }}
        className="flex items-center gap-1.5 py-0.5"
      >
        {creating.type === 'file' ? (
          <FileText className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="size-4 shrink-0 text-amber-500/80" />
        )}
        <Input
          ref={createInputRef}
          data-testid="artifacts-create-input"
          placeholder={creating.type === 'file' ? 'filename.md' : 'folder name'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleInlineCreate((e.target as HTMLInputElement).value)
            if (e.key === 'Escape') setCreating(null)
          }}
          onBlur={(e) => {
            const v = (e.target as HTMLInputElement).value.trim()
            if (v) handleInlineCreate(v)
          }}
          className="h-6 text-xs font-mono py-0 px-1 border-0 focus-visible:ring-0 shadow-none"
        />
      </div>
    )
  }

  // --- Recursive tree renderer ---

  const renderTree = (parentId: string | null, depth: number) => {
    const subFolders = childFolders.get(parentId) ?? []
    const subArtifacts = artifactsByFolder.get(parentId) ?? []

    return (
      <>
        {subFolders.map((folder) => {
          const expanded = expandedFolders?.has(folder.id) ?? true
          const isDropTarget = dropTargetFolder === folder.id
          const isRenaming = renaming?.id === folder.id && renaming.type === 'folder'

          return (
            <div
              key={`d:${folder.id}`}
              data-testid={`folder-row-${folder.id}`}
              className={cn(isDropTarget && 'bg-primary/10 ring-1 ring-primary/30 rounded')}
              onDragOver={handleFolderDragOver(folder.id)}
              onDragLeave={handleFolderDragLeave}
              onDrop={handleFolderDrop(folder.id)}
            >
              <div
                style={{ marginLeft: depth * INDENT_PX + BASE_PAD, marginRight: 4 }}
                className="mb-1"
              >
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      className="group/folder flex w-full select-none items-center gap-1.5 rounded-md border border-border/60 bg-card/50 px-2.5 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 hover:border-border transition-colors"
                      onClick={() => toggleFolder(folder.id)}
                    >
                      {expanded ? (
                        <FolderOpen className="size-4 shrink-0 text-amber-400" />
                      ) : (
                        <Folder className="size-4 shrink-0 text-amber-500/80" />
                      )}
                      {isRenaming ? (
                        <Input
                          ref={renameInputRef}
                          data-testid="artifacts-rename-input"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation()
                            if (e.key === 'Enter') handleInlineRename(renameValue)
                            if (e.key === 'Escape') setRenaming(null)
                          }}
                          onBlur={() => handleInlineRename(renameValue)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-5 text-xs font-mono py-0 px-1 flex-1"
                        />
                      ) : (
                        <span className="truncate font-mono flex-1 text-left">{folder.name}</span>
                      )}
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent onCloseAutoFocus={preventAutoFocus}>
                    <ContextMenuItem
                      onSelect={() => {
                        willCreateRef.current = true
                        setCreating({ parentFolderId: folder.id, type: 'file' })
                      }}
                    >
                      <FilePlus className="size-3 mr-2" /> New Artifact
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => {
                        willCreateRef.current = true
                        setCreating({ parentFolderId: folder.id, type: 'folder' })
                      }}
                    >
                      <FolderPlus className="size-3 mr-2" /> New Folder
                    </ContextMenuItem>
                    {(clipboard || osHasFiles) && (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => void handleArtifactPaste(folder.id)}>
                          <ClipboardPaste className="size-3 mr-2" /> Paste
                          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
                        </ContextMenuItem>
                      </>
                    )}
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => startRenameFolder(folder)}>
                      <Pencil className="size-3 mr-2" /> Rename
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => downloadFolder(folder.id)}>
                      <Download className="size-3 mr-2" /> Download
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem variant="destructive" onSelect={() => deleteFolder(folder.id)}>
                      <Trash2 className="size-3 mr-2" /> Delete
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </div>

              {expanded && (
                <>
                  {renderTree(folder.id, depth + 1)}
                  {renderInlineInput(folder.id, depth + 1)}
                </>
              )}
            </div>
          )
        })}

        {subArtifacts.length > 0 && (
          <div className="flex flex-col gap-1 py-0.5">
            {subArtifacts.map((artifact) => {
              const TypeIcon = getArtifactIcon(artifact)
              const isRenaming = renaming?.id === artifact.id && renaming.type === 'artifact'
              const ext = getExtensionFromTitle(artifact.title).replace('.', '').toUpperCase()
              const effectiveMode = getEffectiveRenderMode(artifact.title, artifact.render_mode)
              const modeLabel = RENDER_MODE_INFO[effectiveMode].label

              return (
                <div
                  key={`f:${artifact.id}`}
                  data-testid={`artifact-row-${artifact.id}`}
                  style={{ marginLeft: depth * INDENT_PX + BASE_PAD, marginRight: 4 }}
                >
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        className={cn(
                          'group/artifact flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left text-xs cursor-pointer transition-colors',
                          artifact.id === selectedId
                            ? 'border-primary/40 bg-primary/[0.08] text-foreground'
                            : selectedIds.has(artifact.id)
                              ? 'border-primary/30 bg-primary/[0.04] text-foreground'
                              : 'border-border/60 bg-card/50 text-muted-foreground hover:text-foreground hover:bg-muted/50 hover:border-border',
                          clipboard?.mode === 'cut' &&
                            clipboard.ids.includes(artifact.id) &&
                            'opacity-50'
                        )}
                        onClick={(e) => handleArtifactClick(e, artifact.id)}
                        draggable={!isRenaming}
                        onDragStart={handleArtifactDragStart(artifact.id)}
                      >
                        <div className="flex w-full items-center gap-1.5 min-w-0">
                          <TypeIcon className="size-4 shrink-0" />
                          {isRenaming ? (
                            <Input
                              ref={renameInputRef}
                              data-testid="artifacts-rename-input"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                e.stopPropagation()
                                if (e.key === 'Enter') handleInlineRename(renameValue)
                                if (e.key === 'Escape') setRenaming(null)
                              }}
                              onBlur={() => handleInlineRename(renameValue)}
                              onClick={(e) => e.stopPropagation()}
                              className="h-5 text-xs font-mono py-0 px-1 flex-1"
                            />
                          ) : (
                            <span className="truncate flex-1 font-medium">{artifact.title}</span>
                          )}
                          {ext && !isRenaming && (
                            <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] font-mono text-muted-foreground">
                              {ext}
                            </span>
                          )}
                        </div>
                        {!isRenaming && (
                          <div className="flex items-center gap-1.5 pl-[22px] text-[10px] text-muted-foreground/70">
                            <span>{modeLabel}</span>
                            <span className="text-muted-foreground/40">&middot;</span>
                            <span>{formatRelativeDate(artifact.updated_at)}</span>
                          </div>
                        )}
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onSelect={() => handleArtifactCut(getEffectiveArtifactIds(artifact.id))}
                      >
                        <Scissors className="size-3 mr-2" /> Cut
                        <ContextMenuShortcut>⌘X</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => handleArtifactCopy(getEffectiveArtifactIds(artifact.id))}
                      >
                        <Copy className="size-3 mr-2" /> Copy
                        <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                      </ContextMenuItem>
                      {(clipboard || osHasFiles) && (
                        <ContextMenuItem onSelect={() => void handleArtifactPaste(artifact.folder_id)}>
                          <ClipboardPaste className="size-3 mr-2" /> Paste
                          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem
                        onSelect={() =>
                          void handleArtifactDuplicate(getEffectiveArtifactIds(artifact.id))
                        }
                      >
                        <CopyPlus className="size-3 mr-2" /> Duplicate
                        <ContextMenuShortcut>⌘D</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={() => startRenameArtifact(artifact)}
                        disabled={selectedIds.size > 1 && selectedIds.has(artifact.id)}
                      >
                        <Pencil className="size-3 mr-2" /> Rename
                      </ContextMenuItem>
                      {moveToFolders.length > 0 && (
                        <ContextMenuSub>
                          <ContextMenuSubTrigger>
                            <ArrowRight className="size-3 mr-2" /> Move to
                          </ContextMenuSubTrigger>
                          <ContextMenuSubContent>
                            {artifact.folder_id && (
                              <ContextMenuItem
                                onSelect={() => moveArtifactToFolder(artifact.id, null)}
                              >
                                Root
                              </ContextMenuItem>
                            )}
                            {moveToFolders
                              .filter((f) => f.id !== artifact.folder_id)
                              .map((f) => (
                                <ContextMenuItem
                                  key={f.id}
                                  onSelect={() => moveArtifactToFolder(artifact.id, f.id)}
                                >
                                  {f.path}
                                </ContextMenuItem>
                              ))}
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                      )}
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => handleCopyPath(artifact.id)}>
                        <Copy className="size-3 mr-2" /> Copy Path
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => downloadFile(artifact.id)}>
                        <Download className="size-3 mr-2" /> Download
                      </ContextMenuItem>
                      {(canExportAsPdf(effectiveMode) ||
                        canExportAsPng(effectiveMode) ||
                        canExportAsHtml(effectiveMode)) && (
                        <ContextMenuSub>
                          <ContextMenuSubTrigger>
                            <Download className="size-3 mr-2" /> Download as
                          </ContextMenuSubTrigger>
                          <ContextMenuSubContent>
                            {canExportAsPdf(effectiveMode) && (
                              <ContextMenuItem onSelect={() => downloadAsPdf(artifact.id)}>
                                <FileText className="size-3 mr-2" /> PDF
                              </ContextMenuItem>
                            )}
                            {canExportAsPng(effectiveMode) && (
                              <ContextMenuItem onSelect={() => downloadAsPng(artifact.id)}>
                                <ImageDown className="size-3 mr-2" /> PNG
                              </ContextMenuItem>
                            )}
                            {canExportAsHtml(effectiveMode) && (
                              <ContextMenuItem onSelect={() => downloadAsHtml(artifact.id)}>
                                <FileCode className="size-3 mr-2" /> HTML
                              </ContextMenuItem>
                            )}
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                      )}
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        variant="destructive"
                        onSelect={() =>
                          void handleDeleteSelected(getEffectiveArtifactIds(artifact.id))
                        }
                      >
                        <Trash2 className="size-3 mr-2" /> Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </div>
              )
            })}
          </div>
        )}
      </>
    )
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid="artifacts-sidebar"
          tabIndex={-1}
          className={cn(
            'flex-1 overflow-y-auto p-1.5 select-none text-sm outline-none',
            dropTargetFolder === '__root__' && 'bg-primary/10'
          )}
          onDragOver={handleRootDragOver}
          onDragLeave={handleFolderDragLeave}
          onDrop={handleRootDrop}
          onMouseEnter={refreshOsClipboard}
          onFocus={refreshOsClipboard}
          onClick={(e) => {
            // Click on empty area clears selection (matches editor pattern)
            if (e.target === e.currentTarget) {
              setSelectedIds(new Set())
            }
          }}
        >
          {artifacts.length > 0 || folders.length > 0 ? (
            <>
              {renderTree(null, 0)}
              {renderInlineInput(null, 0)}
            </>
          ) : creating ? (
            renderInlineInput(null, 0)
          ) : (
            <div className="text-[10px] text-muted-foreground/60 text-center py-4">
              No artifacts yet
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={preventAutoFocus}>
        <ContextMenuItem
          onSelect={() => {
            willCreateRef.current = true
            setCreating({ parentFolderId: null, type: 'file' })
          }}
        >
          <FilePlus className="size-3 mr-2" /> New Artifact
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            willCreateRef.current = true
            setCreating({ parentFolderId: null, type: 'folder' })
          }}
        >
          <FolderPlus className="size-3 mr-2" /> New Folder
        </ContextMenuItem>
        {(clipboard || osHasFiles) && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void handleArtifactPaste(null)}>
              <ClipboardPaste className="size-3 mr-2" /> Paste
              <ContextMenuShortcut>⌘V</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
        {artifacts.length > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => downloadAllAsZip()}>
              <Archive className="size-3 mr-2" /> Download all as ZIP
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
