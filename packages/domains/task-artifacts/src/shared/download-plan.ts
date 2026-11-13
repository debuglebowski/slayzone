/**
 * What a client writes when the person downloads a folder or a whole task's artifacts:
 * every file's path inside the download, from the task's folder tree. Pure and
 * isomorphic — the client plans, reads the bytes from the hub, and saves on its own
 * device (desktop into a picked directory or a zip, the web shell as a zip).
 *
 * Folder names and titles are free text (an agent can name an artifact `../../.zshrc`),
 * so every path is reduced to plain segments here: no `..`, `.`, empty or absolute
 * part survives, and the desktop writer still refuses any path that would leave the
 * picked directory.
 */
interface FolderRow {
  id: string
  name: string
  parent_id: string | null
}

interface ArtifactRow {
  id: string
  title: string
  folder_id: string | null
}

/** One file of a download: the artifact to read and where it goes. */
export interface DownloadEntry {
  artifactId: string
  /** `/`-separated, relative, every segment safe. */
  path: string
}

/** A name as one safe path segment ('' when nothing usable is left). */
function safeSegments(name: string): string[] {
  return name
    .split(/[/\\]/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '.' && s !== '..')
}

/** folderId → its segments from the task root (unknown id or a cycle → []). */
function folderSegments(folders: FolderRow[]): (id: string | null) => string[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  return (id) => {
    const out: string[][] = []
    const seen = new Set<string>()
    let cur = id ? byId.get(id) : undefined
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      out.unshift(safeSegments(cur.name))
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
    }
    return out.flat()
  }
}

/** A folder id plus all its (transitive) descendant folder ids. */
export function folderAndDescendants(folders: FolderRow[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const f of folders) {
      if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) {
        ids.add(f.id)
        changed = true
      }
    }
  }
  return ids
}

/**
 * A title as ONE safe file name: path separators can't climb or nest (`../../x.md` →
 * `x.md`, `/a/b.md` → `a_b.md`); `fallback` when nothing usable is left.
 */
export function safeFileName(title: string, fallback: string): string {
  const segs = safeSegments(title)
  return segs.length ? segs.join('_') : fallback
}

/**
 * Every artifact of the task, at `<folder path>/<title>`, for "Download all as ZIP".
 */
export function planTaskDownload(folders: FolderRow[], artifacts: ArtifactRow[]): DownloadEntry[] {
  const segs = folderSegments(folders)
  return artifacts.map((a) => ({
    artifactId: a.id,
    path: [...segs(a.folder_id), safeFileName(a.title, a.id)].join('/')
  }))
}

/**
 * The folder `folderId` and everything under it, each path starting with the folder's
 * own name (it lands inside the directory the person picks); `dirs` are its folders,
 * empty ones included. Null when the folder is not in `folders`.
 */
export function planFolderDownload(
  folders: FolderRow[],
  artifacts: ArtifactRow[],
  folderId: string
): { folderName: string; dirs: string[]; entries: DownloadEntry[] } | null {
  const root = folders.find((f) => f.id === folderId)
  if (!root) return null
  const segs = folderSegments(folders)
  const parentDepth = segs(root.parent_id).length
  const ids = folderAndDescendants(folders, folderId)
  const entries = artifacts
    .filter((a) => a.folder_id !== null && ids.has(a.folder_id))
    .map((a) => ({
      artifactId: a.id,
      path: [...segs(a.folder_id).slice(parentDepth), safeFileName(a.title, a.id)].join('/')
    }))
  // Every folder of the subtree, so an empty one still arrives (as it always did).
  const dirs = folders
    .filter((f) => ids.has(f.id))
    .map((f) => segs(f.id).slice(parentDepth).join('/'))
    .filter((d) => d !== '')
  const folderName = safeSegments(root.name).join('_') || 'folder'
  return { folderName, dirs, entries }
}
