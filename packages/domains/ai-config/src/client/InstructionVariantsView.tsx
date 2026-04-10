import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Plus, Save, Trash2 } from 'lucide-react'
import { Button, Input, Label, Textarea, cn } from '@slayzone/ui'
import type { AiConfigItem } from '../shared'

export function InstructionVariantsView() {
  const [variants, setVariants] = useState<AiConfigItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editName, setEditName] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [originalName, setOriginalName] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  const sortedVariants = useMemo(() => [...variants].sort((a, b) => a.slug.localeCompare(b.slug)), [variants])
  const selected = variants.find((v) => v.id === selectedId) ?? null
  const dirty = selected ? (editContent !== originalContent || editName !== originalName) : false

  const loadVariants = useCallback(async () => {
    setLoading(true)
    try {
      const items = await window.api.aiConfig.listInstructionVariants()
      setVariants(items)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadVariants() }, [loadVariants])

  const selectVariant = (variant: AiConfigItem) => {
    setSelectedId(variant.id)
    setEditContent(variant.content)
    setEditName(variant.slug)
    setOriginalContent(variant.content)
    setOriginalName(variant.slug)
  }

  const handleCreate = useCallback(async () => {
    const slug = `variant-${Date.now()}`
    const created = await window.api.aiConfig.createItem({
      type: 'root_instructions',
      scope: 'global',
      slug,
      content: '',
    })
    setVariants((prev) => [created, ...prev])
    selectVariant(created)
  }, [])

  const handleSave = useCallback(async () => {
    if (!selectedId) return
    setSaving(true)
    try {
      const updated = await window.api.aiConfig.updateItem({
        id: selectedId,
        slug: editName || undefined,
        content: editContent,
      })
      if (updated) {
        setVariants((prev) => prev.map((v) => (v.id === updated.id ? updated : v)))
        setOriginalContent(updated.content)
        setOriginalName(updated.slug)
      }
    } finally {
      setSaving(false)
    }
  }, [selectedId, editContent, editName])

  const handleDelete = useCallback(async (id: string) => {
    await window.api.aiConfig.deleteItem(id)
    setVariants((prev) => prev.filter((v) => v.id !== id))
    if (selectedId === id) {
      setSelectedId(null)
      setEditContent('')
      setEditName('')
    }
  }, [selectedId])

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

  if (loading) {
    return <p className="text-xs text-muted-foreground">Loading variants...</p>
  }

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden rounded-lg border bg-surface-3">
      {/* Portal: New Variant button in header */}
      {document.getElementById('context-manager-header-actions') &&
        createPortal(
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={handleCreate}>
            <Plus className="size-3 mr-1" /> New Variant
          </Button>,
          document.getElementById('context-manager-header-actions')!,
        )}

      {/* Left: variant list */}
      <div className="flex flex-col overflow-y-auto p-3" style={{ width: splitWidth }}>
        <div className="flex-1 space-y-0.5">
          {sortedVariants.map((variant) => {
            const isActive = selectedId === variant.id
            return (
              <button
                key={variant.id}
                onClick={() => selectVariant(variant)}
                className={cn(
                  'flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left text-xs transition-colors',
                  isActive
                    ? 'bg-primary/10 text-foreground'
                    : 'hover:bg-muted/50 text-muted-foreground'
                )}
              >
                <div className="flex items-center gap-1.5">
                  <FileText className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate font-mono">{variant.slug}</span>
                </div>
                <p className="pl-5 text-[10px] text-muted-foreground/60 line-clamp-1">
                  {variant.content.slice(0, 60) || '(empty)'}
                </p>
              </button>
            )
          })}
          {variants.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No variants yet
            </p>
          )}
        </div>
      </div>

      {/* Drag handle */}
      <div className="relative flex w-3 shrink-0 cursor-col-resize items-center justify-center" onMouseDown={onDragStart} onDoubleClick={() => setSplitWidth(350)}>
        <div className="h-full w-px bg-border" />
      </div>

      {/* Right: editor */}
      <div className="flex min-w-0 flex-1 flex-col p-3">
        {selected ? (
          <>
            {/* Toolbar */}
            <div className="flex items-center justify-between gap-2 pb-3">
              <div className="flex flex-col gap-1 min-w-0 flex-1 max-w-xs">
                <Label className="text-[11px] text-muted-foreground">Name</Label>
                <Input
                  value={editName}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
                  placeholder="Variant name"
                  className="h-7 font-mono text-xs"
                />
              </div>
              <div className="flex items-end gap-2 shrink-0 pb-px">
                <Button size="sm" className="h-7 text-[11px]" onClick={handleSave} disabled={!dirty || saving}>
                  <Save className="size-3 mr-1" />
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px] text-muted-foreground hover:text-destructive"
                  onClick={() => void handleDelete(selected.id)}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            </div>

            {/* Editor */}
            <Label className="text-[11px] text-muted-foreground mb-1">Content</Label>
            <Textarea
              className="min-h-0 max-h-none flex-1 resize-none [field-sizing:fixed] font-mono text-sm"
              value={editContent}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setEditContent(e.target.value)}
              placeholder="Write instruction content..."
            />

          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {variants.length === 0 ? 'Create a variant to get started' : 'Select a variant to edit'}
          </div>
        )}
      </div>
    </div>
  )
}
