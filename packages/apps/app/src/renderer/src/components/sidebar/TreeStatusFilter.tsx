import { useMemo } from 'react'
import { Filter } from 'lucide-react'
import {
  cn,
  buildStatusOptions,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from '@slayzone/ui'
import { useTabStore } from '@slayzone/settings'

export function TreeStatusFilter() {
  const treeStatusFilter = useTabStore((s) => s.treeStatusFilter)
  const setTreeStatusFilter = useTabStore((s) => s.setTreeStatusFilter)
  const statusOptions = useMemo(() => buildStatusOptions(null), [])

  const summary =
    treeStatusFilter.length === 0
      ? 'No statuses'
      : treeStatusFilter.length === statusOptions.length
        ? 'All statuses'
        : treeStatusFilter
            .map((v) => statusOptions.find((o) => o.value === v)?.label ?? v)
            .join(', ')

  const toggle = (value: string) => {
    setTreeStatusFilter(
      treeStatusFilter.includes(value)
        ? treeStatusFilter.filter((s) => s !== value)
        : [...treeStatusFilter, value]
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Filter statuses (${summary})`}
          title={summary}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
        >
          <Filter className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="min-w-[200px]">
        {statusOptions.map((opt) => {
          const Icon = opt.icon
          return (
            <DropdownMenuCheckboxItem
              key={opt.value}
              checked={treeStatusFilter.includes(opt.value)}
              onCheckedChange={() => toggle(opt.value)}
              onSelect={(e) => e.preventDefault()}
            >
              <Icon className={cn('size-3.5', opt.iconClass)} />
              <span>{opt.label}</span>
            </DropdownMenuCheckboxItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
