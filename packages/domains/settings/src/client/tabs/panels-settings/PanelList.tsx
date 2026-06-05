import { Plus } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import {
  Button,
  IconButton,
  Input,
  Label,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@slayzone/ui'
import { inferProtocolFromUrl } from '@slayzone/task/shared'
import { buildPanelRowDescriptors } from './panels-settings.utils'
import { SortablePanelRow } from './SortablePanelRow'
import type { PanelSettingsState } from './usePanelSettings'

export function PanelList({ state }: { state: PanelSettingsState }) {
  const {
    panelConfig,
    navigateTo,
    togglePanel,
    savePanelConfig,
    sensors,
    newPanelName,
    setNewPanelName,
    newPanelUrl,
    setNewPanelUrl,
    newPanelShortcut,
    setNewPanelShortcut,
    newPanelBlockDesktopHandoff,
    setNewPanelBlockDesktopHandoff,
    newPanelHandoffProtocol,
    setNewPanelHandoffProtocol,
    newPanelProtocolError,
    setNewPanelProtocolError,
    panelShortcutError,
    handleAddCustomPanel
  } = state
  const rowDescriptors = buildPanelRowDescriptors(panelConfig, navigateTo, togglePanel)
  const orderedIds = (panelConfig.order ?? []).filter((id) => rowDescriptors.has(id))
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIdx = orderedIds.indexOf(String(active.id))
    const newIdx = orderedIds.indexOf(String(over.id))
    if (oldIdx < 0 || newIdx < 0) return
    const nextOrdered = arrayMove(orderedIds, oldIdx, newIdx)
    const next = [
      ...nextOrdered,
      ...(panelConfig.order ?? []).filter((id) => !rowDescriptors.has(id))
    ]
    savePanelConfig({ ...panelConfig, order: next })
  }
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-3 px-4">
          <span className="w-3.5" />
          <span className="flex-1" />
          <div className="flex items-center gap-5 shrink-0">
            <span className="text-[10px] font-medium text-muted-foreground w-8 text-center">
              Home
            </span>
            <span className="text-[10px] font-medium text-muted-foreground w-8 text-center">
              Task
            </span>
          </div>
          <span className="w-3.5" />
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {orderedIds.map((id) => {
                const d = rowDescriptors.get(id)!
                return <SortablePanelRow key={id} id={id} descriptor={d} />
              })}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Label className="text-base font-semibold">Add external panel</Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                variant="ghost"
                size="icon-sm"
                aria-label="About external panels"
                className="text-muted-foreground/50"
              >
                <Plus className="size-3" />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-64">
              Web views embedded as panels inside tasks.
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="grid grid-cols-[1fr_1fr_80px] gap-2">
          <Input
            placeholder="Name"
            value={newPanelName}
            onChange={(e) => setNewPanelName(e.target.value)}
          />
          <Input
            placeholder="URL"
            value={newPanelUrl}
            onChange={(e) => setNewPanelUrl(e.target.value)}
          />
          <Input
            placeholder="Key"
            maxLength={1}
            value={newPanelShortcut}
            onChange={(e) => setNewPanelShortcut(e.target.value.slice(-1))}
          />
        </div>
        {panelShortcutError && (
          <p className="text-xs text-destructive">{panelShortcutError}</p>
        )}
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={newPanelBlockDesktopHandoff}
            onChange={(e) => {
              setNewPanelBlockDesktopHandoff(e.target.checked)
              if (e.target.checked && !newPanelHandoffProtocol.trim())
                setNewPanelHandoffProtocol(inferProtocolFromUrl(newPanelUrl) ?? '')
              if (!e.target.checked) setNewPanelProtocolError('')
            }}
          />
          <span className="text-muted-foreground">Block desktop app handoff links</span>
        </label>
        {newPanelBlockDesktopHandoff && (
          <div className="space-y-1">
            <Input
              placeholder="Protocol (e.g. figma)"
              value={newPanelHandoffProtocol}
              onChange={(e) => {
                setNewPanelHandoffProtocol(e.target.value)
                setNewPanelProtocolError('')
              }}
            />
          </div>
        )}
        {newPanelProtocolError && (
          <p className="text-xs text-destructive">{newPanelProtocolError}</p>
        )}
        <Button
          size="sm"
          onClick={handleAddCustomPanel}
          disabled={!newPanelName.trim() || !newPanelUrl.trim()}
        >
          <Plus className="size-3.5 mr-1" /> Add Panel
        </Button>
      </div>
    </div>
  )
}
