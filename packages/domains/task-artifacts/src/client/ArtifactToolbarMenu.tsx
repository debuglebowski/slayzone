import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Ellipsis, Pin, type LucideIcon } from 'lucide-react'
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn
} from '@slayzone/ui'
import type { RenderMode } from '@slayzone/task-contracts'
import { useArtifactToolbarPins, type ArtifactToolbarActionId } from './artifact-toolbar-pins'
import { ArtifactToolbarActionButton, ArtifactToolbarSubmenu } from './ArtifactToolbarSubmenu'

export interface ArtifactToolbarAction {
  id: ArtifactToolbarActionId
  label: string
  icon: LucideIcon
  control: ReactNode
  content?: (close: () => void) => ReactNode
  submenuClassName?: string
  run?: () => void
}

export function ArtifactToolbarMenu({
  actions,
  artifactId,
  mode,
  format
}: {
  actions: readonly ArtifactToolbarAction[]
  artifactId: string
  mode: RenderMode
  format: string
}) {
  const { pins, hasOverride, togglePin, saveDefault, reset } = useArtifactToolbarPins(
    artifactId,
    mode
  )
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<ArtifactToolbarActionId | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const pinned = pins.flatMap((id) => actions.find((action) => action.id === id) ?? [])
  const defaultButton = useRef<HTMLButtonElement>(null)
  const saved = savedAt !== null

  useEffect(() => {
    if (savedAt === null) return
    const timer = window.setTimeout(
      () => setSavedAt(null),
      Math.max(0, 1600 - (Date.now() - savedAt))
    )
    return () => window.clearTimeout(timer)
  }, [savedAt])

  function changeOpen(next: boolean) {
    setOpen(next)
    if (!next) {
      setSubmenu(null)
      setSavedAt(null)
    }
  }

  const close = () => changeOpen(false)

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {pinned.length > 0 && (
        <div
          aria-label="Pinned artifact actions"
          role="group"
          className="flex min-w-0 items-center gap-1.5 overflow-x-auto p-0.5 [scrollbar-width:none]"
        >
          {pinned.map(({ id, control }) => (
            <div key={id} className="shrink-0">
              {control}
            </div>
          ))}
        </div>
      )}
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-7"
            aria-label="More artifact actions"
          >
            <Ellipsis className="size-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Artifact actions"
          align="end"
          collisionPadding={8}
          className="flex max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[var(--radix-popover-content-available-width)] flex-col overflow-hidden p-1"
        >
          <div className="min-h-0 overflow-y-auto">
            {actions.map((action) => {
              const { id, label, run, content } = action
              const isPinned = pins.includes(id)
              const pinLabel = `${isPinned ? 'Unpin' : 'Pin'} ${label}`
              const pin = (
                <Tooltip disableHoverableContent>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn('size-7', isPinned ? 'text-primary' : 'text-muted-foreground')}
                      aria-label={pinLabel}
                      aria-pressed={isPinned}
                      onClick={() => {
                        setSubmenu(null)
                        togglePin(id)
                        setSavedAt(null)
                      }}
                    >
                      <Pin
                        className={cn('size-3.5', isPinned && 'fill-current')}
                        aria-hidden="true"
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left" sideOffset={4}>
                    {pinLabel}
                  </TooltipContent>
                </Tooltip>
              )
              if (content) {
                const expanded = submenu === id
                return (
                  <ArtifactToolbarSubmenu
                    key={id}
                    action={action}
                    open={expanded}
                    onOpenChange={(next) =>
                      setSubmenu((current) => (next ? id : current === id ? null : current))
                    }
                    options={expanded ? content(close) : null}
                    className={action.submenuClassName}
                  >
                    {pin}
                  </ArtifactToolbarSubmenu>
                )
              }
              return (
                <div key={id} className="flex items-center gap-0.5">
                  <ArtifactToolbarActionButton
                    action={action}
                    opensOptions={false}
                    onClick={() => {
                      close()
                      run?.()
                    }}
                  />
                  {pin}
                </div>
              )
            })}
          </div>
          <div
            className={cn(
              'mt-1 flex shrink-0 flex-wrap items-center gap-x-2 border-t border-border px-1 pt-1',
              hasOverride ? 'justify-between' : 'justify-center'
            )}
          >
            {hasOverride && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                title="Reset pins to default"
                onClick={() => {
                  defaultButton.current?.focus()
                  reset()
                  setSavedAt(null)
                }}
              >
                Reset
              </Button>
            )}
            <Button
              ref={defaultButton}
              type="button"
              variant="ghost"
              size="sm"
              className="grid h-7 min-w-0 place-items-center px-2 text-xs"
              aria-label={saved ? `Saved as default for ${format}` : undefined}
              onClick={() => {
                saveDefault()
                setSavedAt(Date.now())
              }}
            >
              <span className={cn('col-start-1 row-start-1 truncate', saved && 'invisible')}>
                Set as default for {format}
              </span>
              {saved && (
                <span
                  role="status"
                  className="col-start-1 row-start-1 flex items-center gap-1.5 text-primary"
                >
                  <Check className="size-3.5" /> Saved
                </span>
              )}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
