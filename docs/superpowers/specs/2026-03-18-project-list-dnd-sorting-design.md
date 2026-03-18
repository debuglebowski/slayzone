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

- `getAll`: `ORDER BY name` → `ORDER BY sort_order`
- `create`: Before insert, compute `SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects` and include in the INSERT

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

### `ProjectSelect.tsx`

No changes to ordering — continues to sort alphabetically client-side via `.sort((a, b) => a.name.localeCompare(b.name))`.

## Preload Bridge

Register `reorderProjects` in the preload script, mapping to `db:projects:reorder`.

## Scope Exclusions

- No drag handle icon — the entire project blob is the drag target
- No keyboard reordering — drag only
- No DragOverlay — uses default inline drag behavior
