# Project List Drag-and-Drop Sorting

## Overview

Allow users to reorder the project list in the sidebar via drag and drop. Projects are currently sorted alphabetically; this feature adds a persistent custom sort order.

## Decisions

- New projects appear at the **bottom** of the list
- The sidebar reflects the custom sort order; the `ProjectSelect` dropdown remains **alphabetical**
- Visual feedback is **minimal** — standard dnd-kit behavior (item follows cursor, others shift), matching the existing Kanban patterns
- Uses **integer `sort_order` column** approach — simple, proven pattern already used for `test_categories`/`test_labels`

## Database

### Migration (v77)

Add `sort_order` column and backfill existing rows in alphabetical order:

```sql
ALTER TABLE projects ADD COLUMN sort_order INTEGER DEFAULT 0;
```

Backfill in the migration's JS body using a ranked update so existing alphabetical order is preserved:

```typescript
const rows = db.prepare('SELECT id FROM projects ORDER BY name').all()
const update = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
rows.forEach((row, index) => update.run(index, row.id))
```

### Query changes

- `getAll` (`db:projects:getAll` in project handlers): `ORDER BY name` → `ORDER BY sort_order`
- `loadBoardData` (`db:loadBoardData` in task handlers): also queries projects with `ORDER BY name` — change to `ORDER BY sort_order`
- `create` (Electron handler): Before insert, compute `SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects`. Add `sort_order` to the INSERT column list and pass the computed value in `stmt.run()`
- `create` (CLI at `packages/apps/cli/src/commands/projects.ts`): Same change — compute `MAX(sort_order) + 1` and include in the INSERT so CLI-created projects append to the bottom

### New IPC handler: `db:projects:reorder`

Accepts `{ projectIds: string[] }`. Wraps in a transaction, sets each project's `sort_order` to its array index:

```typescript
ipcMain.handle('db:projects:reorder', (_, projectIds: string[]) => {
  const update = db.prepare("UPDATE projects SET sort_order = ?, updated_at = datetime('now') WHERE id = ?")
  db.transaction(() => {
    projectIds.forEach((id, index) => update.run(index, id))
  })()
})
```

## Type Changes

### `packages/domains/projects/src/shared/types.ts`

Add to `Project` interface:

```typescript
sort_order: number
```

No changes to `CreateProjectInput` or `UpdateProjectInput` — sort order is computed server-side, and reordering uses its own handler.

### `packages/shared/types/src/api.ts`

Add to the `db` section of `ElectronAPI`:

```typescript
reorderProjects: (projectIds: string[]) => Promise<void>
```

## UI Changes

### `AppSidebar.tsx`

Wrap the project list in `DndContext` + `SortableContext` using `verticalListSortingStrategy`.

Sensors: `PointerSensor` with activation distance constraint (prevents drag on regular click), matching the existing Kanban pattern.

On `DragEnd`:
1. Compute new order via `arrayMove` from `@dnd-kit/sortable`
2. Optimistically update local project list state
3. Call `window.api.db.reorderProjects(newOrder.map(p => p.id))`

### `ProjectItem.tsx`

Wrap with `useSortable` from `@dnd-kit/sortable`. Apply transform/transition styles via `CSS.Transform.toString()`.

The component nests `Tooltip > ContextMenu > motion.button`. The `useSortable` ref and transform styles should go on an outermost wrapper `div`, not on the button itself. The `motion.button` `whileTap`/`animate` props may conflict with dnd-kit transforms — test this interaction and simplify framer-motion usage during drag if needed.

### `ProjectSelect.tsx`

Add an explicit `.sort((a, b) => a.name.localeCompare(b.name))` before rendering — currently the dropdown renders projects in whatever order `getProjects()` returns, which was alphabetical but will become `sort_order` after this change. The sort call keeps the dropdown alphabetical for quick lookup.

## Preload Bridge

Register `reorderProjects` in the preload script, mapping to `db:projects:reorder`.

## Scope Exclusions

- No drag handle icon — the entire project blob is the drag target
- No keyboard reordering — drag only
- No DragOverlay — uses default inline drag behavior
