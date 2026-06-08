// cap-shell-6 — window.api.files shim. Electron preload exposed
// webUtils.getPathForFile() so drag-drop handlers could resolve a native
// path from a DataTransfer.File. chrome:// origin has no such API, so the
// shell can't support "drop external file onto editor" this pass — the
// equivalent flow will require either a dedicated upload route or a custom
// drag source (cap-shell-7). For now return [] synchronously so the drop
// handler no-ops cleanly instead of throwing.
//
// cap-shell-12 — pathExists lands here (not fs.ts) because the Electron
// preload surfaces it under window.api.files. Backed by the sidecar's
// fs:exists JSON-RPC handler.

import { jsonRpcCall } from '../transport/mojo'

export const filesShim = {
  getDropPaths: (): string[] => [],
  pathExists: (filePath: string): Promise<boolean> =>
    jsonRpcCall<boolean>('fs:exists', { params: [filePath] }),
}
