export {
  registerTerminalTabsHandlers,
  createPtyEnricher,
  markTabSpawned,
  markTabHibernated
} from './handlers'
// Tab CRUD ops live in the electron-free store now; re-export to preserve the
// `@slayzone/task-terminals/main` surface for the REST routes + PTY cold-start.
export { createTabRow, splitTabRow, updateTabRow, ensureMainTab } from '../server'
