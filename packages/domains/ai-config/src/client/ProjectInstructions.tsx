import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { File, FileText, Link2, Unlink } from 'lucide-react'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Switch, Textarea, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, cn } from '@slayzone/ui'
import type { AiConfigItem, CliProvider, SyncHealth, SyncReason } from '../shared'
import { PROVIDER_PATHS, PROVIDER_LABELS } from '../shared/provider-registry'

interface ProjectInstructionsProps {
  projectId?: string | null
  projectPath?: string | null
}

/** De-duped file entry: one entry per unique rootInstructions path */
interface InstructionFile {
  path: string
  providers: CliProvider[]
  health: SyncHealth
  contentHash: string | null
  lineCount: number | null
}

function dedupeProviderFiles(
  providerHealth: Partial<Record<CliProvider, { health: SyncHealth; reason: SyncReason | null; contentHash?: string | null; lineCount?: number | null }>>
): InstructionFile[] {
  const byPath = new Map<string, InstructionFile>()
  for (const [provider, info] of Object.entries(providerHealth)) {
    const p = provider as CliProvider
    const rootPath = PROVIDER_PATHS[p]?.rootInstructions
    if (!rootPath || !info) continue
    const existing = byPath.get(rootPath)
    if (existing) {
      existing.providers.push(p)
      if (info.health === 'stale' || (info.health === 'not_synced' && existing.health === 'synced')) {
        existing.health = info.health
      }
    } else {
      byPath.set(rootPath, { path: rootPath, providers: [p], health: info.health, contentHash: info.contentHash ?? null, lineCount: info.lineCount ?? null })
    }
  }
  return Array.from(byPath.values())
}


export function ProjectInstructions({
  projectId,
  projectPath,
}: ProjectInstructionsProps) {
  const [providerHealth, setProviderHealth] = useState<Partial<Record<CliProvider, { health: SyncHealth; reason: SyncReason | null; contentHash?: string | null; lineCount?: number | null }>>>({})
  const [linkedVariant, setLinkedVariant] = useState<AiConfigItem | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [originalFileContent, setOriginalFileContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [variants, setVariants] = useState<AiConfigItem[]>([])
  const [autoSync, setAutoSync] = useState(true)

  const isProject = !!projectId && !!projectPath
  const files = dedupeProviderFiles(providerHealth).sort((a, b) => a.path.localeCompare(b.path))
  const selectedFile = files.find((f) => f.path === selectedPath)
  const dirty = fileContent !== originalFileContent

  const HASH_COLORS = ['#f97316','#8b5cf6','#06b6d4','#ec4899','#84cc16','#eab308','#14b8a6']

  const { hashColorMap, hashMembers } = useMemo(() => {
    const groups = new Map<string, InstructionFile[]>()
    for (const f of files) {
      if (!f.contentHash) continue
      const list = groups.get(f.contentHash) ?? []
      list.push(f)
      groups.set(f.contentHash, list)
    }
    const colorMap = new Map<string, string>()
    const members = new Map<string, InstructionFile[]>()
    let colorIdx = 0
    for (const [hash, list] of groups) {
      colorMap.set(hash, HASH_COLORS[colorIdx % HASH_COLORS.length])
      members.set(hash, list)
      colorIdx++
    }
    return { hashColorMap: colorMap, hashMembers: members }
  }, [files])

  // Auto-select first file (only in custom mode)
  useEffect(() => {
    if (!linkedVariant && files.length > 0 && !selectedPath) {
      setSelectedPath(files[0].path)
    }
  }, [files, selectedPath, linkedVariant])

  const load = useCallback(async () => {
    if (!isProject) return
    setLoading(true)
    try {
      const [result, variant] = await Promise.all([
        window.api.aiConfig.getRootInstructions(projectId!, projectPath!),
        window.api.aiConfig.getProjectInstructionVariant(projectId!),
      ])
      setProviderHealth(result.providerHealth ?? {})
      setLinkedVariant(variant ?? null)
    } finally {
      setLoading(false)
    }
  }, [isProject, projectId, projectPath])

  useEffect(() => { void load() }, [load])

  // Load file content when selection changes (custom mode only)
  useEffect(() => {
    if (linkedVariant || !selectedFile || !projectPath) {
      if (!linkedVariant) {
        setFileContent('')
        setOriginalFileContent('')
      }
      return
    }
    const provider = selectedFile.providers[0]
    void window.api.aiConfig.readProviderInstructions(projectPath, provider).then((result) => {
      setFileContent(result.content)
      setOriginalFileContent(result.content)
    })
  }, [selectedPath, projectPath, linkedVariant])

  // Debounced auto-save (custom mode only)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestContent = useRef(fileContent)
  latestContent.current = fileContent

  useEffect(() => {
    if (!autoSync || linkedVariant || !dirty || !selectedFile || !projectId || !projectPath) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      const content = latestContent.current
      const result = await window.api.aiConfig.pushProviderInstructions(projectId, projectPath, selectedFile.providers[0], content)
      setOriginalFileContent(content)
      setProviderHealth(result.providerHealth ?? {})
    }, 500)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [fileContent, dirty, selectedFile, projectId, projectPath, linkedVariant, autoSync])

  const openPicker = useCallback(async () => {
    const items = await window.api.aiConfig.listInstructionVariants()
    setVariants(items)
    setPickerOpen(true)
  }, [])

  const handleLink = useCallback(async (variantId: string) => {
    if (!projectId) return
    await window.api.aiConfig.setProjectInstructionVariant(projectId, variantId, projectPath ?? undefined)
    setPickerOpen(false)
    void load()
  }, [projectId, projectPath, load])

  const handleUnlink = useCallback(async () => {
    if (!projectId) return
    await window.api.aiConfig.setProjectInstructionVariant(projectId, null)
    void load()
  }, [projectId, load])

  // Resizable split (custom mode only)
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
      setSplitWidth(Math.min(Math.max(px, rect.width * 0.15), rect.width * 0.5))
    }
    const onUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Portal target for header actions
  const headerTarget = document.getElementById('context-manager-header-actions')

  const headerActions = (
    <div className="flex items-center gap-3">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch checked={autoSync} onCheckedChange={setAutoSync} />
        Auto-sync
      </label>
      {linkedVariant ? (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={openPicker}>
            <FileText className="size-3 mr-1 text-primary" />
            {linkedVariant.slug}
          </Button>
          <button
            onClick={handleUnlink}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Unlink variant"
          >
            <Unlink className="size-3.5" />
          </button>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={openPicker}>
          <Link2 className="size-3 mr-1" />
          Use library variant
        </Button>
      )}
    </div>
  )

  if (loading && files.length === 0) {
    return <p className="text-xs text-muted-foreground">Loading...</p>
  }

  return (
    <TooltipProvider>
      {headerTarget && createPortal(headerActions, headerTarget)}

      {linkedVariant ? (
        /* Mode B: Library variant linked — full-width read-only view */
        <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border bg-surface-3">
          <Textarea
            className="min-h-0 max-h-none flex-1 resize-none rounded-none border-0 shadow-none focus-visible:ring-0 bg-transparent dark:bg-transparent [padding-top:1rem] [padding-bottom:1rem] [field-sizing:fixed] font-mono text-sm opacity-80"
            value={linkedVariant.content}
            readOnly
          />
        </div>
      ) : (
        /* Mode A: Custom — split-pane with file list + editable editor */
        <div ref={containerRef} className="flex h-full w-full overflow-hidden rounded-lg border bg-surface-3">
          {/* Left: file list */}
          <div className="flex flex-col overflow-y-auto p-3" style={{ width: splitWidth }}>
            <div className="flex-1 space-y-1">
              {files.map((file) => {
                const isActive = selectedPath === file.path
                const pillCn = isActive
                  ? 'rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-foreground/70'
                  : 'rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground'
                return (
                  <button
                    key={file.path}
                    onClick={() => setSelectedPath(file.path)}
                    className={cn(
                      'flex w-full flex-col gap-1 rounded-lg border px-3 py-2.5 text-left text-xs transition-colors',
                      isActive
                        ? 'bg-primary/10 border-primary/30 text-foreground'
                        : 'border-transparent hover:bg-muted/50 text-muted-foreground'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <File className="size-4 shrink-0" />
                      <span className="min-w-0 truncate font-mono text-sm">{file.path}</span>
                      <div className="ml-auto flex shrink-0 items-center gap-1.5">
                        {file.lineCount != null && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className={cn(pillCn, 'px-1.5')}>{file.lineCount}L</span>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="text-xs">
                              {file.lineCount} {file.lineCount === 1 ? 'line' : 'lines'}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {file.contentHash && hashColorMap.has(file.contentHash) && (() => {
                          const members = hashMembers.get(file.contentHash)!
                          const isUnique = members.length === 1
                          return (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: hashColorMap.get(file.contentHash) }} />
                              </TooltipTrigger>
                              <TooltipContent side="right" className="text-xs">
                                {isUnique ? (
                                  <p>Unique content</p>
                                ) : (
                                  <>
                                    <p className="font-medium mb-0.5">Identical content</p>
                                    {members.map((m) => (
                                      <p key={m.path} className={cn('font-mono', m.path === file.path && 'font-bold')}>{m.path}</p>
                                    ))}
                                  </>
                                )}
                              </TooltipContent>
                            </Tooltip>
                          )
                        })()}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 pl-6">
                      {file.providers.map((p) => (
                        <span key={p} className={pillCn}>
                          {PROVIDER_LABELS[p]}
                        </span>
                      ))}
                    </div>
                  </button>
                )
              })}
              {files.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">No provider files</p>
              )}
            </div>
          </div>

          {/* Drag handle */}
          <div className="relative flex w-3 shrink-0 cursor-col-resize items-center justify-center" onMouseDown={onDragStart} onDoubleClick={() => setSplitWidth(350)}>
            <div className="h-full w-px bg-border" />
          </div>

          {/* Right: file editor */}
          <div className="flex min-w-0 flex-1 flex-col">
            {selectedFile ? (
              <Textarea
                className="min-h-0 max-h-none flex-1 resize-none rounded-none border-0 shadow-none focus-visible:ring-0 bg-transparent dark:bg-transparent [padding-top:1rem] [padding-bottom:1rem] [field-sizing:fixed] font-mono text-sm"
                placeholder="Write instructions..."
                value={fileContent}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setFileContent(e.target.value)}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                <p>{files.length === 0 ? 'No provider files found' : 'Select a file to edit'}</p>
              </div>
            )}
          </div>
        </div>
      )}

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-5 pt-5 pb-3">
            <DialogTitle className="text-base">Use Library Variant</DialogTitle>
            <p className="text-xs text-muted-foreground">Select a variant to sync across all provider instruction files</p>
          </DialogHeader>
          <div className="border-t max-h-72 overflow-y-auto">
            {[...variants].sort((a, b) => a.slug.localeCompare(b.slug)).map((v) => (
              <button
                key={v.id}
                onClick={() => handleLink(v.id)}
                className="flex w-full items-start gap-3 border-b border-border/40 last:border-0 px-5 py-3 text-left transition-colors hover:bg-muted/40"
              >
                <FileText className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{v.slug}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                    {v.content.slice(0, 120) || '(empty)'}
                  </p>
                </div>
              </button>
            ))}
            {variants.length === 0 && (
              <div className="px-5 py-8 text-center">
                <p className="text-sm text-muted-foreground">No variants available</p>
                <p className="mt-1 text-xs text-muted-foreground/60">Create one in the Library section first</p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
