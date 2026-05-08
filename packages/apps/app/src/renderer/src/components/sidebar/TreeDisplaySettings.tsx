import { SlidersHorizontal, Check } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@slayzone/ui'
import { useTabStore } from '@slayzone/settings'

export function TreeDisplaySettings() {
  const treeShowStatus = useTabStore((s) => s.treeShowStatus)
  const treeShowPriority = useTabStore((s) => s.treeShowPriority)
  const treeShowSubtasks = useTabStore((s) => s.treeShowSubtasks)
  const setTreeShowStatus = useTabStore((s) => s.setTreeShowStatus)
  const setTreeShowPriority = useTabStore((s) => s.setTreeShowPriority)
  const setTreeShowSubtasks = useTabStore((s) => s.setTreeShowSubtasks)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Display settings"
          title="Display settings"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
        >
          <SlidersHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="min-w-[180px]">
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            setTreeShowStatus(!treeShowStatus)
          }}
          className="cursor-pointer"
        >
          <span className="col-start-2">Show status</span>
          {treeShowStatus && <Check className="size-4 col-start-3" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            setTreeShowPriority(!treeShowPriority)
          }}
          className="cursor-pointer"
        >
          <span className="col-start-2">Show priority</span>
          {treeShowPriority && <Check className="size-4 col-start-3" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            setTreeShowSubtasks(!treeShowSubtasks)
          }}
          className="cursor-pointer"
        >
          <span className="col-start-2">Show sub-tasks</span>
          {treeShowSubtasks && <Check className="size-4 col-start-3" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
