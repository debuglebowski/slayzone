import { useState, type ReactNode } from 'react'
import { Pencil, Settings2 } from 'lucide-react'
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@slayzone/ui'
import { isLensDirty, isLensEdited, useTabStore, visibleLenses } from '@slayzone/tabs-state'
import { LensIconView, useLensShortcutLabel } from './lens-icons'
import { openLensEditor } from './lens-editor-store'

/** The active lens and whether the sidebar has unsaved edits to it. */
export function useActiveLens() {
  const lens = useTabStore((s) => s.lenses.find((l) => l.id === s.activeLensId) ?? s.lenses[0])
  const dirty = useTabStore((s) => isLensDirty(s.lenses, s.activeLensId, s))
  return { lens, dirty }
}

/**
 * The Lens button's menu: one row per visible lens (click applies it, ✎ edits it,
 * ⌃1–9 hints), then "Manage lenses…" when the host can open the settings page.
 */
export function LensMenu({
  trigger,
  onManageLenses
}: {
  trigger: ReactNode
  onManageLenses?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const lenses = useTabStore((s) => s.lenses)
  const activeLensId = useTabStore((s) => s.activeLensId)
  const { dirty } = useActiveLens()
  const shortcutOf = useLensShortcutLabel()
  const shown = visibleLenses(lenses)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="center"
        className="min-w-[240px]"
        data-testid="lens-menu"
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">Lens</DropdownMenuLabel>
        {shown.map((lens, i) => {
          const active = lens.id === activeLensId
          const shortcut = shortcutOf(i)
          return (
            <DropdownMenuItem
              key={lens.id}
              data-testid="lens-menu-item"
              data-lens-id={lens.id}
              data-active={active ? 'true' : undefined}
              className={cn('group/lensrow', active && 'bg-accent/50')}
              onSelect={() => {
                if (!active) useTabStore.getState().applyLens(lens.id)
              }}
            >
              <LensIconView icon={lens.icon} className="size-4" />
              <span className="flex-1 truncate">
                {lens.name}
                {isLensEdited(lens) && <span className="text-muted-foreground"> · edited</span>}
                {active && dirty && (
                  <span aria-label="unsaved changes" className="ml-1 text-primary">
                    •
                  </span>
                )}
              </span>
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Edit ${lens.name}`}
                title={`Edit “${lens.name}”`}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  // Editing another lens switches to it; the active one keeps its edits.
                  if (!active) useTabStore.getState().applyLens(lens.id)
                  setOpen(false)
                  openLensEditor()
                }}
                className="inline-flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/lensrow:opacity-100 group-data-[highlighted]/lensrow:opacity-100"
              >
                <Pencil className="size-3" />
              </span>
              {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
            </DropdownMenuItem>
          )
        })}
        {onManageLenses && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onManageLenses}>
              <Settings2 className="size-4" />
              <span>Manage lenses…</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
