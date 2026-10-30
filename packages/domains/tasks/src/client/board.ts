/**
 * The board's logic without its UI — `@slayzone/tasks/board`: columns, sorting,
 * filters, the create draft of a column, and patching board rows from a change
 * event. The desktop board (`KanbanBoard`, `useTasksData`) and the mobile app use the
 * same functions.
 *
 * Every module re-exported here, and everything they import at runtime, is free of
 * DOM, React and desktop UI code: the mobile app bundles it into React Native, and
 * `packages/apps/mobile/src/shared-logic.test.ts` imports it there with the desktop
 * UI packages mocked to throw. Keep it that way: a module that needs the DOM does not
 * belong behind this entry.
 */
export {
  addDaysISO,
  applyFilters,
  columnToCreateTaskDraft,
  groupTasksBy,
  PRIORITY_LABELS,
  sortTasks,
  todayISO,
  type Column,
  type GroupKey,
  type GroupOpts
} from './kanban'
export * from './FilterState'
export {
  MAX_PATCH_ROWS,
  mergeRow,
  parentIdsOf,
  patchBoardRows,
  patchMirrorBlocked,
  patchMirrorTasks,
  patchMirrorTaskTags,
  type BoardData,
  type BoardRows
} from './board-patch'
