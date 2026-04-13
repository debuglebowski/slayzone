import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Check, Circle, File, FilePlus, Link, RefreshCw } from 'lucide-react'
import { Button, FileTree, Textarea, cn, fileTreeIndent } from '@slayzone/ui'
import type { CliProvider, ContextTreeEntry } from '../shared'

interface ProjectContextFilesViewProps {
  projectId: string
  projectPath: string
}

function SyncBadge({ entry }: { entry: ContextTreeEntry }) {
  const health = entry.syncHealth
  if (health === 'synced') {
    return (
      <span className="text-green-600 dark:text-green-400" title="Synced with source" aria-label="Synced with source">
        <Check className="size-3" />
      </span>
    )
  }
  if (health === 'stale') {
    return (
      <span className="text-amber-600 dark:text-amber-400" title="Out of sync with source" aria-label="Out of sync with source">
        <AlertCircle className="size-3" />
      </span>
    )
  }
  if (health !== 'unmanaged') return null
  return (
    <span className="text-muted-foreground" title="Unmanaged (exists on disk but not linked in config)" aria-label="Unmanaged file">
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

export function ProjectContextFilesView({ projectPath, projectId }: ProjectContextFilesViewProps) {
  const [entries, setEntries] = useState<ContextTreeEntry[]>([])
  const [loadingTree, setLoadingTree] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedContent, setSelectedContent] = useState('')
  const [loadingFile, setLoadingFile] = useState(false)
  const [message, setMessage] = useState('')
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())

  const loadTree = useCallback(async () => {
    setLoadingTree(true)
    try {
      const tree = await window.api.aiConfig.getContextTree(projectPath, projectId)
      setEntries(tree)
      const folders = new Set<string>()
      for (const entry of tree) {
        const parts = entry.relativePath.split('/')
        let path = ''
        for (let i = 0; i < parts.length - 1; i++) {
          path = path ? `${path}/${parts[i]}` : parts[i]
          folders.add(path)
        }
      }
      setExpandedFolders((prev) => prev.size === 0 ? folders : prev)
    } catch {
      setMessage('Could not load context files')
    } finally {
      setLoadingTree(false)
    }
  }, [projectId, projectPath])

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

  const openFile = useCallback(async (entry: ContextTreeEntry) => {
    if (!entry.exists) {
      setSelectedPath(entry.path)
      setSelectedContent('')
      setMessage('This file is not created on disk yet')
      return
    }
    setLoadingFile(true)
    setMessage('')
    try {
      const content = await window.api.aiConfig.readContextFile(entry.path, projectPath)
      setSelectedPath(entry.path)
      setSelectedContent(content)
    } catch {
      setMessage('Could not read file')
    } finally {
      setLoadingFile(false)
    }
  }, [projectPath])

  const renderContextFile = useCallback((entry: ContextTreeEntry, { name, depth }: { name: string; depth: number }) => {
    const selected = selectedPath === entry.path
    return (
      <button
        className={cn(
          'group flex w-full select-none items-center gap-1.5 rounded px-1 py-1 text-xs text-left',
          selected ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/50',
          !entry.exists && 'text-muted-foreground'
        )}
        style={{ paddingLeft: fileTreeIndent(depth) }}
        onClick={() => void openFile(entry)}
      >
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
        <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
        <div className="flex shrink-0 items-center gap-1">
          <ProviderBadge provider={entry.provider} />
          {entry.linkedItemId && (
            <span title="Linked to library item" aria-label="Linked to library item">
              <Link className="size-3 text-muted-foreground" />
            </span>
          )}
          <SyncBadge entry={entry} />
        </div>
      </button>
    )
  }, [selectedPath, openFile])

  const selectedEntry = entries.find((entry) => entry.path === selectedPath)
  const projectFiles = entries.filter((entry) => !entry.relativePath.startsWith('~'))
  const computerFiles = entries.filter((entry) => entry.relativePath.startsWith('~'))

  if (loadingTree && entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading files...</p>
  }

  return (
    <div className="grid h-full grid-cols-[minmax(280px,360px)_minmax(0,1fr)] overflow-hidden rounded-lg border bg-surface-3">
      <div className="flex min-h-0 flex-col border-r p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Project context files</p>
          <Button size="sm" variant="outline" onClick={() => void loadTree()} disabled={loadingTree}>
            <RefreshCw className={cn('mr-1 size-3', loadingTree && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        <div className="flex-1 space-y-8 overflow-y-auto">
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

          {!loadingTree && entries.length === 0 && (
            <p className="text-sm text-muted-foreground">No context files found.</p>
          )}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-col p-3">
        {selectedPath ? (
          <>
            <div className="flex items-center justify-between gap-2 pb-2">
              <p className="truncate font-mono text-xs">{selectedEntry?.relativePath ?? selectedPath}</p>
              {message && <span className="text-[11px] text-muted-foreground">{message}</span>}
            </div>
            {loadingFile ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Loading file...
              </div>
            ) : (
              <Textarea
                readOnly
                className="min-h-0 max-h-none flex-1 resize-none [field-sizing:fixed] font-mono text-sm"
                value={selectedContent}
              />
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a file to preview
          </div>
        )}
      </div>
    </div>
  )
}
