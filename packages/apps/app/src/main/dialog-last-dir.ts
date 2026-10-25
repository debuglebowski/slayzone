import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname } from 'path'

// Since Electron 43 a file dialog opened without `defaultPath` starts in Downloads,
// and the OS no longer remembers the last folder per app. Every main-process dialog
// goes through this wrapper so a dialog with no `defaultPath` opens where the user
// last picked a file or folder, as before. Persisted, because the OS remembered it
// across restarts too.

interface OpenOptions {
  defaultPath?: string
  properties?: string[]
}
interface OpenResult {
  canceled: boolean
  filePaths: string[]
}
interface SaveResult {
  canceled: boolean
  filePath?: string
}

/** The two Electron dialog calls, window first when given (Electron's own overloads). */
export interface DialogPort<W, O extends OpenOptions, S extends { defaultPath?: string }> {
  showOpenDialog(window: W | null, options: O): Promise<OpenResult>
  showSaveDialog(window: W | null, options: S): Promise<SaveResult>
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Reads/writes the last folder as `{ "dir": "..." }`; a missing or bad file means none. */
export function createLastDirStore(file: string): {
  get(): string | null
  set(dir: string): void
} {
  let dir: string | null = null
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { dir?: unknown }
      if (typeof parsed.dir === 'string') dir = parsed.dir
    }
  } catch {
    dir = null
  }
  return {
    get: () => (dir && isDirectory(dir) ? dir : null),
    set: (next) => {
      dir = next
      try {
        writeFileSync(file, JSON.stringify({ dir: next }))
      } catch {
        // Remembering the folder is a convenience: the in-memory value still serves
        // this session, and a failed write must never fail the dialog itself.
      }
    }
  }
}

export function createRememberingDialog<
  W,
  O extends OpenOptions,
  S extends { defaultPath?: string }
>(port: DialogPort<W, O, S>, store: { get(): string | null; set(dir: string): void }) {
  function withLastDir<T extends { defaultPath?: string }>(options: T): T {
    if (options.defaultPath) return options
    const last = store.get()
    return last ? { ...options, defaultPath: last } : options
  }

  return {
    async showOpenDialog(window: W | null, options: O): Promise<OpenResult> {
      const result = await port.showOpenDialog(window, withLastDir(options))
      const picked = result.filePaths[0]
      if (!result.canceled && picked) {
        // A picked folder is itself the place to return to; a picked file, its folder.
        const pickedDir = options.properties?.includes('openDirectory') ? picked : dirname(picked)
        store.set(pickedDir)
      }
      return result
    },
    async showSaveDialog(window: W | null, options: S): Promise<SaveResult> {
      const result = await port.showSaveDialog(window, withLastDir(options))
      if (!result.canceled && result.filePath) store.set(dirname(result.filePath))
      return result
    }
  }
}
