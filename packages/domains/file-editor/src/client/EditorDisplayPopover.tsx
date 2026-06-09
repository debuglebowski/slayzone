import { useCallback, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { Code, Columns2, Eye, SlidersHorizontal } from 'lucide-react'
import { Button, Label, Switch, cn } from '@slayzone/ui'
import { MarkdownSettingsPopover } from '@slayzone/editor'
import type { MarkdownViewMode } from '@slayzone/file-editor/shared'

interface EditorDisplayPopoverProps {
  viewMode: MarkdownViewMode
  onViewModeChange: (mode: MarkdownViewMode) => void
  editorTocEnabled: boolean
  editorMinimapEnabled: boolean
  notesReadability: 'compact' | 'normal'
  notesWidth: 'narrow' | 'wide'
  notesFontFamily: 'sans' | 'mono'
}

export function EditorDisplayPopover({
  viewMode,
  onViewModeChange,
  editorTocEnabled,
  editorMinimapEnabled,
  notesReadability,
  notesWidth,
  notesFontFamily
}: EditorDisplayPopoverProps) {
  const [displayOpen, setDisplayOpen] = useState(false)
  const trpc = useTRPC()
  const setSettingMutation = useMutation(trpc.settings.set.mutationOptions())
  const writeAppearance = useCallback(
    (key: string, value: string) => {
      void setSettingMutation.mutateAsync({ key, value })
      window.dispatchEvent(new Event('sz:settings-changed'))
    },
    []
  )

  return (
    <MarkdownSettingsPopover
      open={displayOpen}
      onOpenChange={setDisplayOpen}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 mr-2 text-xs font-medium text-muted-foreground"
        >
          <SlidersHorizontal className="size-3.5" />
          Display
        </Button>
      }
    >
      <div className="grid grid-cols-3 rounded-md border border-border/50 p-0.5 gap-0.5">
        {[
          { mode: 'rich' as const, icon: Eye, label: 'Rich' },
          { mode: 'split' as const, icon: Columns2, label: 'Split' },
          { mode: 'code' as const, icon: Code, label: 'Code' }
        ].map(({ mode, icon: Icon, label }) => {
          const active = viewMode === mode
          return (
            <button
              key={mode}
              className={cn(
                'flex flex-col items-center justify-center gap-1 py-3 text-[10px] font-medium rounded transition-colors',
                active
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
              onClick={() => onViewModeChange(mode)}
            >
              <Icon className="size-5" />
              {label}
            </button>
          )
        })}
      </div>

      <div className="space-y-3">
        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 block">
          Editor
        </span>
        <div className="flex items-center justify-between">
          <Label htmlFor="md-toc" className="text-sm cursor-pointer">
            Outline
          </Label>
          <Switch
            id="md-toc"
            checked={editorTocEnabled}
            onCheckedChange={(v) => writeAppearance('editor_toc_enabled', v ? '1' : '0')}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label
            htmlFor="md-minimap"
            className={cn(
              'text-sm cursor-pointer',
              viewMode === 'rich' && 'text-muted-foreground/50'
            )}
          >
            Minimap{viewMode === 'rich' ? ' (not in rich mode)' : ''}
          </Label>
          <Switch
            id="md-minimap"
            checked={editorMinimapEnabled && viewMode !== 'rich'}
            disabled={viewMode === 'rich'}
            onCheckedChange={(v) => writeAppearance('editor_minimap_enabled', v ? '1' : '0')}
          />
        </div>
      </div>

      <div className="space-y-3">
        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 block">
          Layout
        </span>
        <div className="flex items-center justify-between">
          <Label htmlFor="md-compact" className="text-sm cursor-pointer">
            Compact
          </Label>
          <Switch
            id="md-compact"
            checked={notesReadability === 'compact'}
            onCheckedChange={(v) => writeAppearance('notes_readability', v ? 'compact' : 'normal')}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="md-wide" className="text-sm cursor-pointer">
            Wide
          </Label>
          <Switch
            id="md-wide"
            checked={notesWidth === 'wide'}
            onCheckedChange={(v) => writeAppearance('notes_width', v ? 'wide' : 'narrow')}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="md-mono" className="text-sm cursor-pointer">
            Use mono font
          </Label>
          <Switch
            id="md-mono"
            checked={notesFontFamily === 'mono'}
            onCheckedChange={(v) => writeAppearance('notes_font_family', v ? 'mono' : 'sans')}
          />
        </div>
      </div>
    </MarkdownSettingsPopover>
  )
}
