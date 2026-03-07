# Test Panel Domain

Dev-only panel showing test files discovered in project directory as a read-only kanban. Users define categories (name + regex) that become columns.

## Shared (shared/)

- `TestCategory`, `TestProfile`, `ScanResult` types

## Main (main/)

- `registerTestPanelHandlers` - IPC handlers for category CRUD, profile management, file scanning

## Client (client/)

- `TestPanel` - Main panel with columns layout
- `TestColumn` - Single kanban column
- `TestFileCard` - Single file card
- `CategoryManager` - Category + profile management dialog

## Dependencies

- `@slayzone/ui` - Card, UI primitives
