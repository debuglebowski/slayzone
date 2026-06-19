import { closeAllFileWatchers } from '../server/watcher'

// The IPC file handlers (fs:*) + the per-window fs:changed/fs:deleted watcher
// bridge were removed at the IPC→tRPC cutover — the renderer uses the tRPC
// `fileEditor` router + its `watch` subscription (same electron-free server
// store). Only this host-level shutdown cleanup remains; it closes every
// server-side watcher, including those opened by the tRPC subscription.
export function closeAllWatchers(): void {
  closeAllFileWatchers()
}
