import type { Tag } from '@slayzone/tags/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import type { FilterState } from './FilterState'
import { FilterBarB } from './FilterBarB'

interface FilterBarProps {
  filter: FilterState
  onChange: (f: FilterState) => void
  tags: Tag[]
  columns?: ColumnConfig[] | null
}

export function FilterBar({ filter, onChange, tags, columns }: FilterBarProps): React.JSX.Element {
  return <FilterBarB filter={filter} onChange={onChange} tags={tags} columns={columns} />
}
