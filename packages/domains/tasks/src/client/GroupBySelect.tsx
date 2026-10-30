import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipTrigger,
  TooltipContent
} from '@slayzone/ui'
import type { GroupKey } from './FilterState'
import { useTrack } from '@slayzone/telemetry/client'

interface GroupBySelectProps {
  value: GroupKey
  onChange: (v: GroupKey) => void
}

const GROUP_OPTIONS: { value: GroupKey; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'due_date', label: 'Due Date' }
]

export function GroupBySelect({ value, onChange }: GroupBySelectProps): React.JSX.Element {
  const { track } = useTrack()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Select
          value={value}
          onValueChange={(v) => {
            track('group_by_changed', { field: v })
            onChange(v as GroupKey)
          }}
        >
          <SelectTrigger className="w-[120px]" size="sm">
            <SelectValue placeholder="Group by" />
          </SelectTrigger>
          <SelectContent>
            {GROUP_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Group tasks by field. Note: Due Date grouping disables drag-to-reorder.
      </TooltipContent>
    </Tooltip>
  )
}
