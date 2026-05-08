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
  const treeIncludeAllSubtasks = useTabStore((s) => s.treeIncludeAllSubtasks)
  const treeCrossOutDone = useTabStore((s) => s.treeCrossOutDone)
  const treeShowHeader = useTabStore((s) => s.treeShowHeader)
  const setTreeShowStatus = useTabStore((s) => s.setTreeShowStatus)
  const setTreeShowPriority = useTabStore((s) => s.setTreeShowPriority)
  const setTreeShowSubtasks = useTabStore((s) => s.setTreeShowSubtasks)
  const setTreeIncludeAllSubtasks = useTabStore((s) => s.setTreeIncludeAllSubtasks)
  const setTreeCrossOutDone = useTabStore((s) => s.setTreeCrossOutDone)
  const setTreeShowHeader = useTabStore((s) => s.setTreeShowHeader)

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
        <DropdownMenuItem
          disabled={!treeShowSubtasks}
          onSelect={(e) => {
            e.preventDefault()
            if (!treeShowSubtasks) return
            setTreeIncludeAllSubtasks(!treeIncludeAllSubtasks)
          }}
          className="cursor-pointer"
        >
          <span className="col-start-2">Show all sub-tasks</span>
          {treeIncludeAllSubtasks && <Check className="size-4 col-start-3" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            setTreeCrossOutDone(!treeCrossOutDone)
          }}
          className="cursor-pointer"
        >
          <span className="col-start-2">Cross over completed tasks</span>
          {treeCrossOutDone && <Check className="size-4 col-start-3" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            setTreeShowHeader(!treeShowHeader)
          }}
          className="cursor-pointer"
        >
          <span className="col-start-2">Show header</span>
          {treeShowHeader && <Check className="size-4 col-start-3" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
