import { useCallback, useEffect, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { File, FilePlus, Link, Unlink, RefreshCw, Save, Check, AlertCircle, Circle, Pencil, Trash2, RefreshCcw } from 'lucide-react'
import { Button, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Label, Textarea, FileTree, fileTreeIndent, cn } from '@slayzone/ui'
import type { CliProvider, ContextTreeEntry } from '../shared'
import { GlobalItemPicker } from './GlobalItemPicker'
import { contextEntryToSyncHealth } from './sync-view-model'

function SyncBadge({ entry }: { entry: ContextTreeEntry }) {
  const health = entry.syncHealth
  if (health === 'synced') {
    return (
      <span className="flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400" title="Synced with source" aria-label="Synced with source">
        <Check className="size-3" />
      </span>
    )
  }
  if (health === 'stale') {
    return (
      <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400" title="Out of sync with source" aria-label="Out of sync with source">
        <AlertCircle className="size-3" />
      </span>
    )
  }
  if (health !== 'unmanaged') return null
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground" title="Unmanaged (exists on disk but not linked in config)" aria-label="Unmanaged file">
      <Circle className="size-3" />
    </span>
  )
}

function ProviderBadge({ provider }: { provider?: CliProvider }) {
  if (!provider) return null
  return (
    <span
      className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase text-muted-foreground"
      title={`Provider: ${provider}`}
      aria-label={`Provider: ${provider}`}
    >
      {provider}
    </span>
  )
}

const getRelativePath = (entry: ContextTreeEntry) => entry.relativePath

interface ProjectContextTreeProps {
  projectPath: string
  projectId: string
  projectName?: string
}

export function ProjectContextTree({ projectPath, projectId }: ProjectContextTreeProps) {
  const [entries, setEntries] = useState<ContextTreeEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [showPicker, setShowPicker] = useState(false)
  const [creatingFile, setCreatingFile] = useState(false)
  const [newFilePath, setNewFilePath] = useState('')
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [renamingEntry, setRenamingEntry] = useState<ContextTreeEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [syncing, setSyncing] = useState(false)

  const loadTree = useCallback(async () => {
    setLoading(true)
    try {
      const tree = await window.api.aiConfig.getContextTree(projectPath, projectId)
      setEntries(tree)
      // Auto-expand all folders on first load
      const folders = new Set<string>()
      for (const e of tree) {
        const parts = e.relativePath.split('/')
        let path = ''
        for (let i = 0; i < parts.length - 1; i++) {
          path = path ? `${path}/${parts[i]}` : parts[i]
          folders.add(path)
        }
      }
      setExpandedFolders((prev) => prev.size === 0 ? folders : prev)
    } finally {
      setLoading(false)
    }
  }, [projectPath, projectId])

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
      await window.api.aiConfig.writeContextFile(entry.path, '', projectPath)
      await loadTree()
    }
    try {
      const text = await window.api.aiConfig.readContextFile(entry.path, projectPath)
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
      await window.api.aiConfig.writeContextFile(selectedPath, content, projectPath)
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
      const updated = await window.api.aiConfig.syncLinkedFile(projectId, projectPath, entry.linkedItemId)
      setEntries((prev) => prev.map((e) => (e.path === updated.path ? updated : e)))
      if (selectedPath === entry.path) {
        const text = await window.api.aiConfig.readContextFile(entry.path, projectPath)
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
    await window.api.aiConfig.unlinkFile(projectId, entry.linkedItemId)
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
      await window.api.aiConfig.renameContextFile(renamingEntry.path, newPath, projectPath)
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
    await window.api.aiConfig.deleteContextFile(entry.path, projectPath, projectId)
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
      await window.api.aiConfig.writeContextFile(filePath, '', projectPath)
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
      const result = await window.api.aiConfig.syncAll({ projectId, projectPath })
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

  const renderContextFile = useCallback((entry: ContextTreeEntry, { name, depth }: { name: string; depth: number }) => {
    const selected = selectedPath === entry.path
    const isStaleLinked = !!entry.linkedItemId && contextEntryToSyncHealth(entry) === 'stale'
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'group flex w-full select-none items-center gap-1.5 rounded px-1 py-1 text-xs',
              selected ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/50',
              !entry.exists && 'text-muted-foreground'
            )}
            style={{ paddingLeft: fileTreeIndent(depth) }}
          >
            <button className="flex min-w-0 flex-1 items-center gap-1.5" onClick={() => openFile(entry)}>
              {entry.exists
                ? (
                  <span title="File exists on disk" aria-label="File exists on disk">
                    <File className="size-3.5 shrink-0" />
                  </span>
                  )
                : (
                  <span title="File is not created on disk" aria-label="File is not created on disk">
                    <FilePlus className="size-3.5 shrink-0" />
                  </span>
                  )
              }
              <span className="min-w-0 truncate font-mono">{name}</span>
            </button>
            <div className="flex shrink-0 items-center gap-1">
              <ProviderBadge provider={entry.provider} />
              {entry.linkedItemId && (
                <>
                  <span title="Linked to global item" aria-label="Linked to global item">
                    <Link className="size-3 text-muted-foreground" />
                  </span>
                </>
              )}
              <SyncBadge entry={entry} />
              {isStaleLinked && (
                <button
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  onClick={(e) => { e.stopPropagation(); handleSync(entry) }}
                  title="Sync from global"
                >
                  <RefreshCw className="size-3" />
                </button>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => handleStartRename(entry)}>
            <Pencil className="size-4" /> Rename
          </ContextMenuItem>
          {isStaleLinked && (
            <ContextMenuItem onSelect={() => handleSync(entry)}>
              <RefreshCw className="size-4" /> Sync from global
            </ContextMenuItem>
          )}
          {entry.linkedItemId && (
            <ContextMenuItem onSelect={() => handleUnlink(entry)}>
              <Unlink className="size-4" /> Unlink from global
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => handleDelete(entry)}>
            <Trash2 className="size-4" /> Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }, [selectedPath])

  // Resizable split (pixel-based)
  const [splitWidth, setSplitWidth] = useState(350)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const onDragStart = (e: ReactMouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const onMove = (ev: globalThis.MouseEvent) => {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const px = ev.clientX - rect.left
      const min = rect.width * 0.15
      const max = rect.width * 0.8
      setSplitWidth(Math.min(Math.max(px, min), max))
    }
    const onUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  if (loading && entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading...</p>
  }

  return (
    <div ref={containerRef} className="flex h-full overflow-hidden rounded-lg border">
      {/* Left: file tree */}
      <div className="flex flex-col overflow-y-auto p-3" style={{ width: splitWidth }}>
        <div className="flex-1 space-y-8">
          {projectFiles.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Project</p>
              <FileTree
                items={projectFiles}
                getPath={getRelativePath}
                expandedFolders={expandedFolders}
                onToggleFolder={toggleFolder}
                renderFile={renderContextFile}
              />
            </div>
          )}

          {computerFiles.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Computer</p>
              <FileTree
                items={computerFiles}
                getPath={getRelativePath}
                expandedFolders={expandedFolders}
                onToggleFolder={toggleFolder}
                renderFile={renderContextFile}
              />
            </div>
          )}
        </div>

        {creatingFile && (
          <div className="space-y-1.5 rounded-md border bg-muted/20 p-2">
            <Input
              className="font-mono text-xs"
              placeholder=".claude/commands/my-cmd.md"
              value={newFilePath}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setNewFilePath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFile()}
            />
            <div className="flex gap-1">
              <Button size="sm" className="h-6 flex-1 text-[11px]" onClick={handleCreateFile}>Create</Button>
              <Button size="sm" variant="ghost" className="h-6 flex-1 text-[11px]" onClick={() => { setCreatingFile(false); setNewFilePath('') }}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <div className="pt-3">
          <Button
            size="sm"
            variant="outline"
            className="w-full text-xs"
            onClick={handleSyncAll}
            disabled={syncing}
          >
            <RefreshCcw className={cn('mr-1 size-3', syncing && 'animate-spin')} />
            {syncing ? 'Syncing...' : 'Sync All Providers'}
          </Button>
        </div>
      </div>

      {/* Drag handle */}
      <div
        className="relative flex w-3 shrink-0 cursor-col-resize items-center justify-center"
        onMouseDown={onDragStart}
      >
        <div className="h-full w-px bg-border" />
      </div>

      {/* Right: editor */}
      <div className="flex min-w-0 flex-1 flex-col p-3">
        {selectedPath ? (
          <>
            <div className="flex items-center justify-between gap-2 pb-2">
              <Label className="font-mono text-xs">{selectedEntry?.relativePath ?? selectedPath}</Label>
              <div className="flex items-center gap-2">
                {message && <span className="text-[11px] text-muted-foreground">{message}</span>}
                <Button size="sm" onClick={saveFile} disabled={!dirty || saving}>
                  <Save className="mr-1 size-3" />
                  {saving ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </div>
            <Textarea
              className="min-h-0 max-h-none flex-1 resize-none [field-sizing:fixed] font-mono text-sm"
              value={content}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a file to edit
          </div>
        )}
      </div>

      {showPicker && (
        <GlobalItemPicker
          projectId={projectId}
          projectPath={projectPath}
          existingLinks={entries.filter((e) => e.linkedItemId).map((e) => e.linkedItemId!)}
          onLoaded={handleItemLoaded}
          onClose={() => setShowPicker(false)}
        />
      )}

      <Dialog open={!!renamingEntry} onOpenChange={(open) => !open && setRenamingEntry(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename File</DialogTitle>
          </DialogHeader>
          <Input
            className="font-mono text-xs"
            value={renameValue}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenamingEntry(null)}>Cancel</Button>
            <Button onClick={handleRename}>Rename</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
