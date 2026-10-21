import { getSharedStatusColumns } from './columns'
import { DEFAULT_COLUMNS, type ColumnConfig } from './types'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('  ok:', msg)
  } else {
    console.error('  FAIL:', msg)
    failures += 1
  }
}
const ids = (columns: ColumnConfig[]): string => columns.map((c) => c.id).join(',')

const custom: ColumnConfig[] = [
  { id: 'todo', label: 'To do', color: 'blue', position: 0, category: 'unstarted' },
  { id: 'doing', label: 'Doing', color: 'yellow', position: 1, category: 'started' },
  { id: 'done', label: 'Shipped', color: 'green', position: 2, category: 'completed' }
]
const disjoint: ColumnConfig[] = [
  { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
  { id: 'closed', label: 'Closed', color: 'green', position: 1, category: 'completed' }
]
// No completed column → fails validation → the project uses the defaults.
const invalid: ColumnConfig[] = [
  { id: 'doing', label: 'Doing', color: 'yellow', position: 0, category: 'started' }
]
const defaultIds = ids(DEFAULT_COLUMNS)

// --- one project: all of its statuses ---
assert(ids(getSharedStatusColumns([custom])) === 'todo,doing,done', 'one project → its columns')
assert(ids(getSharedStatusColumns([null])) === defaultIds, 'one unconfigured project → defaults')

// --- several projects: only statuses every one of them has ---
assert(
  ids(getSharedStatusColumns([null, undefined])) === defaultIds,
  'two unconfigured projects → defaults'
)
assert(
  ids(getSharedStatusColumns([null, custom])) === 'todo,done',
  'defaults + custom → the ids both have'
)
assert(
  ids(getSharedStatusColumns([custom, null])) === 'todo,done',
  'custom + defaults → same ids, in the first project’s order'
)
assert(
  getSharedStatusColumns([custom, null]).find((c) => c.id === 'done')?.label === 'Shipped',
  'labels come from the first project'
)
assert(getSharedStatusColumns([null, disjoint]).length === 0, 'no overlap → nothing shared')

// --- same resolution as the backend: an invalid config means the defaults ---
assert(
  ids(getSharedStatusColumns([invalid, null])) === defaultIds,
  'invalid config counts as the defaults'
)

// --- nothing selected ---
assert(getSharedStatusColumns([]).length === 0, 'no projects → nothing shared')

if (failures > 0) {
  console.error(`${failures} failure(s)`)
  process.exit(1)
}
console.log('All getSharedStatusColumns tests passed')
