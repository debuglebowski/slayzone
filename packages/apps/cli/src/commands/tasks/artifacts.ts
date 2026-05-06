import { Command } from 'commander'
import archiver from 'archiver'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { openDb, notifyApp, postJson, getArtifactsDir, getDataDir, getMcpPort, type SlayDb } from '../../db'
import {
  BlobStore,
  createVersion,
  saveCurrent,
  mutateVersion,
  setCurrentVersion,
  getCurrentVersion,
  listVersions,
  resolveVersionRef,
  readVersionContent,
  renameVersion,
  diffVersions,
  pruneVersions,
  nodeSqliteTxn,
  isVersionError,
} from '@slayzone/task-artifacts/server'
import {
  getExtensionFromTitle,
  getEffectiveRenderMode,
  isBinaryRenderMode,
  canExportAsPdf,
  canExportAsPng,
  canExportAsHtml,
  type RenderMode,
} from '@slayzone/task/shared/types'
import { apiPost } from '../../api'
import { cliAuthor } from './_shared'

interface ArtifactRow extends Record<string, unknown> {
  id: string
  task_id: string
  folder_id: string | null
  title: string
  render_mode: string | null
  language: string | null
  order: number
  created_at: string
  updated_at: string
}

interface ArtifactFolderRow extends Record<string, unknown> {
  id: string
  task_id: string
  parent_id: string | null
  name: string
  order: number
  created_at: string
}

function resolveArtifact(db: SlayDb, prefix: string): ArtifactRow {
  const rows = db.query<ArtifactRow>(
    `SELECT * FROM task_artifacts WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': prefix }
  )
  if (rows.length === 0) {
    console.error(`Artifact not found: "${prefix}"`)
    process.exit(1)
  }
  if (rows.length > 1) {
    console.error(`Ambiguous artifact id "${prefix}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }
  return rows[0]
}

function resolveTaskForArtifact(db: SlayDb, taskOpt?: string): { id: string; title: string } {
  const ref = taskOpt ?? process.env.SLAYZONE_TASK_ID
  if (!ref) {
    console.error('No task ID provided and $SLAYZONE_TASK_ID is not set.')
    process.exit(1)
  }
  const rows = db.query<{ id: string; title: string }>(
    `SELECT id, title FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': ref }
  )
  if (rows.length === 0) {
    console.error(`Task not found: "${ref}"`)
    process.exit(1)
  }
  if (rows.length > 1) {
    console.error(`Ambiguous task id "${ref}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }
  return rows[0]
}

function resolveFolder(db: SlayDb, prefix: string): ArtifactFolderRow {
  const rows = db.query<ArtifactFolderRow>(
    `SELECT * FROM artifact_folders WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': prefix }
  )
  if (rows.length === 0) {
    console.error(`Folder not found: "${prefix}"`)
    process.exit(1)
  }
  if (rows.length > 1) {
    console.error(`Ambiguous folder id "${prefix}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }
  return rows[0]
}

function artifactFilePath(artifactsDir: string, taskId: string, artifactId: string, title: string): string {
  const ext = getExtensionFromTitle(title) || '.txt'
  return path.join(artifactsDir, taskId, `${artifactId}${ext}`)
}

function printArtifacts(artifacts: ArtifactRow[], folders?: ArtifactFolderRow[]) {
  if (artifacts.length === 0) {
    console.log('No artifacts.')
    return
  }
  const folderMap = new Map((folders ?? []).map(f => [f.id, f.name]))
  const idW = 9
  const titleW = 24
  const modeW = 16
  const folderW = 14
  console.log(`${'ID'.padEnd(idW)}  ${'TITLE'.padEnd(titleW)}  ${'FOLDER'.padEnd(folderW)}  ${'MODE'.padEnd(modeW)}  CREATED`)
  console.log(`${'-'.repeat(idW)}  ${'-'.repeat(titleW)}  ${'-'.repeat(folderW)}  ${'-'.repeat(modeW)}  ${'-'.repeat(20)}`)
  for (const a of artifacts) {
    const id = a.id.slice(0, 8).padEnd(idW)
    const title = a.title.slice(0, titleW).padEnd(titleW)
    const folder = (a.folder_id ? (folderMap.get(a.folder_id) ?? '?') : '').slice(0, folderW).padEnd(folderW)
    const mode = getEffectiveRenderMode(a.title, a.render_mode as RenderMode | null).padEnd(modeW)
    const created = a.created_at.slice(0, 19)
    console.log(`${id}  ${title}  ${folder}  ${mode}  ${created}`)
  }
}

function printArtifactTree(artifacts: ArtifactRow[], folders: ArtifactFolderRow[]) {
  if (artifacts.length === 0 && folders.length === 0) {
    console.log('No artifacts.')
    return
  }
  // Build folder path map
  const byId = new Map(folders.map(f => [f.id, f]))
  function folderPath(id: string): string {
    const f = byId.get(id)
    if (!f) return '?'
    return f.parent_id ? `${folderPath(f.parent_id)}/${f.name}` : f.name
  }

  // Group: parentId -> children
  const childFolders = new Map<string | null, ArtifactFolderRow[]>()
  for (const f of folders) {
    const arr = childFolders.get(f.parent_id) ?? []
    arr.push(f)
    childFolders.set(f.parent_id, arr)
  }
  const artifactsByFolder = new Map<string | null, ArtifactRow[]>()
  for (const a of artifacts) {
    const arr = artifactsByFolder.get(a.folder_id) ?? []
    arr.push(a)
    artifactsByFolder.set(a.folder_id, arr)
  }

  function printLevel(parentId: string | null, indent: string) {
    const subFolders = childFolders.get(parentId) ?? []
    for (const f of subFolders) {
      console.log(`${indent}${f.name}/  (${f.id.slice(0, 8)})`)
      printLevel(f.id, indent + '  ')
    }
    const subArtifacts = artifactsByFolder.get(parentId) ?? []
    for (const a of subArtifacts) {
      console.log(`${indent}${a.title}  (${a.id.slice(0, 8)})`)
    }
  }

  printLevel(null, '')
}

async function readStdin(): Promise<Buffer> {
  if (process.stdin.isTTY) {
    console.error('No content provided. Pipe content via stdin.')
    process.exit(1)
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function getAvailableExportTypes(mode: RenderMode): string[] {
  const types = ['raw']
  if (canExportAsPdf(mode)) types.push('pdf')
  if (canExportAsPng(mode)) types.push('png')
  if (canExportAsHtml(mode)) types.push('html')
  return types
}

interface SearchMatcher {
  test: (s: string) => boolean
}

interface SearchMatch {
  type: 'title' | 'content'
  line?: number
  snippet: string
  contextBefore?: string | null
  contextAfter?: string | null
}

interface SearchResult {
  artifactId: string
  taskId: string
  title: string
  matches: SearchMatch[]
}

const MAX_SCAN_BYTES = 5_000_000
const SNIPPET_MAX = 200

function compileMatcher(query: string, opts: { regex?: boolean; caseSensitive?: boolean }): SearchMatcher {
  if (opts.regex) {
    try {
      const re = new RegExp(query, opts.caseSensitive ? '' : 'i')
      return { test: (s) => re.test(s) }
    } catch (e) {
      console.error(`Invalid regex: ${(e as Error).message}`)
      process.exit(1)
    }
  }
  if (opts.caseSensitive) {
    return { test: (s) => s.includes(query) }
  }
  const q = query.toLowerCase()
  return { test: (s) => s.toLowerCase().includes(q) }
}

function sanitizeSnippet(s: string): string {
  // Replace tabs/control chars with spaces, truncate
  const cleaned = s.replace(/[\t\x00-\x08\x0b-\x1f\x7f]/g, ' ')
  return cleaned.length > SNIPPET_MAX ? cleaned.slice(0, SNIPPET_MAX) + '…' : cleaned
}

function scanContentForMatches(content: string, matcher: SearchMatcher, maxMatches: number): SearchMatch[] {
  const lines = content.split('\n')
  const out: SearchMatch[] = []
  for (let i = 0; i < lines.length; i++) {
    if (matcher.test(lines[i])) {
      out.push({
        type: 'content',
        line: i + 1,
        snippet: sanitizeSnippet(lines[i]),
        contextBefore: i > 0 ? sanitizeSnippet(lines[i - 1]) : null,
        contextAfter: i + 1 < lines.length ? sanitizeSnippet(lines[i + 1]) : null,
      })
      if (out.length >= maxMatches) break
    }
  }
  return out
}

function loadArtifactContent(
  raw: ReturnType<SlayDb['raw']>,
  blobStore: BlobStore,
  artifactId: string,
  artifactLabel: string
): string | null {
  const version = getCurrentVersion(raw, artifactId)
  if (!version) return null
  if (version.size > MAX_SCAN_BYTES) {
    process.stderr.write(`[skipped large artifact] ${artifactLabel} (${(version.size / 1_000_000).toFixed(1)}MB)\n`)
    return null
  }
  try {
    const buf = readVersionContent(blobStore, version)
    return buf.toString('utf-8')
  } catch {
    return null
  }
}

function printSearchResultsHuman(results: SearchResult[], scannedCount: number, truncated: boolean): void {
  if (results.length === 0) {
    console.log('No matches.')
    return
  }
  let totalMatches = 0
  for (const r of results) {
    totalMatches += r.matches.length
    console.log(`${r.artifactId.slice(0, 8)}  ${r.title}  (task: ${r.taskId.slice(0, 8)})`)
    for (const m of r.matches) {
      if (m.type === 'title') {
        console.log(`  title: ${m.snippet}`)
      } else {
        if (m.contextBefore != null) console.log(`  L${(m.line ?? 0) - 1}:   ${m.contextBefore}`)
        console.log(`  L${m.line}: > ${m.snippet}`)
        if (m.contextAfter != null) console.log(`  L${(m.line ?? 0) + 1}:   ${m.contextAfter}`)
      }
    }
    console.log('')
  }
  let footer = `Found ${results.length} artifact${results.length === 1 ? '' : 's'} (${totalMatches} match${totalMatches === 1 ? '' : 'es'}). Scanned ${scannedCount} artifact${scannedCount === 1 ? '' : 's'}.`
  if (truncated) footer += ' (limit reached; increase --limit for more)'
  console.log(footer)
}

function printSearchResultsJson(results: SearchResult[]): void {
  console.log(JSON.stringify(results, null, 2))
}

export function artifactsSubcommand(): Command {
  // Deprecated alias: `slay tasks assets` still works for one release.
  if (process.argv[3] === 'assets') {
    console.error('[deprecated] `slay tasks assets` is deprecated. Use `slay tasks artifacts`. Will be removed next release.')
  }

  const cmd = new Command('artifacts')
    .alias('assets')
    .description('Manage task artifacts')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // slay tasks artifacts list <taskId>
  cmd
    .command('list <taskId>')
    .description('List artifacts for a task')
    .option('--json', 'Output as JSON')
    .option('--tree', 'Show as indented tree')
    .action(async (taskId: string, opts) => {
      const db = openDb()
      const task = resolveTaskForArtifact(db, taskId)
      const rows = db.query<ArtifactRow>(
        `SELECT * FROM task_artifacts WHERE task_id = :taskId ORDER BY "order" ASC, created_at ASC`,
        { ':taskId': task.id }
      )
      const folderRows = db.query<ArtifactFolderRow>(
        `SELECT * FROM artifact_folders WHERE task_id = :taskId ORDER BY "order" ASC, created_at ASC`,
        { ':taskId': task.id }
      )
      db.close()
      if (opts.json) {
        console.log(JSON.stringify({ folders: folderRows, artifacts: rows }, null, 2))
      } else if (opts.tree) {
        printArtifactTree(rows, folderRows)
      } else {
        printArtifacts(rows, folderRows)
      }
    })

  // slay tasks artifacts read <artifactId>
  cmd
    .command('read <artifactId>')
    .description('Output artifact content to stdout')
    .action(async (artifactId: string) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)
      db.close()
      const dir = getArtifactsDir()
      const fp = artifactFilePath(dir, artifact.task_id, artifact.id, artifact.title)
      if (!fs.existsSync(fp)) return
      const mode = getEffectiveRenderMode(artifact.title, artifact.render_mode as RenderMode | null)
      if (isBinaryRenderMode(mode)) {
        process.stdout.write(fs.readFileSync(fp))
      } else {
        process.stdout.write(fs.readFileSync(fp, 'utf-8'))
      }
    })

  // slay tasks artifacts search <query>
  cmd
    .command('search <query>')
    .description('Search artifact titles and contents')
    .option('--task <id>', 'Task ID (or $SLAYZONE_TASK_ID)')
    .option('--all-tasks', 'Search across every task (overrides --task / env)')
    .option('--folder <id>', 'Filter by folder (requires --task)')
    .option('--titles-only', 'Match titles only, skip content scan')
    .option('--content-only', 'Match content only, skip title scan')
    .option('--regex', 'Treat <query> as a JS RegExp')
    .option('--case-sensitive', 'Case-sensitive match (default: insensitive)')
    .option('--limit <n>', 'Max artifacts in result', '50')
    .option('--max-matches <n>', 'Max content matches per artifact', '20')
    .option('--json', 'Output as JSON')
    .action(async (query: string, opts) => {
      if (!query.trim()) {
        console.error('Provide a non-empty query.')
        process.exit(1)
      }
      if (opts.titlesOnly && opts.contentOnly) {
        console.error('--titles-only and --content-only are mutually exclusive.')
        process.exit(1)
      }
      if (opts.allTasks && (opts.task || opts.folder)) {
        console.error('--all-tasks cannot combine with --task or --folder.')
        process.exit(1)
      }

      const matcher = compileMatcher(query, opts)

      const db = openDb()
      let scopeTaskId: string | null = null
      if (!opts.allTasks) {
        const ref = opts.task ?? process.env.SLAYZONE_TASK_ID
        if (!ref) {
          console.error('Provide --task, set $SLAYZONE_TASK_ID, or pass --all-tasks.')
          process.exit(1)
        }
        scopeTaskId = resolveTaskForArtifact(db, ref).id
      }
      const folderId = opts.folder ? resolveFolder(db, opts.folder).id : null

      const sqlParts = ['SELECT * FROM task_artifacts WHERE 1=1']
      const params: Record<string, string> = {}
      if (scopeTaskId) {
        sqlParts.push('AND task_id = :tid')
        params[':tid'] = scopeTaskId
      }
      if (folderId) {
        sqlParts.push('AND folder_id = :fid')
        params[':fid'] = folderId
      }
      sqlParts.push('ORDER BY updated_at DESC')
      const artifacts = db.query<ArtifactRow>(sqlParts.join(' '), params)
      const raw = db.raw()
      const blobStore = new BlobStore(getDataDir())

      const limit = parseInt(opts.limit ?? '50', 10)
      const maxMatches = parseInt(opts.maxMatches ?? '20', 10)
      const results: SearchResult[] = []
      let truncated = false

      for (const a of artifacts) {
        const matches: SearchMatch[] = []
        if (!opts.contentOnly && matcher.test(a.title)) {
          matches.push({ type: 'title', snippet: sanitizeSnippet(a.title) })
        }
        if (!opts.titlesOnly) {
          const mode = getEffectiveRenderMode(a.title, a.render_mode as RenderMode | null)
          if (!isBinaryRenderMode(mode)) {
            const content = loadArtifactContent(raw, blobStore, a.id, a.title)
            if (content != null) {
              matches.push(...scanContentForMatches(content, matcher, maxMatches))
            }
          }
        }
        if (matches.length > 0) {
          results.push({ artifactId: a.id, taskId: a.task_id, title: a.title, matches })
          if (results.length >= limit) {
            truncated = artifacts.length > results.length
            break
          }
        }
      }

      db.close()

      if (opts.json) {
        printSearchResultsJson(results)
      } else {
        printSearchResultsHuman(results, artifacts.length, truncated)
      }
    })

  // slay tasks artifacts create <title>
  cmd
    .command('create <title>')
    .description('Create a new artifact')
    .option('--task <id>', 'Task ID (or $SLAYZONE_TASK_ID)')
    .option('--folder <id>', 'Folder ID to create artifact in')
    .option('--copy-from <path>', 'Copy content from file')
    .option('--render-mode <mode>', 'Override render mode')
    .option('--json', 'Output as JSON')
    .action(async (title: string, opts) => {
      const db = openDb()
      const task = resolveTaskForArtifact(db, opts.task)
      const folderId = opts.folder ? resolveFolder(db, opts.folder).id : null
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const maxOrder = db.query<{ m: number | null }>(
        folderId
          ? `SELECT MAX("order") as m FROM task_artifacts WHERE task_id = :taskId AND folder_id = :folderId`
          : `SELECT MAX("order") as m FROM task_artifacts WHERE task_id = :taskId AND folder_id IS NULL`,
        folderId ? { ':taskId': task.id, ':folderId': folderId } : { ':taskId': task.id }
      )[0]?.m ?? -1

      db.run(
        `INSERT INTO task_artifacts (id, task_id, folder_id, title, render_mode, "order", created_at, updated_at)
         VALUES (:id, :taskId, :folderId, :title, :renderMode, :order, :now, :now)`,
        {
          ':id': id,
          ':taskId': task.id,
          ':folderId': folderId,
          ':title': title,
          ':renderMode': opts.renderMode ?? null,
          ':order': maxOrder + 1,
          ':now': now,
        }
      )

      const dir = getArtifactsDir()
      const fp = artifactFilePath(dir, task.id, id, title)
      fs.mkdirSync(path.dirname(fp), { recursive: true })

      let bytes: Buffer
      if (opts.copyFrom) {
        if (!fs.existsSync(opts.copyFrom)) {
          console.error(`File not found: ${opts.copyFrom}`)
          process.exit(1)
        }
        bytes = fs.readFileSync(opts.copyFrom)
        fs.writeFileSync(fp, bytes)
      } else {
        const content = await readStdin()
        bytes = Buffer.from(content)
        fs.writeFileSync(fp, bytes)
      }

      // Create v1 version row.
      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      createVersion(raw, nodeSqliteTxn(raw), blobStore, {
        artifactId: id,
        bytes,
        author: cliAuthor(),
      })

      db.close()
      await notifyApp()
      const openPort = getMcpPort()
      if (openPort) await postJson(openPort, `/api/open-artifact/${id}`)

      if (opts.json) {
        console.log(JSON.stringify({ id, task_id: task.id, title, render_mode: opts.renderMode ?? null, order: maxOrder + 1, created_at: now, updated_at: now }, null, 2))
      } else {
        console.log(`Created: ${id.slice(0, 8)}  ${title}`)
      }
    })

  // slay tasks artifacts upload <sourcePath>
  cmd
    .command('upload <sourcePath>')
    .description('Upload a file as an artifact')
    .option('--task <id>', 'Task ID (or $SLAYZONE_TASK_ID)')
    .option('--title <name>', 'Artifact title (defaults to filename)')
    .option('--json', 'Output as JSON')
    .action(async (sourcePath: string, opts) => {
      if (!fs.existsSync(sourcePath)) {
        console.error(`File not found: ${sourcePath}`)
        process.exit(1)
      }
      const db = openDb()
      const task = resolveTaskForArtifact(db, opts.task)
      const id = crypto.randomUUID()
      const title = opts.title ?? path.basename(sourcePath)
      const now = new Date().toISOString()
      const maxOrder = db.query<{ m: number | null }>(
        `SELECT MAX("order") as m FROM task_artifacts WHERE task_id = :taskId`,
        { ':taskId': task.id }
      )[0]?.m ?? -1

      db.run(
        `INSERT INTO task_artifacts (id, task_id, title, "order", created_at, updated_at)
         VALUES (:id, :taskId, :title, :order, :now, :now)`,
        { ':id': id, ':taskId': task.id, ':title': title, ':order': maxOrder + 1, ':now': now }
      )

      const dir = getArtifactsDir()
      const fp = artifactFilePath(dir, task.id, id, title)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.copyFileSync(sourcePath, fp)

      // Seed v1 version row from uploaded bytes.
      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      createVersion(raw, nodeSqliteTxn(raw), blobStore, {
        artifactId: id,
        bytes: fs.readFileSync(fp),
        author: cliAuthor(),
      })

      db.close()
      await notifyApp()
      const openPort = getMcpPort()
      if (openPort) await postJson(openPort, `/api/open-artifact/${id}`)

      if (opts.json) {
        console.log(JSON.stringify({ id, task_id: task.id, title, order: maxOrder + 1, created_at: now, updated_at: now }, null, 2))
      } else {
        console.log(`Uploaded: ${id.slice(0, 8)}  ${title}`)
      }
    })

  // slay tasks artifacts update <artifactId>
  cmd
    .command('update <artifactId>')
    .description('Update artifact metadata')
    .option('--title <name>', 'New title')
    .option('--render-mode <mode>', 'New render mode')
    .option('--json', 'Output as JSON')
    .action(async (artifactId: string, opts) => {
      if (!opts.title && !opts.renderMode) {
        console.error('Provide at least one of --title, --render-mode.')
        process.exit(1)
      }
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)

      const sets: string[] = []
      const params: Record<string, string | number | bigint | null | Uint8Array> = { ':id': artifact.id }

      if (opts.title !== undefined) {
        sets.push('title = :title')
        params[':title'] = opts.title
      }
      if (opts.renderMode !== undefined) {
        sets.push('render_mode = :renderMode')
        params[':renderMode'] = opts.renderMode
      }
      sets.push("updated_at = :now")
      params[':now'] = new Date().toISOString()

      db.run(`UPDATE task_artifacts SET ${sets.join(', ')} WHERE id = :id`, params)

      // Rename file on disk if extension changed
      if (opts.title) {
        const dir = getArtifactsDir()
        const oldExt = getExtensionFromTitle(artifact.title) || '.txt'
        const newExt = getExtensionFromTitle(opts.title) || '.txt'
        if (oldExt !== newExt) {
          const oldPath = path.join(dir, artifact.task_id, `${artifact.id}${oldExt}`)
          const newPath = path.join(dir, artifact.task_id, `${artifact.id}${newExt}`)
          if (fs.existsSync(oldPath)) {
            const content = fs.readFileSync(oldPath)
            fs.writeFileSync(newPath, content)
            fs.unlinkSync(oldPath)
          }
        }
      }

      db.close()
      await notifyApp()

      const newTitle = opts.title ?? artifact.title
      if (opts.json) {
        const updated = { ...artifact, title: newTitle, render_mode: opts.renderMode ?? artifact.render_mode, updated_at: params[':now'] }
        console.log(JSON.stringify(updated, null, 2))
      } else {
        console.log(`Updated: ${artifact.id.slice(0, 8)}  ${newTitle}`)
      }
    })

  // slay tasks artifacts write <artifactId>
  cmd
    .command('write <artifactId>')
    .description('Replace artifact content from stdin')
    .option('--mutate-version [ref]', 'Bare: autosave to current (auto-branches if locked). With ref: bypass lock and mutate the target version in place')
    .action(async (artifactId: string, opts: { mutateVersion?: boolean | string }) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)

      const content = await readStdin()
      const bytes = Buffer.from(content)

      const dir = getArtifactsDir()
      const fp = artifactFilePath(dir, artifact.task_id, artifact.id, artifact.title)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.writeFileSync(fp, bytes)

      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      const txn = nodeSqliteTxn(raw)
      try {
        const v = typeof opts.mutateVersion === 'string'
          ? mutateVersion(raw, txn, blobStore, { artifactId: artifact.id, ref: opts.mutateVersion, bytes, author: cliAuthor() })
          : opts.mutateVersion === true
            ? saveCurrent(raw, txn, blobStore, { artifactId: artifact.id, bytes, author: cliAuthor() })
            : createVersion(raw, txn, blobStore, { artifactId: artifact.id, bytes, author: cliAuthor() })
        db.run(`UPDATE task_artifacts SET updated_at = :now WHERE id = :id`, {
          ':id': artifact.id,
          ':now': new Date().toISOString(),
        })
        db.close()
        await notifyApp()
        console.log(`Written: ${artifact.id.slice(0, 8)}  ${artifact.title}  v${v.version_num}`)
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  // slay tasks artifacts append <artifactId>
  cmd
    .command('append <artifactId>')
    .description('Append to artifact content from stdin')
    .option('--mutate-version [ref]', 'Bare: autosave to current (auto-branches if locked). With ref: bypass lock and mutate the target version in place')
    .action(async (artifactId: string, opts: { mutateVersion?: boolean | string }) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)

      const content = await readStdin()

      const dir = getArtifactsDir()
      const fp = artifactFilePath(dir, artifact.task_id, artifact.id, artifact.title)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.appendFileSync(fp, content)
      const fullBytes = fs.readFileSync(fp)

      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      const txn = nodeSqliteTxn(raw)
      try {
        const v = typeof opts.mutateVersion === 'string'
          ? mutateVersion(raw, txn, blobStore, { artifactId: artifact.id, ref: opts.mutateVersion, bytes: fullBytes, author: cliAuthor() })
          : opts.mutateVersion === true
            ? saveCurrent(raw, txn, blobStore, { artifactId: artifact.id, bytes: fullBytes, author: cliAuthor() })
            : createVersion(raw, txn, blobStore, { artifactId: artifact.id, bytes: fullBytes, author: cliAuthor() })
        db.run(`UPDATE task_artifacts SET updated_at = :now WHERE id = :id`, {
          ':id': artifact.id,
          ':now': new Date().toISOString(),
        })
        db.close()
        await notifyApp()
        console.log(`Appended: ${artifact.id.slice(0, 8)}  ${artifact.title}  v${v.version_num}`)
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  // slay tasks artifacts delete <artifactId>
  cmd
    .command('delete <artifactId>')
    .description('Delete an artifact')
    .action(async (artifactId: string) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)

      const dir = getArtifactsDir()
      const fp = artifactFilePath(dir, artifact.task_id, artifact.id, artifact.title)
      if (fs.existsSync(fp)) fs.unlinkSync(fp)

      db.run(`DELETE FROM task_artifacts WHERE id = :id`, { ':id': artifact.id })
      db.close()
      await notifyApp()
      console.log(`Deleted: ${artifact.id.slice(0, 8)}  ${artifact.title}`)
    })

  // slay tasks artifacts path <artifactId>
  cmd
    .command('path <artifactId>')
    .description('Print artifact file path')
    .action(async (artifactId: string) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)
      db.close()
      const dir = getArtifactsDir()
      process.stdout.write(artifactFilePath(dir, artifact.task_id, artifact.id, artifact.title))
    })

  // slay tasks artifacts mkdir <name>
  cmd
    .command('mkdir <name>')
    .description('Create a folder')
    .option('--task <id>', 'Task ID (or $SLAYZONE_TASK_ID)')
    .option('--parent <id>', 'Parent folder ID')
    .option('--json', 'Output as JSON')
    .action(async (name: string, opts) => {
      const db = openDb()
      const task = resolveTaskForArtifact(db, opts.task)
      const parentId = opts.parent ? resolveFolder(db, opts.parent).id : null
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const maxOrder = db.query<{ m: number | null }>(
        parentId
          ? `SELECT MAX("order") as m FROM artifact_folders WHERE task_id = :taskId AND parent_id = :parentId`
          : `SELECT MAX("order") as m FROM artifact_folders WHERE task_id = :taskId AND parent_id IS NULL`,
        parentId ? { ':taskId': task.id, ':parentId': parentId } : { ':taskId': task.id }
      )[0]?.m ?? -1

      db.run(
        `INSERT INTO artifact_folders (id, task_id, parent_id, name, "order", created_at)
         VALUES (:id, :taskId, :parentId, :name, :order, :now)`,
        { ':id': id, ':taskId': task.id, ':parentId': parentId, ':name': name, ':order': maxOrder + 1, ':now': now }
      )
      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ id, task_id: task.id, parent_id: parentId, name, order: maxOrder + 1, created_at: now }, null, 2))
      } else {
        console.log(`Created folder: ${id.slice(0, 8)}  ${name}`)
      }
    })

  // slay tasks artifacts rmdir <folderId>
  cmd
    .command('rmdir <folderId>')
    .description('Delete a folder (artifacts move to root)')
    .option('--json', 'Output as JSON')
    .action(async (folderId: string, opts) => {
      const db = openDb()
      const folder = resolveFolder(db, folderId)
      db.run(`DELETE FROM artifact_folders WHERE id = :id`, { ':id': folder.id })
      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ deleted: folder.id, name: folder.name }))
      } else {
        console.log(`Deleted folder: ${folder.id.slice(0, 8)}  ${folder.name}`)
      }
    })

  // slay tasks artifacts mvdir <folderId>
  cmd
    .command('mvdir <folderId>')
    .description('Move a folder to another parent (or root)')
    .requiredOption('--parent <id>', 'Target parent folder ID, or "root" for top level')
    .option('--json', 'Output as JSON')
    .action(async (folderId: string, opts) => {
      const db = openDb()
      const folder = resolveFolder(db, folderId)
      let targetParentId: string | null = null
      let targetName = 'root'
      if (opts.parent !== 'root') {
        const parent = resolveFolder(db, opts.parent)
        targetParentId = parent.id
        targetName = parent.name
        // cycle check: walk ancestors of target — reject if source appears
        let cur: string | null = targetParentId
        while (cur) {
          if (cur === folder.id) {
            console.error('Cannot move folder into its own descendant')
            process.exit(1)
          }
          const row: { parent_id: string | null } | undefined = db.query<{ parent_id: string | null }>(
            `SELECT parent_id FROM artifact_folders WHERE id = :id`,
            { ':id': cur }
          )[0]
          cur = row?.parent_id ?? null
        }
      }
      db.run(
        `UPDATE artifact_folders SET parent_id = :parentId WHERE id = :id`,
        { ':parentId': targetParentId, ':id': folder.id }
      )
      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ id: folder.id, parent_id: targetParentId }))
      } else {
        console.log(`Moved folder: ${folder.id.slice(0, 8)} -> ${targetName}`)
      }
    })

  // slay tasks artifacts mv <artifactId>
  cmd
    .command('mv <artifactId>')
    .description('Move artifact to a folder (or root)')
    .requiredOption('--folder <id>', 'Target folder ID, or "root" for top level')
    .option('--json', 'Output as JSON')
    .action(async (artifactId: string, opts) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)
      let targetFolderId: string | null = null
      let targetName = 'root'
      if (opts.folder !== 'root') {
        const folder = resolveFolder(db, opts.folder)
        targetFolderId = folder.id
        targetName = folder.name
      }
      db.run(
        `UPDATE task_artifacts SET folder_id = :folderId, updated_at = :now WHERE id = :id`,
        { ':folderId': targetFolderId, ':now': new Date().toISOString(), ':id': artifact.id }
      )
      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ id: artifact.id, folder_id: targetFolderId }))
      } else {
        console.log(`Moved: ${artifact.id.slice(0, 8)} -> ${targetName}`)
      }
    })

  // slay tasks artifacts download [artifactId]
  cmd
    .command('download [artifactId]')
    .description('Download an artifact in a given format')
    .option('--type <type>', 'Export type: raw, pdf, png, html, zip', 'raw')
    .option('--output <path>', 'Output file path (default: ./<filename>)')
    .option('--task <id>', 'Task ID for zip (or $SLAYZONE_TASK_ID)')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Download Types by Render Mode:
  raw   — always available (copies original file)
  pdf   — markdown, code, html, svg, mermaid
  png   — svg, mermaid
  html  — markdown, code, mermaid
  zip   — all artifacts in task (no artifactId needed)

pdf/png/html require the SlayZone app to be running.
`)
    .action(async (artifactId: string | undefined, opts) => {
      const validTypes = ['raw', 'pdf', 'png', 'html', 'zip']
      if (!validTypes.includes(opts.type)) {
        console.error(`Invalid type "${opts.type}". Valid types: ${validTypes.join(', ')}`)
        process.exit(1)
      }

      // --- ZIP: task-level ---
      if (opts.type === 'zip') {
        const db = openDb()
        const task = resolveTaskForArtifact(db, opts.task)
        const artifacts = db.query<ArtifactRow>(
          `SELECT * FROM task_artifacts WHERE task_id = :taskId ORDER BY "order" ASC`,
          { ':taskId': task.id }
        )
        const folders = db.query<ArtifactFolderRow>(
          `SELECT * FROM artifact_folders WHERE task_id = :taskId`,
          { ':taskId': task.id }
        )
        db.close()

        if (artifacts.length === 0) {
          console.error('No artifacts to download.')
          process.exit(1)
        }

        const dir = getArtifactsDir()
        const outputPath = opts.output ? path.resolve(opts.output) : path.resolve('artifacts.zip')
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })

        const byId = new Map(folders.map(f => [f.id, f]))
        function folderPath(id: string): string {
          const f = byId.get(id)
          if (!f) return ''
          return f.parent_id ? path.join(folderPath(f.parent_id), f.name) : f.name
        }

        const output = fs.createWriteStream(outputPath)
        const archive = archiver('zip', { zlib: { level: 9 } })
        archive.pipe(output)

        for (const artifact of artifacts) {
          const fp = artifactFilePath(dir, artifact.task_id, artifact.id, artifact.title)
          if (!fs.existsSync(fp)) continue
          const rel = artifact.folder_id
            ? path.join(folderPath(artifact.folder_id), artifact.title)
            : artifact.title
          archive.file(fp, { name: rel })
        }

        await archive.finalize()
        await new Promise<void>((resolve, reject) => {
          output.on('close', resolve)
          output.on('error', reject)
        })

        if (opts.json) {
          console.log(JSON.stringify({ path: outputPath, type: 'zip', taskId: task.id }))
        } else {
          console.log(outputPath)
        }
        return
      }

      // --- Non-zip: artifactId required ---
      if (!artifactId) {
        console.error(`Artifact ID required for --type ${opts.type}. Use --type zip for task-level download.`)
        process.exit(1)
      }

      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)
      db.close()

      const mode = getEffectiveRenderMode(artifact.title, artifact.render_mode as RenderMode | null)
      const baseName = artifact.title.replace(/\.[^.]+$/, '') || artifact.title

      // --- RAW ---
      if (opts.type === 'raw') {
        const dir = getArtifactsDir()
        const srcPath = artifactFilePath(dir, artifact.task_id, artifact.id, artifact.title)
        if (!fs.existsSync(srcPath)) {
          console.error('Artifact file not found on disk.')
          process.exit(1)
        }
        const outputPath = opts.output ? path.resolve(opts.output) : path.resolve(artifact.title)
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })
        fs.copyFileSync(srcPath, outputPath)

        if (opts.json) {
          console.log(JSON.stringify({ path: outputPath, type: 'raw', artifactId: artifact.id }))
        } else {
          console.log(outputPath)
        }
        return
      }

      // --- PDF / PNG / HTML (requires app) ---
      const available = getAvailableExportTypes(mode)
      if (!available.includes(opts.type)) {
        console.error(`Cannot export "${artifact.title}" (${mode}) as ${opts.type}.\nAvailable types for ${mode}: ${available.join(', ')}`)
        process.exit(1)
      }

      const ext = opts.type
      const outputPath = opts.output ? path.resolve(opts.output) : path.resolve(`${baseName}.${ext}`)
      await apiPost(`/api/artifacts/${artifact.id}/export/${opts.type}`, { outputPath })

      if (opts.json) {
        console.log(JSON.stringify({ path: outputPath, type: opts.type, artifactId: artifact.id }))
      } else {
        console.log(outputPath)
      }
    })

  // --- Versions subcommand ---
  const versions = new Command('versions').description('Manage artifact version history')

  versions
    .command('list <artifactId>')
    .description('List version history for an artifact (newest first)')
    .option('--limit <n>', 'Max rows', (v) => parseInt(v, 10), 50)
    .option('--offset <n>', 'Skip N rows', (v) => parseInt(v, 10), 0)
    .option('--json', 'Output as JSON')
    .action(async (artifactId: string, opts: { limit: number; offset: number; json?: boolean }) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)
      const blobStore = new BlobStore(getDataDir())
      void blobStore
      const raw = db.raw()
      const rows = listVersions(raw, artifact.id, { limit: opts.limit, offset: opts.offset })
      db.close()
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }
      if (rows.length === 0) {
        console.log('(no versions)')
        return
      }
      console.log(`VER  HASH       SIZE   NAME              AUTHOR            CREATED`)
      console.log(`---  ---------  -----  ----------------  ----------------  ----------------`)
      for (const v of rows) {
        const hash = v.content_hash.slice(0, 8)
        const name = (v.name ?? '').padEnd(16).slice(0, 16)
        const author = ((v.author_id ?? v.author_type ?? '') as string).padEnd(16).slice(0, 16)
        console.log(`v${String(v.version_num).padEnd(3)} ${hash}  ${String(v.size).padStart(5)}  ${name}  ${author}  ${v.created_at}`)
      }
    })

  versions
    .command('read <artifactId> <version>')
    .description('Print content of a specific version (int, hash prefix, name, -N, HEAD~N)')
    .action(async (artifactId: string, versionRef: string) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)
      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      try {
        const v = resolveVersionRef(raw, artifact.id, versionRef)
        const buf = readVersionContent(blobStore, v)
        db.close()
        process.stdout.write(buf)
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  versions
    .command('diff <artifactId> <a> [b]')
    .description('Diff two versions (b defaults to latest). Colorized unless --no-color.')
    .option('--no-color', 'Plain output')
    .option('--json', 'Output as JSON')
    .action(async (artifactId: string, a: string, b: string | undefined, opts: { color: boolean; json?: boolean }) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)
      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      try {
        const result = diffVersions(raw, blobStore, { artifactId: artifact.id, a, b })
        db.close()
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }
        if (result.kind === 'binary') {
          console.log(`(binary)`)
          console.log(`  a: ${result.a.hash.slice(0, 8)}  ${result.a.size} bytes`)
          console.log(`  b: ${result.b.hash.slice(0, 8)}  ${result.b.size} bytes`)
          return
        }
        const useColor = opts.color !== false && process.stdout.isTTY
        const RED = useColor ? '\x1b[31m' : ''
        const GREEN = useColor ? '\x1b[32m' : ''
        const RESET = useColor ? '\x1b[0m' : ''
        for (const hunk of result.hunks) {
          for (const line of hunk.lines) {
            if (line.kind === 'add') process.stdout.write(`${GREEN}+${line.text}${RESET}\n`)
            else if (line.kind === 'del') process.stdout.write(`${RED}-${line.text}${RESET}\n`)
            else process.stdout.write(` ${line.text}\n`)
          }
        }
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  versions
    .command('set-current <artifactId> <version>')
    .description('Set the current (HEAD) version. Next UI save branches from here if the target is locked.')
    .option('--json', 'Output as JSON')
    .action(async (artifactId: string, version: string, opts: { json?: boolean }) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)
      const raw = db.raw()
      const txn = nodeSqliteTxn(raw)
      try {
        const v = setCurrentVersion(raw, txn, artifact.id, version)
        const blobStore = new BlobStore(getDataDir())
        // Flush the selected version's bytes to disk so editors pick up on next read.
        const bytes = readVersionContent(blobStore, v)
        const dir = getArtifactsDir()
        const fp = artifactFilePath(dir, artifact.task_id, artifact.id, artifact.title)
        fs.mkdirSync(path.dirname(fp), { recursive: true })
        fs.writeFileSync(fp, bytes)
        db.close()
        await notifyApp()
        if (opts.json) {
          console.log(JSON.stringify(v, null, 2))
        } else {
          console.log(`Current: v${v.version_num}${v.name ? ` (${v.name})` : ''}  ${v.content_hash.slice(0, 8)}`)
        }
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  versions
    .command('current <artifactId>')
    .description('Print the current (HEAD) version')
    .option('--json', 'Output as JSON')
    .action((artifactId: string, opts: { json?: boolean }) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)
      const raw = db.raw()
      const v = getCurrentVersion(raw, artifact.id)
      db.close()
      if (!v) {
        console.error('No versions for this artifact')
        process.exit(1)
      }
      if (opts.json) {
        console.log(JSON.stringify(v, null, 2))
      } else {
        console.log(`v${v.version_num}${v.name ? ` (${v.name})` : ''}  ${v.content_hash.slice(0, 8)}`)
      }
    })

  versions
    .command('create <artifactId>')
    .description('Create a version from the current working copy (honors unchanged content)')
    .option('--name <name>', 'Optional name for the version')
    .option('--json', 'Output as JSON')
    .action(async (artifactId: string, opts: { name?: string; json?: boolean }) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)
      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      const txn = nodeSqliteTxn(raw)
      try {
        const dir = getArtifactsDir()
        const fp = artifactFilePath(dir, artifact.task_id, artifact.id, artifact.title)
        const bytes = fs.existsSync(fp) ? fs.readFileSync(fp) : Buffer.alloc(0)
        const v = createVersion(raw, txn, blobStore, {
          artifactId: artifact.id,
          bytes,
          name: opts.name ?? null,
          honorUnchanged: true,
          author: cliAuthor(),
        })
        db.close()
        if (opts.json) {
          console.log(JSON.stringify(v, null, 2))
        } else {
          console.log(`Created: v${v.version_num}${v.name ? ` (${v.name})` : ''}`)
        }
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  versions
    .command('rename <artifactId> <version> [newName]')
    .description('Set, change, or clear (omit newName) the name of a version')
    .option('--clear', 'Clear the name')
    .option('--json', 'Output as JSON')
    .action(async (artifactId: string, versionRef: string, newName: string | undefined, opts: { clear?: boolean; json?: boolean }) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)
      const raw = db.raw()
      const txn = nodeSqliteTxn(raw)
      try {
        const target = opts.clear ? null : (newName ?? null)
        const v = renameVersion(raw, txn, artifact.id, versionRef, target)
        db.close()
        if (opts.json) {
          console.log(JSON.stringify(v, null, 2))
        } else {
          console.log(`Renamed v${v.version_num}: ${target ?? '(no name)'}`)
        }
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  versions
    .command('prune <artifactId>')
    .description('Remove old versions. Named and current versions protected by default.')
    .option('--keep-last <n>', 'Keep the N most recent versions', (v) => parseInt(v, 10), 0)
    .option('--no-keep-named', 'Also delete named versions')
    .option('--no-keep-current', 'Allow deleting the current (HEAD) version')
    .option('--dry-run', 'Show what would be deleted without modifying')
    .option('--json', 'Output as JSON')
    .action(async (artifactId: string, opts: { keepLast: number; keepNamed: boolean; keepCurrent: boolean; dryRun?: boolean; json?: boolean }) => {
      const db = openDb()
      const artifact = resolveArtifact(db, artifactId)
      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      const txn = nodeSqliteTxn(raw)
      try {
        const report = pruneVersions(raw, txn, blobStore, artifact.id, {
          keepLast: opts.keepLast,
          keepNamed: opts.keepNamed,
          keepCurrent: opts.keepCurrent,
          dryRun: opts.dryRun,
        })
        db.close()
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2))
        } else {
          const verb = opts.dryRun ? 'would delete' : 'deleted'
          console.log(`${verb} ${report.deletedVersions} versions, ${report.deletedBlobs} blobs (kept ${report.keptNamed} named)`)
        }
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  cmd.addCommand(versions)

  return cmd
}
