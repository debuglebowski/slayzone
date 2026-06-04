// Relocated to ../server/events.ts (electron-free) so the transport task router's
// `onChanged` subscription can import `taskEvents` without pulling Electron. This
// module stays as the `@slayzone/task/main` re-export for existing importers.
export { taskEvents } from '../server/events'
export type { TaskEventMap } from '../server/events'
