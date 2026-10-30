# Projects Domain

Project management - containers for tasks with color coding. A project's folder
(its source code) lives on a computer, not on the hub.

## Contracts (`@slayzone/projects-contracts`)

```typescript
interface ProjectRecord {        // the stored `projects` row
  id: string
  name: string
  color: string
  path: string | null            // LEGACY hub column, dropped next release
  default_computer_id: string | null
  // …
}

interface Project extends Omit<ProjectRecord, 'path'> {  // what the hub returns
  placements: ProjectPlacement[]       // the folder on each computer
  resolved_computer_id: string | null  // the computer the hub uses for it
}
```

Read a folder with the helpers, never a column: `defaultProjectRoot(project)`
(project-wide views), `taskProjectRoot(task, project)` (a task's computer),
`projectRootOn(project, computerId)`.

## Where a folder lives

- The computer's own `computer.projects.json` is the authority.
- The hub keeps a copy in `project_placements` (`pending` / `ready` / `missing` /
  `refused`), kept in step by `apps/hub/src/computer-project-sync.ts`.
- Upgrade: migration v176 turns each legacy `projects.path` into a `pending` folder
  on the local computer (and the local computer into the default), before the hub
  serves anything. Desktop-only users see no change and do nothing.
- Every write goes through the hub-injected `ProjectFolderHost`
  (`server/project-folders.ts`): `projects.create` / `update`, REST, CLI, import.
- Every Project the hub returns goes through `attachPlacements`
  (`server/project-placements.ts`).

## Client (client/)

- `CreateProjectDialog` / `ProjectSettingsDialog` / `DeleteProjectDialog`
- `ProjectSelect` - Dropdown selector

## Dependencies

`@slayzone/computers` (placements).
