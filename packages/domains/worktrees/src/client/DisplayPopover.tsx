import { SlidersHorizontal, List, Layers } from 'lucide-react'
import {
  IconButton,
  Switch,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Label
} from '@slayzone/ui'
import type { CommitGraphConfig } from '../shared/types'

// --- Display popover (matches kanban pattern) ---

export function DisplayPopover({
  config,
  effectiveBaseBranch,
  onChange,
  onReset
}: {
  config: CommitGraphConfig
  effectiveBaseBranch: string
  onChange: React.Dispatch<React.SetStateAction<CommitGraphConfig>>
  onReset?: () => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          aria-label="Display settings"
          variant="ghost"
          className="h-7 w-7"
          title="Display settings"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="end">
        <div className="space-y-8">
          {/* Base branch */}
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Base branch</Label>
            <span className="text-xs font-mono text-muted-foreground">{effectiveBaseBranch}</span>
          </div>

          {/* View mode toggle */}
          <div className="grid grid-cols-2 rounded-md border border-border/50 p-0.5 gap-0.5">
            {(
              [
                { value: false, icon: List, label: 'All commits' },
                { value: true, icon: Layers, label: 'Collapsed' }
              ] as const
            ).map(({ value, icon: Icon, label }) => {
              const isActive = config.collapsed === value
              return (
                <button
                  key={label}
                  className={`flex flex-col items-center justify-center gap-1 py-3 text-[10px] font-medium rounded transition-colors ${
                    isActive
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                  onClick={() => onChange((c) => ({ ...c, collapsed: value }))}
                >
                  <Icon className="size-5" />
                  {label}
                </button>
              )
            })}
          </div>

          {/* Settings section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Settings</span>
              {onReset && (
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  onClick={onReset}
                >
                  Reset defaults
                </button>
              )}
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="display-branches" className="text-sm cursor-pointer">
                Show branches
              </Label>
              <Switch
                id="display-branches"
                checked={config.showBranches}
                onCheckedChange={(v) => onChange((c) => ({ ...c, showBranches: v }))}
              />
            </div>
            {config.collapsed && (
              <>
                <div className="flex items-center justify-between">
                  <Label htmlFor="break-on-tags" className="text-sm cursor-pointer">
                    Break on tags
                  </Label>
                  <Switch
                    id="break-on-tags"
                    checked={config.breakOnTags}
                    onCheckedChange={(v) => onChange((c) => ({ ...c, breakOnTags: v }))}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="break-on-merges" className="text-sm cursor-pointer">
                    Break on merges
                  </Label>
                  <Switch
                    id="break-on-merges"
                    checked={config.breakOnMerges}
                    onCheckedChange={(v) => onChange((c) => ({ ...c, breakOnMerges: v }))}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
