/**
 * The phone's artifact code against two real hubs — the check no jest suite can make.
 * Not run by any test suite.
 *
 *   pnpm --filter @slayzone/hub build && pnpm --filter @slayzone/computer build
 *   pnpm exec tsx packages/apps/mobile/scripts/artifacts/check-artifacts.mts   # repo root
 *
 * Boots hubs a (127.0.0.1:47921) and b (:47922), each with a phone account, a computer
 * enrolled for it, a project and a task (`../test-hub.mts`), and runs the app's own modules
 * (only the device's file I/O is swapped for Node's: the same request, the same bytes):
 * - upload (`uploadArtifactWith`, the request `uploadArtifact` sends): markdown, a PNG
 *   into a folder, an HTML report; byte-exact; to the hub that owns the task only;
 * - list (`artifacts.getByTask` + `foldersGetByTask` → `artifactTreeRows`), live
 *   (`notify.onTasksChanged` names the task: `touchesTask`), each row's viewer kind;
 * - content: text by `artifacts.readContent` (rendered by `markdownPage`), bytes by the
 *   REST download (`downloadArtifactFileTo`), a version's bytes, the versions list;
 * - search (`searchArtifacts`) across both hubs: merged, tagged, in sign-in order; a
 *   refused bearer reported for its hub alone.
 */
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { ArtifactFileStore } from '../../src/artifacts/file-cache.ts'
import { downloadArtifactFileTo } from '../../src/artifacts/file-cache.ts'
import { type HubFetch, hubTarget } from '../../src/artifacts/hub-rest.ts'
import { markdownPage } from '../../src/artifacts/pages/markdown-page.ts'
import { searchArtifacts } from '../../src/artifacts/search.ts'
import { testPageTheme } from '../../src/artifacts/testing.ts'
import { artifactTreeRows } from '../../src/artifacts/tree-rows.ts'
import { type UploadFile, uploadArtifactWith } from '../../src/artifacts/upload-request.ts'
import { touchesTask } from '../../src/artifacts/use-task-artifacts.ts'
import { viewerKindOf } from '../../src/artifacts/viewer-kind.ts'
import {
  check,
  createProject,
  fail,
  finish,
  freshStateDir,
  type PhoneHub,
  signInPhone,
  startTestHub,
  until
} from '../test-hub.mts'

const PORTS = [Number(process.argv[2] ?? 47921), Number(process.argv[3] ?? 47922)]
const dir = freshStateDir('check-artifacts')

// --- Node's stand-ins for the device's file I/O (expo-file-system) ---

const fileOf = (uri: string): string => decodeURIComponent(new URL(uri).pathname)

/** `File.upload(…, BINARY_CONTENT)`: the file streamed as the raw body. */
const nodeUploadFile: UploadFile = (req) =>
  new Promise((resolve, reject) => {
    const u = new URL(req.url)
    const file = fileOf(req.fileUri)
    const out = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        agent: false,
        headers: { ...req.headers, 'content-length': String(statSync(file).size) }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    out.on('error', reject)
    createReadStream(file).pipe(out)
  })

/** `fetch` as React Native sends it (no browser headers). */
const nodeFetch: HubFetch = (url, init) =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: init.method,
        agent: false,
        headers: init.headers
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          resolve({
            status,
            ok: status >= 200 && status < 300,
            text: async () => Buffer.concat(chunks).toString('utf8')
          })
        })
      }
    )
    req.on('error', reject)
    req.end()
  })

/** The cache on Node's file system, failing a download the way expo-file-system does. */
function nodeStore(base: string): ArtifactFileStore {
  return {
    find: (d, name) => {
      const p = path.join(base, ...d, name)
      return existsSync(p) ? `file://${p}` : null
    },
    download: (url, headers, d, name) =>
      new Promise((resolve, reject) => {
        const target = path.join(base, ...d, name)
        mkdirSync(path.dirname(target), { recursive: true })
        const u = new URL(url)
        const req = http.request(
          {
            host: u.hostname,
            port: u.port,
            path: `${u.pathname}${u.search}`,
            agent: false,
            headers
          },
          (res) => {
            if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
              res.resume()
              reject(new Error(`Unable to download a file: response has status ${res.statusCode}`))
              return
            }
            pipeline(res, createWriteStream(target)).then(() => resolve(`file://${target}`), reject)
          }
        )
        req.on('error', reject)
        req.end()
      }),
    removeExcept: (d, keep) => {
      const p = path.join(base, ...d)
      if (!existsSync(p)) return
      if (keep === null) rmSync(p, { recursive: true, force: true })
    }
  }
}

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

try {
  const hubs: Array<{ phone: PhoneHub; taskId: string }> = []
  for (const [i, name] of ['a', 'b'].entries()) {
    const hubDir = path.join(dir, name)
    const work = path.join(hubDir, 'home', 'work')
    mkdirSync(work, { recursive: true })
    const hub = await startTestHub({ name: `w1b-artifacts-${name}`, port: PORTS[i], dir: hubDir })
    const account = await hub.createUser(`phone@artifacts-${name}.test`)
    hub.startComputer({ forUser: account.email, allowedRoot: path.join(hubDir, 'home') })
    const phone = await signInPhone(hub.address, account)
    const project = await createProject(phone.client, {
      name: `Artifacts ${name}`,
      color: '#8b5cf6',
      path: work
    })
    const task = await phone.client.task.create.mutate({
      projectId: project.id,
      title: `Launch on ${name}`
    })
    hubs.push({ phone, taskId: task.id })
  }
  check(hubs.length === 2, 'signed in to two hubs, a task on each')
  const [a, b] = hubs
  const targetA = hubTarget({ entry: a.phone.entry, token: a.phone.token })
  const targetB = hubTarget({ entry: b.phone.entry, token: b.phone.token })

  // Live: what the list reloads on.
  const events: unknown[] = []
  const sub = a.phone.client.notify.onTasksChanged.subscribe(undefined, {
    onData: (e) => events.push(e)
  })

  // Upload: markdown and an HTML report at the top level, a PNG into a folder.
  const files = path.join(dir, 'phone-files')
  mkdirSync(files, { recursive: true })
  const md =
    '# Launch plan\n\n- [x] book venue\n- [ ] the launch checklist\n\n```mermaid\ngraph TD; A-->B\n```\n'
  writeFileSync(path.join(files, 'plan.md'), md)
  writeFileSync(path.join(files, 'pixel.png'), PNG)
  writeFileSync(
    path.join(files, 'report.html'),
    '<!doctype html><html><head></head><body><h1>Report</h1></body></html>'
  )
  const uri = (name: string) => `file://${path.join(files, name)}`

  const plan = await uploadArtifactWith(nodeUploadFile, targetA, {
    taskId: a.taskId,
    file: { uri: uri('plan.md'), name: 'plan.md' }
  })
  check(
    plan.title === 'plan.md' && plan.task_id === a.taskId && plan.folder_id === null,
    'uploaded plan.md to the top level of the task on hub a'
  )
  const folder = await a.phone.client.artifacts.foldersCreate.mutate({
    taskId: a.taskId,
    name: 'Shots'
  })
  const pixel = await uploadArtifactWith(nodeUploadFile, targetA, {
    taskId: a.taskId,
    folderId: folder?.id,
    file: { uri: uri('pixel.png'), name: 'pixel.png' }
  })
  check(pixel.folder_id === folder?.id, 'uploaded pixel.png into the folder')
  await uploadArtifactWith(nodeUploadFile, targetA, {
    taskId: a.taskId,
    file: { uri: uri('report.html'), name: 'report.html' }
  })

  // Writes go to the owning hub only: hub a does not know hub b's task.
  const wrongHub = await uploadArtifactWith(nodeUploadFile, targetA, {
    taskId: b.taskId,
    file: { uri: uri('plan.md'), name: 'plan.md' }
  }).then(
    () => null,
    (err: unknown) => err as { status?: number }
  )
  check(
    wrongHub?.status === 404,
    "an upload naming another hub's task is refused (404), nothing written"
  )

  await until('hub a says the task changed', () =>
    events.some((e) => touchesTask(e as never, a.taskId))
  )
  check(true, 'notify.onTasksChanged told the phone, naming the task or every task (touchesTask)')
  sub.unsubscribe()

  // List: the tree, as the phone shows it.
  const [artifacts, folders] = await Promise.all([
    a.phone.client.artifacts.getByTask.query({ taskId: a.taskId }),
    a.phone.client.artifacts.foldersGetByTask.query({ taskId: a.taskId })
  ])
  const rows = artifactTreeRows(folders, artifacts, new Set())
  const shown = rows.map((r) =>
    r.kind === 'folder' ? `[${r.folder.name}]` : `${r.artifact.title}:${viewerKindOf(r.artifact)}`
  )
  check(
    JSON.stringify(shown) ===
      JSON.stringify(['[Shots]', 'pixel.png:image', 'plan.md:markdown', 'report.html:html']),
    `tree rows + viewer kinds: ${shown.join(', ')}`
  )

  // Content: text over the socket, bytes over REST, byte-exact.
  const text = await a.phone.client.artifacts.readContent.query({ id: plan.id })
  check(text === md, 'readContent returns the uploaded markdown')
  const page = markdownPage(text ?? '', {
    theme: testPageTheme('dark'),
    mermaidScript: 'globalThis.mermaid={}'
  })
  check(
    page.html.includes('<h1>Launch plan</h1>') && page.scripts,
    'markdownPage renders it, with its diagram'
  )
  const store = nodeStore(path.join(dir, 'phone-cache'))
  const pngUri = await downloadArtifactFileTo(store, targetA, { artifact: pixel, contentTick: 0 })
  check(
    Buffer.compare(readFileSync(fileOf(pngUri)), PNG) === 0,
    'the PNG downloads byte-exact (REST, bearer)'
  )
  const versions = await a.phone.client.artifacts.versionsList.query({
    artifactId: plan.id,
    limit: 50
  })
  check(
    versions.length >= 1 && versions[0].version_num === 1,
    `plan.md has its versions (${versions.length})`
  )
  const v1Uri = await downloadArtifactFileTo(store, targetA, {
    artifact: plan,
    version: { ref: versions[0].version_num, contentHash: versions[0].content_hash }
  })
  check(readFileSync(fileOf(v1Uri), 'utf8') === md, 'version 1 downloads byte-exact')

  // Search across both hubs.
  writeFileSync(path.join(files, 'notes.md'), 'Notes\n\nlaunch day is Friday\n')
  await uploadArtifactWith(nodeUploadFile, targetB, {
    taskId: b.taskId,
    file: { uri: uri('notes.md'), name: 'notes.md' }
  })
  const outcome = await searchArtifacts([targetA, targetB], { q: 'launch' }, { fetch: nodeFetch })
  const found = outcome.results.map((r) => `${r.hubLabel}:${r.title}`)
  check(
    found[0] === `${targetA.label}:plan.md` &&
      found.includes(`${targetB.label}:notes.md`) &&
      outcome.hubs.every((h) => h.ok),
    `search merges both hubs, hub a first: ${found.join(', ')}`
  )
  const line = outcome.results
    .find((r) => r.title === 'notes.md')
    ?.matches.find((m) => m.type === 'content')
  check(
    line?.line === 3 && /launch day/.test(line.snippet),
    'a content match carries its line and snippet'
  )
  const refused = await searchArtifacts(
    [{ ...targetA, token: 'not-a-token' }, targetB],
    { q: 'launch' },
    { fetch: nodeFetch }
  )
  check(
    !refused.hubs[0].ok &&
      /sign-in to .* has expired/.test(refused.hubs[0].ok ? '' : refused.hubs[0].error) &&
      refused.hubs[1].ok &&
      refused.results.some((r) => r.title === 'notes.md'),
    "a refused bearer fails that hub only; the other hub's results stay"
  )
  for (const h of hubs) h.phone.close()
} catch (err) {
  fail(err)
}
finish()
