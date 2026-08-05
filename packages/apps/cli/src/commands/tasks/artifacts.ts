import { Command } from 'commander'
import archiver from 'archiver'
import fs from 'fs'
import path from 'path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as StreamWebReadable } from 'node:stream/web'
import { isCoLocatedHub } from '../../local-hub'
import type { ArtifactVersion, DiffResult, PruneReport } from '@slayzone/task-artifacts/shared'
import {
  getExtensionFromTitle,
  getEffectiveRenderMode,
  canExportAsPdf,
  canExportAsPng,
  canExportAsHtml,
  type RenderMode
} from '@slayzone/task/shared/types'
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  apiFetch,
  apiGetStream,
  apiPostStream,
  apiPutStream
} from '../../api'
import { cliAuthor, resolveId } from './_shared'

/*
 * Hub/runner split (Wave 3.5): the subcommands below route through api.ts — the
 * hub when configured, else the local app's REST — so they work against a hub on
 * another machine, where the SQLite file simply does not exist:
 *   list        → GET    /api/tasks/:id/artifacts
 *   mkdir       → POST   /api/artifact-folders
 *   rmdir       → DELETE /api/artifact-folders/:id
 *   mvdir       → PATCH  /api/artifact-folders/:id
 *   mv / update → PATCH  /api/artifacts/:id
 *   read        → GET    /api/artifacts/:id/content
 *   create      → POST   /api/artifacts?taskId&title[&folderId&renderMode]  (raw body)
 *   upload      → POST   /api/tasks/:id/artifacts?title=                    (raw body)
 *   delete      → DELETE /api/artifacts/:id
 *   download    → GET    /api/artifacts/:id (metadata) + /api/artifacts/:id/content
 *                 POST   /api/artifacts/:id/export/{pdf,png,html}
 *   search      → GET    /api/artifacts/search?q=…
 *   write       → PUT    /api/artifacts/:id/content   (raw body)
 *   append      → POST   /api/artifacts/:id/content   (raw body)
 *   versions list        → GET    /api/artifacts/:id/versions
 *   versions read        → GET    /api/artifacts/:id/versions/content?ref=
 *   versions diff        → GET    /api/artifacts/:id/versions/diff?a=[&b=]
 *   versions current     → GET    /api/artifacts/:id/versions/current
 *   versions set-current → POST   /api/artifacts/:id/versions/current
 *   versions create      → POST   /api/artifacts/:id/versions
 *   versions rename      → PATCH  /api/artifacts/:id/versions
 *   versions prune       → POST   /api/artifacts/:id/versions/prune
 *
 * CONTENT crosses the wire as a STREAM in both directions, never as a JSON
 * string: an artifact can be a PNG or a PDF, and a JS string is utf-8, so any
 * such hop would replace every invalid byte sequence with U+FFFD. See
 * api.ts's apiGetStream / apiPostStream / apiPutStream.
 *
 * VERSION HISTORY is content-addressed and immutable, and nothing about it is
 * re-implemented here: the routes expose the SAME `task-artifacts:*` domain ops
 * the app uses, including the one shared ref resolver (int / hash prefix / name /
 * `-N` / `HEAD~N`) and the lock/branch rules. What stays client-side is
 * PRESENTATION only — the table header, the `Error [CODE]: …` line, and the
 * TTY-gated diff colors (the hub cannot know whether OUR stdout is a terminal).
 *
 * `--mutate-version` is two query params rather than one, because commander's
 * `[ref]` optional argument is "boolean OR string" and a query string cannot
 * express that unambiguously: bare ⇒ `mutateVersion=1` (autosave onto current),
 * with a ref ⇒ `mutateVersionRef=<ref>` (rewrite that version in place).
 *
 * AUTHORSHIP rides the request. `cliAuthor()` reads the CLI's own
 * `SLAYZONE_AGENT_ID`, which the hub cannot see, so a version written from an
 * agent's terminal would otherwise be attributed to "user".
 *
 * `download --type zip` still ASSEMBLES the archive locally (streaming each
 * member's bytes in over the content route) — a hub-side zip endpoint would be a
 * new capability, not a wiring change. `--type pdf|png|html` post to the existing
 * export routes; the CAPABILITY check stays client-side so its wording and its
 * "available types for <mode>" hint survive (an export route only knows its own
 * single type).
 *
 *   path        → GET    /api/artifacts/:id  (reads the `filePath` field)
 *
 * NOTHING in this file opens a database anymore. `path` was the last one: it
 * expanded the id prefix locally and joined a locally-derived artifacts dir, which
 * both required the CLI to know the app's on-disk layout AND silently printed a
 * path from the wrong machine against a remote hub. The hub composes the path now
 * (only it knows its own root) and the CLI refuses to print one when the hub is not
 * co-located.
 */

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

function printArtifacts(artifacts: ArtifactRow[], folders?: ArtifactFolderRow[]) {
  if (artifacts.length === 0) {
    console.log('No artifacts.')
    return
  }
  const folderMap = new Map((folders ?? []).map((f) => [f.id, f.name]))
  const idW = 9
  const titleW = 24
  const modeW = 16
  const folderW = 14
  console.log(
    `${'ID'.padEnd(idW)}  ${'TITLE'.padEnd(titleW)}  ${'FOLDER'.padEnd(folderW)}  ${'MODE'.padEnd(modeW)}  CREATED`
  )
  console.log(
    `${'-'.repeat(idW)}  ${'-'.repeat(titleW)}  ${'-'.repeat(folderW)}  ${'-'.repeat(modeW)}  ${'-'.repeat(20)}`
  )
  for (const a of artifacts) {
    const id = a.id.slice(0, 8).padEnd(idW)
    const title = a.title.slice(0, titleW).padEnd(titleW)
    const folder = (a.folder_id ? (folderMap.get(a.folder_id) ?? '?') : '')
      .slice(0, folderW)
      .padEnd(folderW)
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
  const byId = new Map(folders.map((f) => [f.id, f]))
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

/**
 * The route's `code` for "artifact row exists, its working copy does not". `read`
 * and `download --type zip` both treat that as a non-error (print nothing / skip
 * the member) — behavior they had when they checked `fs.existsSync` themselves.
 */
const ARTIFACT_FILE_MISSING = 'ARTIFACT_FILE_MISSING'

/**
 * stdin as a web stream, for a streamed request body.
 *
 * The TTY guard is the same one the former buffering `readStdin` had: `create`,
 * `write` and `append` all require piped content, and a bare invocation in a
 * terminal would otherwise hang waiting on a keyboard.
 */
function stdinStream(): ReadableStream<Uint8Array> {
  if (process.stdin.isTTY) {
    console.error('No content provided. Pipe content via stdin.')
    process.exit(1)
  }
  return Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
}

/**
 * `--mutate-version` as query params for the content routes.
 *
 * commander gives `[ref]` three values — absent, `true` (bare flag), or a string
 * — and a single query param cannot round-trip that: `mutateVersion=true` is
 * indistinguishable from a version literally NAMED "true". So the two modes are
 * two params, and the route reads them as the distinct operations they are:
 *   bare      → `mutateVersion=1`         autosave onto current (auto-branches if locked)
 *   with ref  → `mutateVersionRef=<ref>`  rewrite that version in place (lock bypass)
 *
 * `authorType`/`authorId` carry `cliAuthor()`, which reads OUR
 * `SLAYZONE_AGENT_ID` — invisible to the hub, so without this every
 * agent-authored version would be recorded as user-authored.
 */
function versionWriteQuery(mutateVersion: boolean | string | undefined): URLSearchParams {
  const query = new URLSearchParams()
  if (typeof mutateVersion === 'string') query.set('mutateVersionRef', mutateVersion)
  else if (mutateVersion === true) query.set('mutateVersion', '1')
  return withAuthorParams(query)
}

/** Add the CLI's author context to a query string (see versionWriteQuery). */
function withAuthorParams(query: URLSearchParams): URLSearchParams {
  const author = cliAuthor()
  if (author.type) query.set('authorType', author.type)
  if (author.id) query.set('authorId', author.id)
  return query
}

/**
 * The CLI's author context as a JSON body fragment (for the versions routes).
 * Same reason as {@link withAuthorParams}, different encoding.
 */
function authorBody(): { authorType?: string; authorId?: string } {
  const author = cliAuthor()
  if (!author.type) return {}
  return { authorType: author.type, ...(author.id ? { authorId: author.id } : {}) }
}

/*
 * Version-operation FAILURES need no per-call handling any more. Each route
 * answers 400 with `error` already formatted as `Error [CODE]: message` — the
 * exact line this file printed from its local `isVersionError(err)` branch — and
 * api.ts's failure path prints `error` verbatim then exits 1. So the wording and
 * the exit code survive without a single try/catch here.
 */

/** A file as a web stream, for a streamed request body (constant memory). */
function fileStream(filePath: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>
}

/**
 * Pipe a response body to stdout.
 *
 * `end: false` keeps the pipeline from closing the shared stdout handle.
 *
 * EPIPE is swallowed: `slay … read <big-artifact> | head` closes the pipe early,
 * which is normal use, not an error — `cat` exits quietly there too. (The old
 * single `process.stdout.write(buffer)` crashed with an unhandled 'error' event
 * and a full stack trace, so this is strictly quieter than before.)
 */
async function streamToStdout(body: ReadableStream<Uint8Array>): Promise<void> {
  try {
    await pipeline(Readable.fromWeb(body as StreamWebReadable), process.stdout, { end: false })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EPIPE') throw err
  }
}

/**
 * Focus the freshly-created artifact in a running app — best-effort, as before.
 *
 * Replaces a direct `postJson(getServerPort(), …)`: that read the port out of the
 * DB, which is exactly what a remote hub cannot offer. `apiFetch` reuses the
 * resolved hub/app target and, unlike `apiPost`, does not exit on a non-2xx — so
 * a host that cannot focus anything still leaves the created artifact alone.
 *
 * No separate `notifyApp()`: the create/upload routes already call
 * `notifyRenderer()` themselves (as does this one), which is why the other
 * converted commands dropped it too.
 */
async function openArtifactInApp(artifactId: string): Promise<void> {
  await apiFetch(`/api/open-artifact/${encodeURIComponent(artifactId)}`, { method: 'POST' })
}

function getAvailableExportTypes(mode: RenderMode): string[] {
  const types = ['raw']
  if (canExportAsPdf(mode)) types.push('pdf')
  if (canExportAsPng(mode)) types.push('png')
  if (canExportAsHtml(mode)) types.push('html')
  return types
}

/**
 * The search RESULT shape, unchanged from when this command scanned sqlite +
 * the blob store itself — `--json` prints this array verbatim, so it is a
 * contract. The scan now happens on the hub (GET /api/artifacts/search), which
 * is the only host that can read the blob store; what stays here is the
 * PRESENTATION of the results.
 */
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

/** What the route reports alongside the results, feeding the human footer. */
interface SearchReport {
  results: SearchResult[]
  scannedCount: number
  truncated: boolean
  skippedLarge: { label: string; size: number }[]
}

function printSearchResultsHuman(
  results: SearchResult[],
  scannedCount: number,
  truncated: boolean
): void {
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
    console.error(
      '[deprecated] `slay tasks assets` is deprecated. Use `slay tasks artifacts`. Will be removed next release.'
    )
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
      // GET /api/tasks/:id/artifacts resolves the task by id prefix and returns
      // both lists ordered by "order", created_at — same rows/shape the direct
      // sqlite read produced (SELECT *), so JSON/tree/table output is unchanged.
      const { data } = await apiGet<{
        ok: true
        data: { folders: ArtifactFolderRow[]; artifacts: ArtifactRow[] }
      }>(`/api/tasks/${encodeURIComponent(taskId)}/artifacts`)
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2))
      } else if (opts.tree) {
        printArtifactTree(data.artifacts, data.folders)
      } else {
        printArtifacts(data.artifacts, data.folders)
      }
    })

  // slay tasks artifacts read <artifactId>
  cmd
    .command('read <artifactId>')
    .description('Output artifact content to stdout')
    .action(async (artifactId: string) => {
      // GET /api/artifacts/:id/content resolves the id prefix and streams the
      // working-copy file. Bytes go to stdout through a pipeline — never through
      // a string — so an image/pdf artifact is emitted byte-exact, exactly as the
      // old `readFileSync(fp)` branch did. (The former utf-8 branch for text was
      // a no-op round-trip: writing a decoded string re-encodes to the same bytes.)
      //
      // ARTIFACT_FILE_MISSING is passed through rather than treated as an error:
      // a row whose working copy is absent has always printed NOTHING and exited
      // 0 here (the old `if (!fs.existsSync(fp)) return`).
      const { body } = await apiGetStream(
        `/api/artifacts/${encodeURIComponent(artifactId)}/content`,
        [ARTIFACT_FILE_MISSING]
      )
      if (!body) return
      await streamToStdout(body)
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

      // GET /api/artifacts/search runs the whole scan on the host that owns the
      // blob store — titles AND every in-scope artifact's current-version
      // content, with the same matcher/snippet/limit semantics (the code moved
      // to @slayzone/task-artifacts verbatim). The three contradiction checks
      // above stay here so they still fail BEFORE any request, and the route
      // re-asserts them with identical wording for direct callers.
      const query$ = new URLSearchParams({ q: query })
      if (opts.allTasks) {
        query$.set('allTasks', '1')
      } else {
        query$.set('taskId', await resolveId(opts.task))
      }
      if (opts.folder) query$.set('folderId', opts.folder)
      if (opts.titlesOnly) query$.set('titlesOnly', '1')
      if (opts.contentOnly) query$.set('contentOnly', '1')
      if (opts.regex) query$.set('regex', '1')
      if (opts.caseSensitive) query$.set('caseSensitive', '1')
      query$.set('limit', opts.limit ?? '50')
      query$.set('maxMatches', opts.maxMatches ?? '20')

      const { data } = await apiGet<{ ok: true; data: SearchReport }>(
        `/api/artifacts/search?${query$}`
      )

      // The oversized-artifact notice stayed on stderr, interleaved with results
      // before; it is now emitted up front (the whole scan finished server-side).
      for (const skipped of data.skippedLarge) {
        process.stderr.write(
          `[skipped large artifact] ${skipped.label} (${(skipped.size / 1_000_000).toFixed(1)}MB)\n`
        )
      }

      if (opts.json) {
        printSearchResultsJson(data.results)
      } else {
        printSearchResultsHuman(data.results, data.scannedCount, data.truncated)
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
      // POST /api/artifacts with a RAW body: the artifact's bytes ARE the request
      // body (streamed, constant memory), and taskId/title/folderId/renderMode
      // ride the query string — see api.ts apiPostStream for why bytes must never
      // become a JSON string. The route resolves task + folder by id prefix,
      // allocates the folder-scoped "order", writes the file and seeds v1 through
      // the shared artifact store, then pings the renderer.
      //
      // `--copy-from` still short-circuits on a missing file BEFORE any request,
      // so its wording/exit code are unchanged; without it, stdin is required and
      // is now piped straight through rather than buffered.
      const taskRef = await resolveId(opts.task)
      const query = new URLSearchParams({ taskId: taskRef, title })
      if (opts.folder) query.set('folderId', opts.folder)
      if (opts.renderMode) query.set('renderMode', opts.renderMode)

      let source: ReadableStream<Uint8Array>
      if (opts.copyFrom) {
        if (!fs.existsSync(opts.copyFrom)) {
          console.error(`File not found: ${opts.copyFrom}`)
          process.exit(1)
        }
        source = fileStream(opts.copyFrom)
      } else {
        source = stdinStream()
      }

      const { data: artifact } = await apiPostStream<{ ok: true; data: ArtifactRow }>(
        `/api/artifacts?${query}`,
        source
      )
      await openArtifactInApp(artifact.id)

      if (opts.json) {
        console.log(JSON.stringify(artifact, null, 2))
      } else {
        console.log(`Created: ${artifact.id.slice(0, 8)}  ${artifact.title}`)
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
      // POST /api/tasks/:id/artifacts?title= streams the file as the request body
      // (constant memory) into the shared store's upload op — the same op behind
      // the app's own upload flow, so the row/file/v1-seed are identical. The
      // task-wide "order" allocation matches what this command always did.
      if (!fs.existsSync(sourcePath)) {
        console.error(`File not found: ${sourcePath}`)
        process.exit(1)
      }
      const taskRef = await resolveId(opts.task)
      const title = opts.title ?? path.basename(sourcePath)
      const { data: artifact } = await apiPostStream<{ ok: true; data: ArtifactRow }>(
        `/api/tasks/${encodeURIComponent(taskRef)}/artifacts?title=${encodeURIComponent(title)}`,
        fileStream(sourcePath)
      )
      await openArtifactInApp(artifact.id)

      if (opts.json) {
        console.log(JSON.stringify(artifact, null, 2))
      } else {
        console.log(`Uploaded: ${artifact.id.slice(0, 8)}  ${artifact.title}`)
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
      // PATCH /api/artifacts/:id resolves the id prefix, writes title/render_mode
      // through the shared artifact store, and — because the on-disk filename
      // derives from the title's extension — performs the working-copy RENAME on
      // the host that owns the file. That is the same store op the app's own
      // rename uses, so a local hub renames exactly as before and a remote one
      // renames its own file instead of this machine's (which has none).
      //
      // The rename is a `renameSync`, not read-as-utf8 + write-as-utf8: the file
      // being moved may be a PNG or a PDF, and a JS string is utf-8.
      //
      // The response echoes the RAW row (`SELECT *`), which is what `--json`
      // always printed — including the version/view columns a parsed shape drops.
      if (!opts.title && !opts.renderMode) {
        console.error('Provide at least one of --title, --render-mode.')
        process.exit(1)
      }
      const body: Record<string, unknown> = {}
      if (opts.title !== undefined) body.title = opts.title
      if (opts.renderMode !== undefined) body.renderMode = opts.renderMode

      const { data } = await apiPatch<{
        ok: true
        data: ArtifactRow & { folderName: string | null }
      }>(`/api/artifacts/${encodeURIComponent(artifactId)}`, body)

      if (opts.json) {
        // `folderName` is the move route's echo, not a stored column — strip it
        // so `--json` stays exactly the artifact row.
        const { folderName: _folderName, ...row } = data
        console.log(JSON.stringify(row, null, 2))
      } else {
        console.log(`Updated: ${data.id.slice(0, 8)}  ${data.title}`)
      }
    })

  // slay tasks artifacts write <artifactId>
  cmd
    .command('write <artifactId>')
    .description('Replace artifact content from stdin')
    .option(
      '--mutate-version [ref]',
      'Bare: autosave to current (auto-branches if locked). With ref: bypass lock and mutate the target version in place'
    )
    .action(async (artifactId: string, opts: { mutateVersion?: boolean | string }) => {
      // PUT /api/artifacts/:id/content with a RAW streamed body: stdin goes
      // straight to the wire, so content that is not valid utf-8 (a piped PNG)
      // stays byte-exact. The route stages the body to a temp file and hands the
      // shared store a `sourcePath`, which writes the working copy AND records
      // the version in ONE transaction — the CLI's own write-then-version pair
      // could previously leave the file ahead of history if it died between them.
      const { data } = await apiPutStream<{
        ok: true
        data: { id: string; title: string; version: ArtifactVersion }
      }>(
        `/api/artifacts/${encodeURIComponent(artifactId)}/content?${versionWriteQuery(opts.mutateVersion)}`,
        stdinStream()
      )
      console.log(
        `Written: ${data.id.slice(0, 8)}  ${data.title}  v${data.version.version_num}`
      )
    })

  // slay tasks artifacts append <artifactId>
  cmd
    .command('append <artifactId>')
    .description('Append to artifact content from stdin')
    .option(
      '--mutate-version [ref]',
      'Bare: autosave to current (auto-branches if locked). With ref: bypass lock and mutate the target version in place'
    )
    .action(async (artifactId: string, opts: { mutateVersion?: boolean | string }) => {
      // POST (not PUT) on the same path means APPEND. The route appends the
      // streamed bytes to the working copy and versions the resulting WHOLE file
      // — the same two steps this command did locally, now atomic and on the host
      // that owns the file. Streamed for the same binary-safety reason as `write`.
      const { data } = await apiPostStream<{
        ok: true
        data: { id: string; title: string; version: ArtifactVersion }
      }>(
        `/api/artifacts/${encodeURIComponent(artifactId)}/content?${versionWriteQuery(opts.mutateVersion)}`,
        stdinStream()
      )
      console.log(
        `Appended: ${data.id.slice(0, 8)}  ${data.title}  v${data.version.version_num}`
      )
    })

  // slay tasks artifacts delete <artifactId>
  cmd
    .command('delete <artifactId>')
    .description('Delete an artifact')
    .action(async (artifactId: string) => {
      // DELETE /api/artifacts/:id resolves the id prefix (404/400 parity, same
      // `Ambiguous artifact id` wording), unlinks the working file, deletes the
      // row, and pings the renderer. It echoes `{ id, title }` so the human line
      // is unchanged without a second lookup.
      const { data: artifact } = await apiDelete<{
        ok: true
        data: { id: string; title: string }
      }>(`/api/artifacts/${encodeURIComponent(artifactId)}`)
      console.log(`Deleted: ${artifact.id.slice(0, 8)}  ${artifact.title}`)
    })

  // slay tasks artifacts path <artifactId>
  cmd
    .command('path <artifactId>')
    .description('Print artifact file path')
    .action(async (artifactId: string) => {
      // GET /api/artifacts/:id resolves the prefix and returns `filePath` composed
      // against the HUB's own storage root. Composing it here needed a local DB read
      // plus a locally-derived artifacts dir — and printed a path from the wrong
      // machine, silently, whenever the hub was remote.
      const { data } = await apiGet<{ ok: true; data: ArtifactRow & { filePath: string } }>(
        `/api/artifacts/${encodeURIComponent(artifactId)}`
      )
      // A path only means something on the filesystem that holds it. `/health`
      // reports the hub's root, so a hub that is not this machine is refused rather
      // than answered with a path nothing here can open.
      const local = await isCoLocatedHub()
      if (!local) {
        console.error(
          `Refusing to print a path for a hub on another machine — ${data.filePath} exists there, not here.\n` +
            `Use \`slay tasks artifacts read ${artifactId}\` to get the content, or ` +
            `\`download\` to write it locally.`
        )
        process.exit(1)
      }
      process.stdout.write(data.filePath)
    })

  // slay tasks artifacts mkdir <name>
  cmd
    .command('mkdir <name>')
    .description('Create a folder')
    .option('--task <id>', 'Task ID (or $SLAYZONE_TASK_ID)')
    .option('--parent <id>', 'Parent folder ID')
    .option('--json', 'Output as JSON')
    .action(async (name: string, opts) => {
      // POST /api/artifact-folders resolves the task + optional parent by id
      // prefix, allocates the next "order", and returns the created folder row
      // (parseFolder shape) — same fields the direct insert echoed in --json.
      // resolveId keeps the $SLAYZONE_TASK_ID / session-id env fallback.
      const taskRef = await resolveId(opts.task)
      const { data: folder } = await apiPost<{ ok: true; data: ArtifactFolderRow }>(
        '/api/artifact-folders',
        { taskId: taskRef, name, parentId: opts.parent }
      )
      if (opts.json) {
        console.log(JSON.stringify(folder, null, 2))
      } else {
        console.log(`Created folder: ${folder.id.slice(0, 8)}  ${name}`)
      }
    })

  // slay tasks artifacts rmdir <folderId>
  cmd
    .command('rmdir <folderId>')
    .description('Delete a folder (artifacts move to root)')
    .option('--json', 'Output as JSON')
    .action(async (folderId: string, opts) => {
      // DELETE /api/artifact-folders/:id resolves the id prefix (404/400 parity)
      // and returns the deleted folder's { id, name }. Contained artifacts fall
      // back to root via the ON DELETE SET NULL fk — same as the raw DELETE.
      const { data: folder } = await apiDelete<{ ok: true; data: { id: string; name: string } }>(
        `/api/artifact-folders/${encodeURIComponent(folderId)}`
      )
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
      // PATCH /api/artifact-folders/:id resolves the folder + target parent by id
      // prefix, enforces the same descendant-cycle guard, moves the folder, and
      // echoes the target's `parentName` (null for "root") for the human line.
      const { data } = await apiPatch<{
        ok: true
        data: ArtifactFolderRow & { parentName: string | null }
      }>(`/api/artifact-folders/${encodeURIComponent(folderId)}`, { parentId: opts.parent })
      const targetName = data.parentName ?? 'root'
      if (opts.json) {
        console.log(JSON.stringify({ id: data.id, parent_id: data.parent_id }))
      } else {
        console.log(`Moved folder: ${data.id.slice(0, 8)} -> ${targetName}`)
      }
    })

  // slay tasks artifacts mv <artifactId>
  cmd
    .command('mv <artifactId>')
    .description('Move artifact to a folder (or root)')
    .requiredOption('--folder <id>', 'Target folder ID, or "root" for top level')
    .option('--json', 'Output as JSON')
    .action(async (artifactId: string, opts) => {
      // PATCH /api/artifacts/:id resolves the artifact + target folder by id
      // prefix, updates folder_id + updated_at, and echoes the target folder's
      // `folderName` (null for "root") for the human line.
      const { data } = await apiPatch<{
        ok: true
        data: ArtifactRow & { folderName: string | null }
      }>(`/api/artifacts/${encodeURIComponent(artifactId)}`, { folderId: opts.folder })
      const targetName = data.folderName ?? 'root'
      if (opts.json) {
        console.log(JSON.stringify({ id: data.id, folder_id: data.folder_id }))
      } else {
        console.log(`Moved: ${data.id.slice(0, 8)} -> ${targetName}`)
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
    .addHelpText(
      'after',
      `
Download Types by Render Mode:
  raw   — always available (copies original file)
  pdf   — markdown, code, html, svg, mermaid
  png   — svg, mermaid
  html  — markdown, code, mermaid
  zip   — all artifacts in task (no artifactId needed)

pdf/png/html require the SlayZone app to be running.
`
    )
    .action(async (artifactId: string | undefined, opts) => {
      const validTypes = ['raw', 'pdf', 'png', 'html', 'zip']
      if (!validTypes.includes(opts.type)) {
        console.error(`Invalid type "${opts.type}". Valid types: ${validTypes.join(', ')}`)
        process.exit(1)
      }

      // --- ZIP: task-level ---
      if (opts.type === 'zip') {
        // The task's artifact + folder lists come from GET /api/tasks/:id/artifacts
        // (same rows the direct SELECTs returned, ordered by "order"), and each
        // file's BYTES stream in from GET /api/artifacts/:id/content. The archive
        // is still assembled locally — a hub-side zip route would be a new
        // capability, out of this slice's scope — but nothing reads the hub's disk
        // or DB any more, so a remote hub works.
        const taskRef = await resolveId(opts.task)
        const { data } = await apiGet<{
          ok: true
          data: { folders: ArtifactFolderRow[]; artifacts: ArtifactRow[] }
        }>(`/api/tasks/${encodeURIComponent(taskRef)}/artifacts`)
        const { artifacts, folders } = data

        if (artifacts.length === 0) {
          console.error('No artifacts to download.')
          process.exit(1)
        }

        const outputPath = opts.output ? path.resolve(opts.output) : path.resolve('artifacts.zip')
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })

        const byId = new Map(folders.map((f) => [f.id, f]))
        function folderPath(id: string): string {
          const f = byId.get(id)
          if (!f) return ''
          return f.parent_id ? path.join(folderPath(f.parent_id), f.name) : f.name
        }

        const output = fs.createWriteStream(outputPath)
        const archive = archiver('zip', { zlib: { level: 9 } })
        archive.pipe(output)

        for (const artifact of artifacts) {
          // A row whose working copy is absent was SKIPPED before (`if
          // (!fs.existsSync(fp)) continue`) — the pass-through code preserves that
          // rather than failing the whole archive.
          const { body } = await apiGetStream(
            `/api/artifacts/${encodeURIComponent(artifact.id)}/content`,
            [ARTIFACT_FILE_MISSING]
          )
          if (!body) continue
          const rel = artifact.folder_id
            ? path.join(folderPath(artifact.folder_id), artifact.title)
            : artifact.title
          archive.append(Readable.fromWeb(body as StreamWebReadable), { name: rel })
        }

        await archive.finalize()
        await new Promise<void>((resolve, reject) => {
          output.on('close', resolve)
          output.on('error', reject)
        })

        if (opts.json) {
          console.log(JSON.stringify({ path: outputPath, type: 'zip', taskId: artifacts[0].task_id }))
        } else {
          console.log(outputPath)
        }
        return
      }

      // --- Non-zip: artifactId required ---
      if (!artifactId) {
        console.error(
          `Artifact ID required for --type ${opts.type}. Use --type zip for task-level download.`
        )
        process.exit(1)
      }

      // The artifact row (title + render_mode) drives both the default output
      // filename and the export-capability check. GET /api/artifacts/:id resolves
      // the id prefix and returns the raw row — added for exactly this, since the
      // capability check has to stay client-side to keep its wording + the
      // "available types" hint (the export routes only know their own one type).
      const { data: artifact } = await apiGet<{ ok: true; data: ArtifactRow }>(
        `/api/artifacts/${encodeURIComponent(artifactId)}`
      )

      const mode = getEffectiveRenderMode(artifact.title, artifact.render_mode as RenderMode | null)
      const baseName = artifact.title.replace(/\.[^.]+$/, '') || artifact.title

      // --- RAW ---
      if (opts.type === 'raw') {
        // Stream GET /api/artifacts/:id/content straight to the output file —
        // byte-exact and constant-memory, replacing the local `copyFileSync`.
        const { body } = await apiGetStream(
          `/api/artifacts/${encodeURIComponent(artifact.id)}/content`
        )
        const outputPath = opts.output ? path.resolve(opts.output) : path.resolve(artifact.title)
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })
        await pipeline(Readable.fromWeb(body as StreamWebReadable), fs.createWriteStream(outputPath))

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
        console.error(
          `Cannot export "${artifact.title}" (${mode}) as ${opts.type}.\nAvailable types for ${mode}: ${available.join(', ')}`
        )
        process.exit(1)
      }

      const ext = opts.type
      const outputPath = opts.output
        ? path.resolve(opts.output)
        : path.resolve(`${baseName}.${ext}`)
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
      // GET /api/artifacts/:id/versions resolves the id prefix and returns the
      // rows newest-first, straight from the shared `listVersions` op — same
      // shape/order, so `--json` and the table below are unchanged.
      const { data: rows } = await apiGet<{ ok: true; data: ArtifactVersion[] }>(
        `/api/artifacts/${encodeURIComponent(artifactId)}/versions?limit=${opts.limit}&offset=${opts.offset}`
      )
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
        console.log(
          `v${String(v.version_num).padEnd(3)} ${hash}  ${String(v.size).padStart(5)}  ${name}  ${author}  ${v.created_at}`
        )
      }
    })

  versions
    .command('read <artifactId> <version>')
    .description('Print content of a specific version (int, hash prefix, name, -N, HEAD~N)')
    .action(async (artifactId: string, versionRef: string) => {
      // GET /api/artifacts/:id/versions/content?ref= resolves the ref through the
      // ONE shared resolver (int / hash prefix / name / -N / HEAD~N) and streams
      // the version's BLOB. Bytes reach stdout through a pipeline, never a string,
      // so a binary version is emitted byte-exact — the same guarantee `read` has.
      const { body } = await apiGetStream(
        `/api/artifacts/${encodeURIComponent(artifactId)}/versions/content?ref=${encodeURIComponent(versionRef)}`
      )
      if (!body) return
      await streamToStdout(body)
    })

  versions
    .command('diff <artifactId> <a> [b]')
    .description('Diff two versions (b defaults to latest). Colorized unless --no-color.')
    .option('--no-color', 'Plain output')
    .option('--json', 'Output as JSON')
    .action(
      async (
        artifactId: string,
        a: string,
        b: string | undefined,
        opts: { color: boolean; json?: boolean }
      ) => {
        // GET /api/artifacts/:id/versions/diff?a=[&b=] returns the structured
        // DiffResult from the shared `diffVersions` op (b omitted = latest).
        // RENDERING stays here: colors are gated on OUR stdout being a TTY, which
        // the hub cannot know.
        const query = new URLSearchParams({ a })
        if (b !== undefined) query.set('b', b)
        const { data: result } = await apiGet<{ ok: true; data: DiffResult }>(
          `/api/artifacts/${encodeURIComponent(artifactId)}/versions/diff?${query}`
        )
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
      }
    )

  versions
    .command('set-current <artifactId> <version>')
    .description(
      'Set the current (HEAD) version. Next UI save branches from here if the target is locked.'
    )
    .option('--json', 'Output as JSON')
    .action(async (artifactId: string, version: string, opts: { json?: boolean }) => {
      // POST /api/artifacts/:id/versions/current switches the pointer AND flushes
      // the selected version's bytes to the working copy (the store op does both,
      // in one txn) — so an editor re-reading the file still sees the right
      // content, which is why this command wrote the file itself before.
      const { data: v } = await apiPost<{ ok: true; data: ArtifactVersion }>(
        `/api/artifacts/${encodeURIComponent(artifactId)}/versions/current`,
        { ref: version }
      )
      if (opts.json) {
        console.log(JSON.stringify(v, null, 2))
      } else {
        console.log(
          `Current: v${v.version_num}${v.name ? ` (${v.name})` : ''}  ${v.content_hash.slice(0, 8)}`
        )
      }
    })

  versions
    .command('current <artifactId>')
    .description('Print the current (HEAD) version')
    .option('--json', 'Output as JSON')
    .action(async (artifactId: string, opts: { json?: boolean }) => {
      // GET /api/artifacts/:id/versions/current 404s with the exact wording this
      // command printed for a version-less artifact ("No versions for this
      // artifact"), and api.ts prints that + exits 1 — same behavior, no branch.
      const { data: v } = await apiGet<{ ok: true; data: ArtifactVersion }>(
        `/api/artifacts/${encodeURIComponent(artifactId)}/versions/current`
      )
      if (opts.json) {
        console.log(JSON.stringify(v, null, 2))
      } else {
        console.log(
          `v${v.version_num}${v.name ? ` (${v.name})` : ''}  ${v.content_hash.slice(0, 8)}`
        )
      }
    })

  versions
    .command('create <artifactId>')
    .description('Create a version from the current working copy (honors unchanged content)')
    .option('--name <name>', 'Optional name for the version')
    .option('--json', 'Output as JSON')
    .action(async (artifactId: string, opts: { name?: string; json?: boolean }) => {
      // POST /api/artifacts/:id/versions reads the WORKING COPY on the host that
      // owns it and versions it with honorUnchanged — so an unchanged file still
      // gets a row, as this command always did. The author rides the body because
      // `cliAuthor()` reads OUR env, which the hub cannot see.
      const { data: v } = await apiPost<{ ok: true; data: ArtifactVersion }>(
        `/api/artifacts/${encodeURIComponent(artifactId)}/versions`,
        { name: opts.name ?? null, ...authorBody() }
      )
      if (opts.json) {
        console.log(JSON.stringify(v, null, 2))
      } else {
        console.log(`Created: v${v.version_num}${v.name ? ` (${v.name})` : ''}`)
      }
    })

  versions
    .command('rename <artifactId> <version> [newName]')
    .description('Set, change, or clear (omit newName) the name of a version')
    .option('--clear', 'Clear the name')
    .option('--json', 'Output as JSON')
    .action(
      async (
        artifactId: string,
        versionRef: string,
        newName: string | undefined,
        opts: { clear?: boolean; json?: boolean }
      ) => {
        // PATCH /api/artifacts/:id/versions with { ref, name }. The ref is in the
        // BODY, not the path: it can be `HEAD~2` or a name, neither of which
        // survives a path segment cleanly. `null` clears, which is what both an
        // omitted newName and --clear mean.
        const target = opts.clear ? null : (newName ?? null)
        const { data: v } = await apiPatch<{ ok: true; data: ArtifactVersion }>(
          `/api/artifacts/${encodeURIComponent(artifactId)}/versions`,
          { ref: versionRef, name: target }
        )
        if (opts.json) {
          console.log(JSON.stringify(v, null, 2))
        } else {
          console.log(`Renamed v${v.version_num}: ${target ?? '(no name)'}`)
        }
      }
    )

  versions
    .command('prune <artifactId>')
    .description('Remove old versions. Named and current versions protected by default.')
    .option('--keep-last <n>', 'Keep the N most recent versions', (v) => parseInt(v, 10), 0)
    .option('--no-keep-named', 'Also delete named versions')
    .option('--no-keep-current', 'Allow deleting the current (HEAD) version')
    .option('--dry-run', 'Show what would be deleted without modifying')
    .option('--json', 'Output as JSON')
    .action(
      async (
        artifactId: string,
        opts: {
          keepLast: number
          keepNamed: boolean
          keepCurrent: boolean
          dryRun?: boolean
          json?: boolean
        }
      ) => {
        // POST /api/artifacts/:id/versions/prune runs the shared `pruneVersions`
        // op, which also GCs blobs no version references any more — that deletion
        // has to happen where the blob store lives.
        const { data: report } = await apiPost<{ ok: true; data: PruneReport }>(
          `/api/artifacts/${encodeURIComponent(artifactId)}/versions/prune`,
          {
            keepLast: opts.keepLast,
            keepNamed: opts.keepNamed,
            keepCurrent: opts.keepCurrent,
            dryRun: opts.dryRun ?? false
          }
        )
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2))
        } else {
          const verb = opts.dryRun ? 'would delete' : 'deleted'
          console.log(
            `${verb} ${report.deletedVersions} versions, ${report.deletedBlobs} blobs (kept ${report.keptNamed} named)`
          )
        }
      }
    )

  cmd.addCommand(versions)

  return cmd
}
