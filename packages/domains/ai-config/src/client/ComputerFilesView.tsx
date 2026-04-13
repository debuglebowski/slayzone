import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { File, FilePlus, Info, Trash2 } from 'lucide-react'
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, FileTree, Input, Switch, Textarea, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, cn, fileTreeIndent } from '@slayzone/ui'
import type { ComputerFileEntry } from '../shared'
import { COMPUTER_PROVIDER_PATHS } from '../shared/provider-registry'
import { useContextManagerStore } from './useContextManagerStore'

export function ComputerFilesView() {
  const [entries, setEntries] = useState<ComputerFileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const selectedPath = useContextManagerStore((s) => s.computerSelectedPath)
  const setSelectedPath = useContextManagerStore((s) => s.setComputerSelectedPath)
  const [content, setContent] = useState('')
  const showBlobs = useContextManagerStore((s) => s.showBlobs)
  const setShowBlobs = useContextManagerStore((s) => s.setShowBlobs)
  const showLineCount = useContextManagerStore((s) => s.showLineCount)
  const setShowLineCount = useContextManagerStore((s) => s.setShowLineCount)
  const [creatingFile, setCreatingFile] = useState<{ provider: string; category: 'skill' } | null>(null)
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
      await loadFiles()
    } catch {
      // silent
    }
  }, [loadFiles])

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

  // Group entries by registry key
  const providerGroups = useMemo(() => {
    const groups: { key: string; dirLabel: string; hint?: string; hasSkillsDir: boolean; files: ComputerFileEntry[] }[] = []
    for (const [key, spec] of Object.entries(COMPUTER_PROVIDER_PATHS)) {
      const files = entries.filter((e) => e.provider === key)
      groups.push({
        key,
        dirLabel: `~/${spec.baseDir}/`,
        hint: spec.hint,
        hasSkillsDir: !!spec.skillsDir,
        files,
      })
    }
    return groups
  }, [entries])

  const HASH_COLORS = ['#f97316','#8b5cf6','#06b6d4','#ec4899','#84cc16','#eab308','#14b8a6']

  const { hashColorMap, hashMembers } = useMemo(() => {
    const groups = new Map<string, ComputerFileEntry[]>()
    for (const e of entries) {
      if (!e.contentHash) continue
      const list = groups.get(e.contentHash) ?? []
      list.push(e)
      groups.set(e.contentHash, list)
    }
    const colorMap = new Map<string, string>()
    const members = new Map<string, ComputerFileEntry[]>()
    let colorIdx = 0
    for (const [hash, list] of groups) {
      colorMap.set(hash, HASH_COLORS[colorIdx % HASH_COLORS.length])
      members.set(hash, list)
      colorIdx++
    }
    return { hashColorMap: colorMap, hashMembers: members }
  }, [entries])

  const getRelativePath = useCallback((baseDir: string) => {
    const prefix = `~/${baseDir}/`
    return (entry: ComputerFileEntry) => {
      const name = entry.name
      return name.startsWith(prefix) ? name.slice(prefix.length) : name
    }
  }, [])

  const renderFile = useCallback((entry: ComputerFileEntry, { name, depth }: { name: string; depth: number }) => {
    const selected = selectedPath === entry.path
    return (
      <div
        className={cn(
          'group flex h-8 w-full items-center gap-1.5 rounded px-1 text-xs',
          selected ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/50',
          !entry.exists && 'text-muted-foreground'
        )}
        style={{ paddingLeft: fileTreeIndent(depth) }}
      >
        <button className="flex min-w-0 flex-1 items-center gap-1.5" onClick={() => openFile(entry)}>
          {entry.exists ? <File className="size-3.5 shrink-0" /> : <FilePlus className="size-3.5 shrink-0" />}
          <span className="min-w-0 truncate font-mono">{name}</span>
        </button>
        {showLineCount && entry.lineCount != null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{entry.lineCount}L</span>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {entry.lineCount} {entry.lineCount === 1 ? 'line' : 'lines'}
            </TooltipContent>
          </Tooltip>
        )}
        {showBlobs && entry.contentHash && hashColorMap.has(entry.contentHash) && (() => {
          const members = hashMembers.get(entry.contentHash)!
          const isUnique = members.length === 1
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: hashColorMap.get(entry.contentHash) }} />
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">
                {isUnique ? (
                  <p>Unique content</p>
                ) : (
                  <>
                    <p className="font-medium mb-0.5">Identical content</p>
                    {members.map((m) => (
                      <p key={m.path} className={cn('font-mono', m.path === entry.path && 'font-bold')}>{m.name}</p>
                    ))}
                  </>
                )}
              </TooltipContent>
            </Tooltip>
          )
        })()}
        {entry.category === 'skill' && (
          <button
            className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"
            onClick={(e) => { e.stopPropagation(); void deleteFile(entry) }}
            title="Delete"
          >
            <Trash2 className="size-3" />
          </button>
        )}
      </div>
    )
  }, [selectedPath, hashColorMap, hashMembers, showBlobs, showLineCount])

  // Resizable split
  const splitWidth = useContextManagerStore((s) => s.computerSplitWidth)
  const setSplitWidth = useContextManagerStore((s) => s.setComputerSplitWidth)
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

  const headerTarget = document.getElementById('context-manager-header-actions')
  const isJson = selectedPath?.endsWith('.json')
  const jsonError = isJson && content.trim()
    ? (() => { try { JSON.parse(content); return null } catch (e) { return (e as Error).message } })()
    : null

  return (
    <TooltipProvider>
      {headerTarget && createPortal(
        <div className="flex items-center gap-4">
          {isJson && jsonError && (
            <span className="rounded-full bg-destructive px-2.5 py-0.5 text-[11px] font-medium text-destructive-foreground">
              Invalid JSON
            </span>
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch checked={showLineCount} onCheckedChange={setShowLineCount} className="scale-75" />
            Line counts
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch checked={showBlobs} onCheckedChange={setShowBlobs} className="scale-75" />
            Content match
          </label>
        </div>,
        headerTarget
      )}
      <div ref={containerRef} className="flex h-full w-full overflow-hidden rounded-lg border bg-surface-3">
        {/* Left: per-provider file trees */}
        <div className="flex flex-col overflow-y-auto p-3" style={{ width: splitWidth }}>
          <div className="flex-1 space-y-4">
            {providerGroups.map(({ key, dirLabel, hint, hasSkillsDir, files }) => (
              <div key={key}>
                {/* Provider folder header */}
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <span className="min-w-0 truncate font-mono text-xs font-medium text-muted-foreground">{dirLabel}</span>
                  {hint && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="size-3 shrink-0 text-muted-foreground/50" />
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-52 text-xs">
                        {hint}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  <div className="ml-auto flex shrink-0 gap-0.5">
                    {hasSkillsDir && (
                      <button
                        data-testid={`computer-files-add-skill-${key}`}
                        className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50"
                        onClick={() => { setCreatingFile({ provider: key, category: 'skill' }); setNewFileName('') }}
                      >
                        + skill
                      </button>
                    )}
                  </div>
                </div>

                {/* File tree for this provider */}
                {files.length > 0 ? (
                  <div className="pl-5">
                    <FileTree
                      items={files}
                      getPath={getRelativePath(COMPUTER_PROVIDER_PATHS[key].baseDir)}
                      renderFile={renderFile}
                      compress
                      defaultExpanded
                    />
                  </div>
                ) : (
                  <p className="pl-5 px-1 py-0.5 text-[10px] text-muted-foreground">No files yet</p>
                )}
              </div>
            ))}

            {providerGroups.every((g) => g.files.length === 0) && !loading && (
              <p className="text-sm text-muted-foreground">No computer config files found.</p>
            )}
          </div>
        </div>

        {/* Drag handle */}
        <div className="relative flex w-3 shrink-0 cursor-col-resize items-center justify-center" onMouseDown={onDragStart} onDoubleClick={() => setSplitWidth(350)}>
          <div className="h-full w-px bg-border" />
        </div>

        {/* Right: editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedPath ? (
              <Textarea
                className="min-h-0 max-h-none flex-1 resize-none rounded-none border-0 shadow-none focus-visible:ring-0 bg-transparent dark:bg-transparent [padding-top:1rem] [padding-bottom:1rem] [field-sizing:fixed] font-mono text-sm"
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

        {/* New skill dialog */}
        <Dialog open={!!creatingFile} onOpenChange={(open) => { if (!open) setCreatingFile(null) }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>New skill</DialogTitle>
            </DialogHeader>
            <Input
              data-testid="computer-files-new-name"
              className="font-mono text-sm"
              placeholder="my-skill"
              value={newFileName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setNewFileName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFile()}
              autoFocus
            />
            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={() => setCreatingFile(null)}>Cancel</Button>
              <Button data-testid="computer-files-create" size="sm" onClick={handleCreateFile}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}
