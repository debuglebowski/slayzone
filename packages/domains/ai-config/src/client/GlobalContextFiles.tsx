import { useCallback, useEffect, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { File, FilePlus, Save, Trash2 } from 'lucide-react'
import { Button, Input, Label, Textarea, cn } from '@slayzone/ui'
import type { CliProvider, GlobalFileEntry } from '../shared'
import { GLOBAL_PROVIDER_PATHS, isConfigurableCliProvider } from '../shared/provider-registry'

export function GlobalContextFiles() {
  const [entries, setEntries] = useState<GlobalFileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [creatingFile, setCreatingFile] = useState<{ provider: CliProvider; category: 'skill' } | null>(null)
  const [newFileName, setNewFileName] = useState('')

  const loadFiles = useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await window.api.aiConfig.getGlobalFiles())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadFiles() }, [loadFiles])

  const openFile = async (entry: GlobalFileEntry) => {
    // Create file if it doesn't exist
    if (!entry.exists) {
      await window.api.aiConfig.writeContextFile(entry.path, '', '')
      await loadFiles()
    }
    try {
      const text = await window.api.aiConfig.readContextFile(entry.path, '')
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
      await window.api.aiConfig.writeContextFile(selectedPath, content, '')
      setOriginalContent(content)
      setMessage('Saved')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const deleteFile = async (entry: GlobalFileEntry) => {
    try {
      await window.api.aiConfig.deleteGlobalFile(entry.path)
      if (selectedPath === entry.path) {
        setSelectedPath(null)
        setContent('')
        setOriginalContent('')
      }
      await loadFiles()
      setMessage('Deleted')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  const handleCreateFile = async () => {
    if (!creatingFile || !newFileName.trim()) return
    const slug = newFileName.trim().replace(/\.md$/, '')

    try {
      const created = await window.api.aiConfig.createGlobalFile(
        creatingFile.provider,
        creatingFile.category,
        slug
      )
      const text = await window.api.aiConfig.readContextFile(created.path, '')
      setSelectedPath(created.path)
      setContent(text)
      setOriginalContent(text)
      await loadFiles()
      setCreatingFile(null)
      setNewFileName('')
      setMessage('Created')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to create')
    }
  }

  const dirty = content !== originalContent

  const providerSections = Object.entries(GLOBAL_PROVIDER_PATHS)
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
    <div ref={containerRef} className="flex h-full w-full overflow-hidden rounded-lg border">
      {/* Left: file list */}
      <div className="flex flex-col overflow-y-auto p-3" style={{ width: splitWidth }}>
        <div className="flex-1 space-y-5">
          {providerSections.map(({ provider, spec }) => {
            const files = entries
              .filter((entry) => entry.provider === provider)
              .sort((a, b) => a.name.localeCompare(b.name))
            const instructions = files.filter((f) => f.category === 'instructions')
            const skills = files.filter((f) => f.category === 'skill')

            return (
              <div key={provider} data-testid={`global-files-provider-${provider}`}>
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
                        data-testid={`global-files-add-skill-${provider}`}
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
          })}

          {entries.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">No global config files found.</p>
          )}
        </div>

        {creatingFile && (
          <div className="mt-3 space-y-1.5 rounded-md border bg-muted/20 p-2">
            <p className="text-[10px] text-muted-foreground">
              New {creatingFile.category} in {GLOBAL_PROVIDER_PATHS[creatingFile.provider]?.label}
            </p>
            <Input
              data-testid="global-files-new-name"
              className="font-mono text-xs"
              placeholder="my-file"
              value={newFileName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setNewFileName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFile()}
              autoFocus
            />
            <div className="flex gap-1">
              <Button data-testid="global-files-create" size="sm" className="h-6 flex-1 text-[11px]" onClick={handleCreateFile}>Create</Button>
              <Button size="sm" variant="ghost" className="h-6 flex-1 text-[11px]" onClick={() => setCreatingFile(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </div>

      {/* Drag handle */}
      <div className="relative flex w-3 shrink-0 cursor-col-resize items-center justify-center" onMouseDown={onDragStart}>
        <div className="h-full w-px bg-border" />
      </div>

      {/* Right: editor */}
      <div className="flex min-w-0 flex-1 flex-col p-3">
        {selectedPath ? (
          <>
            <div className="flex items-center justify-between gap-2 pb-2">
              <Label className="font-mono text-xs truncate">
                {entries.find((e) => e.path === selectedPath)?.name ?? selectedPath}
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
    </div>
  )
}

function FileRow({ entry, selected, onClick, onDelete, indent }: {
  entry: GlobalFileEntry
  selected: boolean
  onClick: () => void
  onDelete?: () => void
  indent?: boolean
}) {
  const fileName = entry.name.split('/').pop() ?? entry.name
  return (
    <div
      className={cn(
        'group flex items-center gap-1.5 rounded px-1 py-1 text-xs',
        selected ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/50',
        !entry.exists && 'text-muted-foreground',
        indent && 'pl-3'
      )}
    >
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
  )
}
