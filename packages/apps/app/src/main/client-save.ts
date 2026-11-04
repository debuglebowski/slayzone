// Saving bytes the renderer already holds onto THIS machine — artifact file, folder
// and zip downloads. The hub only served the bytes (`artifacts.readBytes`); the
// dialogs and the writes happen here, so a download lands on the person's own disk
// whether the hub is local or remote. Reached over `app:save-file` / `app:save-files`.
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, extname, join } from 'path'
import { BrowserWindow, app, dialog, shell } from 'electron'
import { containedPath } from '@slayzone/platform/safe-path'
import type {
  HostSaveResult,
  SaveFileRequest,
  SaveFilesRequest
} from '@slayzone/platform/electron-bootstrap-contract'

const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array

/** The renderer's request, checked: it crosses the IPC boundary untyped. */
export function parseSaveFileRequest(raw: unknown): SaveFileRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.fileName !== 'string' || typeof r.title !== 'string' || !isBytes(r.data)) return null
  return { fileName: r.fileName, title: r.title, data: r.data, reveal: r.reveal === true }
}

export function parseSaveFilesRequest(raw: unknown): SaveFilesRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.folderName !== 'string' || typeof r.title !== 'string') return null
  if (!Array.isArray(r.files)) return null
  const files: SaveFilesRequest['files'] = []
  for (const f of r.files as unknown[]) {
    const e = f as Record<string, unknown> | null
    if (!e || typeof e.path !== 'string' || !isBytes(e.data)) return null
    files.push({ path: e.path, data: e.data })
  }
  const dirs = Array.isArray(r.dirs) ? r.dirs.filter((d): d is string => typeof d === 'string') : []
  return { folderName: r.folderName, title: r.title, files, dirs }
}

function showSave(parent: BrowserWindow | null, options: Electron.SaveDialogOptions) {
  return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options)
}

function showOpen(parent: BrowserWindow | null, options: Electron.OpenDialogOptions) {
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
}

/** Ask where, write, optionally reveal. */
export async function saveFileOnDesktop(
  parent: BrowserWindow | null,
  raw: unknown
): Promise<HostSaveResult> {
  const req = parseSaveFileRequest(raw)
  if (!req) return { ok: false, error: 'Invalid save request' }
  const ext = extname(req.fileName).slice(1)
  const picked = await showSave(parent, {
    title: req.title,
    defaultPath: join(app.getPath('downloads'), req.fileName),
    ...(ext ? { filters: [{ name: ext.toUpperCase(), extensions: [ext] }] } : {})
  })
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
  writeFileSync(picked.filePath, req.data)
  if (req.reveal) shell.showItemInFolder(picked.filePath)
  return { ok: true }
}

/**
 * Ask for a directory, then write every file at its relative path inside it. A path
 * that would leave the directory is refused (the whole save fails, nothing outside is
 * written): titles and folder names are free text.
 */
export async function saveFilesOnDesktop(
  parent: BrowserWindow | null,
  raw: unknown
): Promise<HostSaveResult> {
  const req = parseSaveFilesRequest(raw)
  if (!req) return { ok: false, error: 'Invalid save request' }
  const picked = await showOpen(parent, {
    title: req.title,
    properties: ['openDirectory', 'createDirectory']
  })
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true }
  const root = picked.filePaths[0]
  // Resolve every destination before writing any, so a refused path writes nothing.
  const dirs = (req.dirs ?? []).map((d) => containedPath(root, ...d.split('/')))
  const targets = req.files.map((f) => ({ dest: containedPath(root, ...f.path.split('/')), f }))
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
  for (const { dest, f } of targets) {
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, f.data)
  }
  return { ok: true }
}
