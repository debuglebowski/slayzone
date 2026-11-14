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

/** The longest file name the filesystems people save to accept, in UTF-8 bytes. */
export const NAME_MAX_BYTES = 255

const utf8Length = (s: string): number => new TextEncoder().encode(s).byteLength

/** `s` cut to at most `max` UTF-8 bytes, never inside a character. */
export function truncateUtf8(s: string, max: number): string {
  if (utf8Length(s) <= max) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const len = utf8Length(ch)
    if (used + len > max) break
    out += ch
    used += len
  }
  return out
}

/**
 * Copy `n` of a file name, as file managers number them: `a.md` → `a (2).md`. The
 * stem is shortened when needed, so the result never exceeds {@link NAME_MAX_BYTES}
 * even for a name already at the limit; the extension is kept.
 */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  const suffix = ` (${n})${ext}`
  return `${truncateUtf8(stem, Math.max(1, NAME_MAX_BYTES - utf8Length(suffix)))}${suffix}`
}

/** How two paths compare on the filesystems people save to (APFS, NTFS: case-blind). */
const pathKey = (p: string): string => p.normalize('NFC').toLowerCase()

/**
 * Make every entry's path unique, the way a file manager numbers copies
 * (`a.md`, `a (2).md`, …): case-insensitively, and never equal to a folder (every
 * entry's parent counts as one, as do `dirs`). Titles are not unique, and two
 * titles can sanitise to one name; without this, two artifacts would end up in one
 * file or zip entry.
 */
function uniquePaths(entries: DownloadEntry[], dirs: string[] = []): DownloadEntry[] {
  const folders = new Set<string>()
  const addFolders = (p: string): void => {
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1))
      folders.add(pathKey(p.slice(0, i)))
  }
  for (const d of dirs) {
    addFolders(`${d}/`)
  }
  for (const e of entries) addFolders(e.path)
  const taken = new Set<string>()
  return entries.map((e) => {
    let path = e.path
    if (taken.has(pathKey(path)) || folders.has(pathKey(path))) {
      const slash = path.lastIndexOf('/')
      const dir = path.slice(0, slash + 1)
      const name = path.slice(slash + 1)
      for (let n = 2; ; n++) {
        path = dir + numberedName(name, n)
        if (!taken.has(pathKey(path)) && !folders.has(pathKey(path))) break
      }
    }
    taken.add(pathKey(path))
    return { artifactId: e.artifactId, path }
  })
}

/**
 * Every artifact of the task, at `<folder path>/<title>` (unique), for "Download all
 * as ZIP".
 */
export function planTaskDownload(folders: FolderRow[], artifacts: ArtifactRow[]): DownloadEntry[] {
  const segs = folderSegments(folders)
  return uniquePaths(
    artifacts.map((a) => ({
      artifactId: a.id,
      path: [...segs(a.folder_id), safeFileName(a.title, a.id)].join('/')
    }))
  )
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
  // Every folder of the subtree, so an empty one still arrives (as it always did).
  const dirs = folders
    .filter((f) => ids.has(f.id))
    .map((f) => segs(f.id).slice(parentDepth).join('/'))
    .filter((d) => d !== '')
  const entries = uniquePaths(
    artifacts
      .filter((a) => a.folder_id !== null && ids.has(a.folder_id))
      .map((a) => ({
        artifactId: a.id,
        path: [...segs(a.folder_id).slice(parentDepth), safeFileName(a.title, a.id)].join('/')
      })),
    dirs
  )
  const folderName = safeSegments(root.name).join('_') || 'folder'
  return { folderName, dirs, entries }
}
