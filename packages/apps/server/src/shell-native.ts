// Native shell ops the standalone server implements itself — no Electron host.
//
// In the Electron app these are bridged to `shell.openPath` /
// `shell.showItemInFolder`. The Chromium-fork sidecar has no Electron host, so
// we do them directly with per-OS commands (plain Node, no native deps). Covers
// the Git + Editor panels' "Reveal in Finder" / "Open" actions.
import { execFile } from 'node:child_process'
import { dirname } from 'node:path'

function openCommand(p: string): [string, string[]] {
  switch (process.platform) {
    case 'darwin':
      return ['open', [p]]
    case 'win32':
      // `start` is a cmd builtin; "" is the (empty) window title arg.
      return ['cmd', ['/c', 'start', '', p]]
    default:
      return ['xdg-open', [p]]
  }
}

function revealCommand(p: string): [string, string[]] {
  switch (process.platform) {
    case 'darwin':
      return ['open', ['-R', p]]
    case 'win32':
      return ['explorer', [`/select,${p}`]]
    default:
      // No portable "reveal + select" on Linux — open the containing folder.
      return ['xdg-open', [dirname(p)]]
  }
}

/** Open a file/folder with the OS default handler. Resolves '' on success, else an error string. */
export function openPath(absPath: string): Promise<string> {
  return new Promise((resolve) => {
    const [cmd, args] = openCommand(absPath)
    execFile(cmd, args, (err) => resolve(err ? String(err.message ?? err) : ''))
  })
}

/** Reveal + select a path in the OS file manager. Fire-and-forget. */
export function showItemInFolder(absPath: string): void {
  const [cmd, args] = revealCommand(absPath)
  execFile(cmd, args, () => {
    /* best-effort reveal */
  })
}
