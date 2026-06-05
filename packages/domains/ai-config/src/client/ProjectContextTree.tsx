import { useCallback, type ChangeEvent } from 'react'
import { Save, RefreshCcw } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
  FileTree,
  cn
} from '@slayzone/ui'
import type { ContextTreeEntry } from '../shared'
import { LibraryItemPicker } from './LibraryItemPicker'
import { useProjectContextTree } from './useProjectContextTree'
import { useResizableSplit } from './useResizableSplit'
import { ContextFileRow } from './ContextFileRenderer'
import { getRelativePath } from './ProjectContextTree.utils'

interface ProjectContextTreeProps {
  projectPath: string
  projectId: string
  projectName?: string
}

export function ProjectContextTree({ projectPath, projectId }: ProjectContextTreeProps) {
  const {
    entries,
    loading,
    selectedPath,
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
  } = useProjectContextTree({ projectPath, projectId })

  const { containerRef, splitWidth, onDragStart, resetSplit } = useResizableSplit()

  const renderContextFile = useCallback(
    (entry: ContextTreeEntry, { name, depth }: { name: string; depth: number }) => (
      <ContextFileRow
        entry={entry}
        name={name}
        depth={depth}
        selected={selectedPath === entry.path}
        onOpen={openFile}
        onSync={handleSync}
        onStartRename={handleStartRename}
        onUnlink={handleUnlink}
        onDelete={handleDelete}
      />
    ),
    [selectedPath]
  )

  if (loading && entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading...</p>
  }

  return (
    <div ref={containerRef} className="flex h-full overflow-hidden rounded-lg border bg-surface-3">
      {/* Left: file tree */}
      <div className="flex flex-col overflow-y-auto p-3" style={{ width: splitWidth }}>
        <div className="flex-1 space-y-8">
          {projectFiles.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Project
              </p>
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
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Computer
              </p>
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
              <Button size="sm" className="h-6 flex-1 text-[11px]" onClick={handleCreateFile}>
                Create
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 flex-1 text-[11px]"
                onClick={() => {
                  setCreatingFile(false)
                  setNewFilePath('')
                }}
              >
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
        onDoubleClick={resetSplit}
      >
        <div className="h-full w-px bg-border" />
      </div>

      {/* Right: editor */}
      <div className="flex min-w-0 flex-1 flex-col p-3">
        {selectedPath ? (
          <>
            <div className="flex items-center justify-between gap-2 pb-2">
              <Label className="font-mono text-xs">
                {selectedEntry?.relativePath ?? selectedPath}
              </Label>
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
              placeholder="File content..."
              value={content}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
            />
            {selectedPath.endsWith('.json') &&
              (() => {
                if (!content.trim()) return null
                try {
                  JSON.parse(content)
                  return (
                    <p className="text-[11px] text-green-600 dark:text-green-400 pt-1">
                      Valid JSON
                    </p>
                  )
                } catch (e) {
                  return <p className="text-[11px] text-destructive pt-1">{(e as Error).message}</p>
                }
              })()}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a file to edit
          </div>
        )}
      </div>

      {showPicker && (
        <LibraryItemPicker
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
            placeholder="new-filename.md"
            value={renameValue}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenamingEntry(null)}>
              Cancel
            </Button>
            <Button onClick={handleRename}>Rename</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
