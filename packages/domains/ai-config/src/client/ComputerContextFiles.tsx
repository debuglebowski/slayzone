import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { File, FilePlus, Trash2 } from 'lucide-react'
import { Button, Input, Textarea, cn } from '@slayzone/ui'
import type { CliProvider, ComputerFileEntry } from '../shared'
import { COMPUTER_PROVIDER_PATHS, isConfigurableCliProvider } from '../shared/provider-registry'

interface ComputerContextFilesProps {
  filter?: 'instructions' | 'skill'
}

export function ComputerContextFiles({ filter }: ComputerContextFilesProps = {}) {
  const [entries, setEntries] = useState<ComputerFileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [creatingFile, setCreatingFile] = useState<{ provider: CliProvider; category: 'skill' } | null>(null)
  const [newFileName, setNewFileName] = useState('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadFiles = useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await window.api.aiConfig.getComputerFiles())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadFiles() }, [loadFiles])

  const openFile = async (entry: ComputerFileEntry) => {
    // Create file if it doesn't exist
    if (!entry.exists) {
      await window.api.aiConfig.writeContextFile(entry.path, '', '')
      await loadFiles()
    }
    try {
      const text = await window.api.aiConfig.readContextFile(entry.path, '')
      setContent(text)

      setSelectedPath(entry.path)

    } catch {
      // silent
    }
  }

  const autoSave = useCallback(async (path: string, text: string) => {
    try {
      await window.api.aiConfig.writeContextFile(path, text, '')

    } catch {
      // silent
    }
  }, [])

  const handleContentChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setContent(text)
    if (!selectedPath) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const path = selectedPath
    saveTimer.current = setTimeout(() => void autoSave(path, text), 800)
  }

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
  }, [])

  const deleteFile = async (entry: ComputerFileEntry) => {
    try {
      await window.api.aiConfig.deleteComputerFile(entry.path)
      if (selectedPath === entry.path) {
        setSelectedPath(null)
        setContent('')
      }
      await loadFiles()
    } catch {
      // silent
    }
  }

  const handleCreateFile = async () => {
    if (!creatingFile || !newFileName.trim()) return
    const slug = newFileName.trim().replace(/\.md$/, '')

    try {
      const created = await window.api.aiConfig.createComputerFile(
        creatingFile.provider,
        creatingFile.category,
        slug
      )
      const text = await window.api.aiConfig.readContextFile(created.path, '')
      setSelectedPath(created.path)
      setContent(text)

      await loadFiles()
      setCreatingFile(null)
      setNewFileName('')
    } catch {
      // silent
    }
  }

  const providerSections = Object.entries(COMPUTER_PROVIDER_PATHS)
    .filter(([provider]) => isConfigurableCliProvider(provider))
    .map(([provider, spec]) => ({ provider: provider as CliProvider, spec }))

  // Resizable split
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
      setSplitWidth(Math.min(Math.max(px, rect.width * 0.15), rect.width * 0.8))
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
    <div ref={containerRef} className="flex h-full w-full overflow-hidden rounded-lg border bg-surface-3">
      {/* Left: file list */}
      <div className="flex flex-col overflow-y-auto p-3" style={{ width: splitWidth }}>
        <div className="flex-1 space-y-5">
          {filter === 'instructions' ? (
            // File tree grouped by directory for instructions
            <InstructionsFileList
              entries={entries}
              providerSections={providerSections}
              selectedPath={selectedPath}
              onOpen={openFile}
            />
          ) : (
            // Grouped-by-provider layout for skills
            providerSections.map(({ provider, spec }) => {
              const files = entries
                .filter((entry) => entry.provider === provider)
                .filter((entry) => !filter || entry.category === filter)
                .sort((a, b) => a.name.localeCompare(b.name))
              const instructions = files.filter((f) => f.category === 'instructions')
              const skills = files.filter((f) => f.category === 'skill')

              return (
                <div key={provider} data-testid={`computer-files-provider-${provider}`}>
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{spec.label}</p>
                  <div className="space-y-0.5">
                    {instructions.map((entry) => (
                      <FileRow
                        key={entry.path}
                        entry={entry}
                        selected={selectedPath === entry.path}
                        onClick={() => openFile(entry)}
                      />
                    ))}
                    {skills.length > 0 && (
                      <div className="mt-1">
                        <p className="px-1 py-0.5 text-[10px] text-muted-foreground">Skills</p>
                        {skills.map((entry) => (
                          <FileRow
                            key={entry.path}
                            entry={entry}
                            selected={selectedPath === entry.path}
                            onClick={() => openFile(entry)}
                            onDelete={() => deleteFile(entry)}
                            indent
                          />
                        ))}
                      </div>
                    )}
                    {instructions.length === 0 && skills.length === 0 && (
                      <p className="px-1 py-0.5 text-[10px] text-muted-foreground">No files yet</p>
                    )}
                    {/* Add button for providers with skills dir */}
                    <div className="flex gap-1 pt-1">
                      {spec.skillsDir && (
                        <Button
                          data-testid={`computer-files-add-skill-${provider}`}
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[10px]"
                          onClick={() => { setCreatingFile({ provider: provider as CliProvider, category: 'skill' }); setNewFileName('') }}
                        >
                          <FilePlus className="mr-0.5 size-3" /> Skill
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })
          )}

          {!filter && entries.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">No computer config files found.</p>
          )}
        </div>

        {creatingFile && (
          <div className="mt-3 space-y-1.5 rounded-md border bg-muted/20 p-2">
            <p className="text-[10px] text-muted-foreground">
              New {creatingFile.category} in {COMPUTER_PROVIDER_PATHS[creatingFile.provider]?.label}
            </p>
            <Input
              data-testid="computer-files-new-name"
              className="font-mono text-xs"
              placeholder="my-file"
              value={newFileName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setNewFileName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFile()}
              autoFocus
            />
            <div className="flex gap-1">
              <Button data-testid="computer-files-create" size="sm" className="h-6 flex-1 text-[11px]" onClick={handleCreateFile}>Create</Button>
              <Button size="sm" variant="ghost" className="h-6 flex-1 text-[11px]" onClick={() => setCreatingFile(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </div>

      {/* Drag handle */}
      <div className="relative flex w-3 shrink-0 cursor-col-resize items-center justify-center" onMouseDown={onDragStart} onDoubleClick={() => setSplitWidth(350)}>
        <div className="h-full w-px bg-border" />
      </div>

      {/* Right: editor */}
      <div className="flex min-w-0 flex-1 flex-col p-3">
        {selectedPath ? (
          <Textarea
            className="min-h-0 max-h-none flex-1 resize-none [field-sizing:fixed] font-mono text-sm"
            placeholder="File content..."
            value={content}
            onChange={handleContentChange}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a file to edit
          </div>
        )}
      </div>
    </div>
  )
}

function InstructionsFileList({ entries, providerSections, selectedPath, onOpen }: {
  entries: ComputerFileEntry[]
  providerSections: { provider: CliProvider; spec: (typeof COMPUTER_PROVIDER_PATHS)[string] }[]
  selectedPath: string | null
  onOpen: (entry: ComputerFileEntry) => void
}) {
  const files = useMemo(() => {
    const result: { entry: ComputerFileEntry; relativePath: string }[] = []
    for (const { provider, spec } of providerSections) {
      const entry = entries.find((e) => e.provider === provider && e.category === 'instructions')
      if (!entry) continue
      const relativePath = `~/${spec.baseDir}/${spec.instructions ?? entry.name.split('/').pop()}`
      result.push({ entry, relativePath })
    }
    return result
  }, [entries, providerSections])

  if (files.length === 0) {
    return <p className="text-sm text-muted-foreground">No instruction files found.</p>
  }

  return (
    <div className="space-y-1">
      {files.map(({ entry, relativePath }) => {
        const selected = selectedPath === entry.path
        return (
          <button
            key={entry.path}
            onClick={() => onOpen(entry)}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-xs transition-colors',
              selected
                ? 'bg-primary/10 border-primary/30 text-foreground'
                : 'border-transparent hover:bg-muted/50 text-muted-foreground'
            )}
          >
            {entry.exists ? <File className="size-4 shrink-0" /> : <FilePlus className="size-4 shrink-0" />}
            <span className="min-w-0 truncate font-mono text-sm">{relativePath}</span>
          </button>
        )
      })}
    </div>
  )
}

function FileRow({ entry, selected, onClick, onDelete, indent, providerLabel }: {
  entry: ComputerFileEntry
  selected: boolean
  onClick: () => void
  onDelete?: () => void
  indent?: boolean
  providerLabel?: string
}) {
  const fileName = entry.name.split('/').pop() ?? entry.name
  return (
    <div
      className={cn(
        'group flex flex-col gap-0.5 rounded px-1 py-1.5 text-xs',
        selected ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/50',
        !entry.exists && 'text-muted-foreground',
        indent && 'pl-3'
      )}
    >
      <div className="flex items-center gap-1.5">
        <button className="flex min-w-0 flex-1 items-center gap-1.5" onClick={onClick}>
          {entry.exists ? <File className="size-3.5 shrink-0" /> : <FilePlus className="size-3.5 shrink-0" />}
          <span className="min-w-0 truncate font-mono">{fileName}</span>
        </button>
        {onDelete && (
          <button
            className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            title="Delete"
          >
            <Trash2 className="size-3" />
          </button>
        )}
      </div>
      {providerLabel && (
        <div className="flex gap-1 pl-5">
          <span className="rounded-full bg-muted px-1.5 py-0 text-[10px] text-muted-foreground">
            {providerLabel}
          </span>
        </div>
      )}
    </div>
  )
}
