import { useState } from 'react'
import { Copy, Eye, EyeOff, GripVertical, Plus, RotateCcw, Trash2 } from 'lucide-react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button, cn, Input } from '@slayzone/ui'
import {
  isLensDirty,
  isLensEdited,
  uniqueLensName,
  useTabStore,
  visibleLenses,
  type Lens
} from '@slayzone/tabs-state'
import { LensEditorSection } from './LensEditorFields'
import { LensIconView, useLensShortcutLabel } from './lens-icons'
import { LensPreview } from './LensPreview'

/**
 * Settings › Lenses: every lens (drag to reorder — the order sets ⌃1–9 — hide, show,
 * rename, duplicate, delete, reset a built-in), the editor for the active lens and a
 * preview of it on mock or real data. Selecting a lens applies it, as in the menu.
 */
export function LensSettingsPage(): React.JSX.Element {
  const lenses = useTabStore((s) => s.lenses)
  const activeLensId = useTabStore((s) => s.activeLensId)
  const active = lenses.find((l) => l.id === activeLensId) ?? lenses[0]
  return (
    <div className="space-y-6" data-testid="lens-settings-page">
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <h2 className="text-lg font-semibold">Lenses</h2>
          <p className="text-sm text-muted-foreground">
            Saved ways of looking at the tree sidebar. The order sets the 1–9 shortcuts.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => useTabStore.getState().createLens()}>
          <Plus className="size-4" />
          New lens
        </Button>
      </div>
      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)] 2xl:grid-cols-[220px_minmax(0,1fr)_300px]">
        <LensList lenses={lenses} activeLensId={activeLensId} />
        {active && <LensEditorPane key={active.id} lens={active} />}
        <LensPreview className="lg:col-span-2 2xl:col-span-1" />
      </div>
    </div>
  )
}

function LensList({
  lenses,
  activeLensId
}: {
  lenses: Lens[]
  activeLensId: string
}): React.JSX.Element {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const shortcutOf = useLensShortcutLabel()
  const shown = visibleLenses(lenses)
  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return
    const to = lenses.findIndex((l) => l.id === over.id)
    if (to >= 0) useTabStore.getState().moveLens(String(active.id), to)
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={lenses.map((l) => l.id)} strategy={verticalListSortingStrategy}>
        <ul className="space-y-1" aria-label="Lenses" data-testid="lens-settings-list">
          {lenses.map((lens) => {
            const index = shown.indexOf(lens)
            return (
              <LensListRow
                key={lens.id}
                lens={lens}
                active={lens.id === activeLensId}
                shortcut={index >= 0 ? shortcutOf(index) : null}
              />
            )
          })}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

function LensListRow({
  lens,
  active,
  shortcut
}: {
  lens: Lens
  active: boolean
  shortcut: string | null
}): React.JSX.Element {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: lens.id
  })
  const meta = [
    lens.builtin ? 'Built-in' : 'Yours',
    isLensEdited(lens) ? 'edited' : null,
    lens.hidden ? 'hidden' : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="lens-settings-row"
      data-lens-id={lens.id}
      className={cn(
        'flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm transition-colors',
        active ? 'border-border bg-accent/50' : 'border-transparent hover:bg-accent/30',
        lens.hidden && 'opacity-60',
        isDragging && 'z-10 shadow-md'
      )}
    >
      <span
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${lens.name}`}
        className="cursor-grab text-muted-foreground"
      >
        <GripVertical className="size-3.5" />
      </span>
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={() => !active && useTabStore.getState().applyLens(lens.id)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <LensIconView icon={lens.icon} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{lens.name}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{meta}</span>
        </span>
      </button>
      {shortcut && <span className="text-xs text-muted-foreground">{shortcut}</span>}
    </li>
  )
}

/** The active lens: name, management actions, unsaved-changes bar and all settings. */
function LensEditorPane({ lens }: { lens: Lens }): React.JSX.Element {
  const dirty = useTabStore((s) => isLensDirty(s.lenses, s.activeLensId, s))
  const lastVisible = useTabStore((s) => visibleLenses(s.lenses).length <= 1)
  const [name, setName] = useState(lens.name)
  const commitName = (): void => {
    if (name.trim()) useTabStore.getState().renameLens(lens.id, name)
    else setName(lens.name)
  }
  const st = useTabStore.getState
  return (
    <div className="min-w-0 space-y-4" data-testid="lens-settings-editor">
      <div className="flex flex-wrap items-center gap-2">
        <LensIconView icon={lens.icon} className="size-4 shrink-0 text-muted-foreground" />
        <Input
          aria-label="Lens name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName()
          }}
          className="h-8 w-56 text-sm font-medium"
        />
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!lens.hidden && lastVisible}
          onClick={() => st().setLensHidden(lens.id, !lens.hidden)}
          title={lens.hidden ? 'Show in the lens menu' : 'Hide from the lens menu'}
        >
          {lens.hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
          {lens.hidden ? 'Show' : 'Hide'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => st().duplicateLens(lens.id)}>
          <Copy className="size-4" />
          Duplicate
        </Button>
        {lens.builtin ? (
          isLensEdited(lens) && (
            <Button size="sm" variant="ghost" onClick={() => st().resetLensToDefault(lens.id)}>
              <RotateCcw className="size-4" />
              Reset to default
            </Button>
          )
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => st().deleteLens(lens.id)}
          >
            <Trash2 className="size-4" />
            Delete
          </Button>
        )}
      </div>
      {dirty && (
        <div
          className="flex items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-xs"
          data-testid="lens-unsaved-bar"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
          <span>Unsaved changes</span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => st().revertActiveLens()}>
            Revert
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => st().saveLensAs(uniqueLensName(st().lenses, `${lens.name} copy`))}
          >
            Save as new…
          </Button>
          <Button size="sm" onClick={() => st().saveActiveLens()}>
            Save
          </Button>
        </div>
      )}
      {(
        [
          ['structure', 'Structure'],
          ['show', 'What to show'],
          ['rows', 'How rows look']
        ] as const
      ).map(([section, title]) => (
        <section key={section} className="space-y-3 rounded-lg border border-border p-4">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </h3>
          <LensEditorSection section={section} />
        </section>
      ))}
    </div>
  )
}
