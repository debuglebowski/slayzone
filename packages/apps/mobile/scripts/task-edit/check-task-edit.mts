/**
 * The phone's task create/edit/organise code against two real hubs — the check no jest
 * suite can make. Not run by any test suite.
 *
 *   pnpm --filter @slayzone/hub build && pnpm --filter @slayzone/computer build
 *   pnpm exec tsx packages/apps/mobile/scripts/task-edit/check-task-edit.mts   # repo root
 *
 * Boots hubs a (127.0.0.1:47961) and b (:47962), each with a phone account, a computer
 * enrolled for it and a project (`../test-hub.mts`), and drives them with the app's own
 * modules (`src/task-edit/*`, `src/artifacts/upload-request.ts`; only the device's file
 * upload is Node's: the same request, the same bytes):
 * - create: the project's templates (`templateChoices`: default preselected,
 *   `applyTemplate`), `createTaskInput` → `task.create` on the project's hub only; the
 *   hub applies the default template even when none is named (why the phone offers no
 *   "No template" then); a subtask;
 * - edit: title, status (the project's columns), priority, due date, read back;
 * - organise: tags (`projectTags`, `toggleTag` → `tags.setForTask`), blockers
 *   (`blockerCandidates` → `addBlocker` / `removeBlocker`, the board's blocked rule), the
 *   blocked flag + comment;
 * - description: desktop-style markdown read back byte for byte (`editableDescription`),
 *   an unchanged text writes nothing (`descriptionUpdate`), a photo uploaded to the task
 *   and linked at the cursor (`insertAt`, `artifactLink`), saved and read back, a change
 *   by another client detected (`hubChanged`);
 * - archive / unarchive, delete → gone from the board → restore.
 */
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { hubTarget } from '../../src/artifacts/hub-rest.ts'
import { type UploadFile, uploadArtifactWith } from '../../src/artifacts/upload-request.ts'
import type { BoardData } from '../../src/hub-board.ts'
import { createTaskInput, type NewTaskDraft } from '../../src/task-edit/create.ts'
import {
  artifactLink,
  descriptionUpdate,
  editableDescription,
  hubChanged,
  insertAt
} from '../../src/task-edit/description.ts'
import {
  applyTemplate,
  NO_TEMPLATE,
  statusChoices,
  templateChoices
} from '../../src/task-edit/fields.ts'
import {
  blockerCandidates,
  isBlocked,
  projectTags,
  subtasksOf,
  toggleTag
} from '../../src/task-edit/organise.ts'
import {
  check,
  createProject,
  fail,
  finish,
  freshStateDir,
  type PhoneHub,
  signInPhone,
  startTestHub
} from '../test-hub.mts'

const PORTS = [Number(process.argv[2] ?? 47961), Number(process.argv[3] ?? 47962)]
const dir = freshStateDir('check-task-edit')

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

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/** What desktop writes: artifact links, a task list, code, a table, odd spacing. */
const DESKTOP = [
  '# Plan',
  '',
  'See [the PR](https://example.com/pr/1).',
  '',
  '- [x] done item',
  '- [ ] open item  ',
  '',
  '```ts',
  'const x = 1   // spaces kept',
  '\tindented()',
  '```',
  '',
  '| a | b |',
  '| --- | :-: |',
  '| 1 | `|` |',
  ''
].join('\n')

const board = (phone: PhoneHub): Promise<BoardData> =>
  phone.client.task.loadBoardData.query() as Promise<BoardData>

try {
  const hubs: Array<{ phone: PhoneHub; projectId: string }> = []
  for (const [i, name] of ['a', 'b'].entries()) {
    const hubDir = path.join(dir, name)
    const work = path.join(hubDir, 'home', 'work')
    mkdirSync(work, { recursive: true })
    const hub = await startTestHub({ name: `w2b-task-${name}`, port: PORTS[i], dir: hubDir })
    const account = await hub.createUser(`phone@task-${name}.test`)
    hub.startComputer({ forUser: account.email, allowedRoot: path.join(hubDir, 'home') })
    const phone = await signInPhone(hub.address, account)
    const project = await createProject(phone.client, {
      name: `Tasks ${name}`,
      color: '#8b5cf6',
      path: work
    })
    hubs.push({ phone, projectId: project.id })
  }
  const [a, b] = hubs
  check(hubs.length === 2, 'signed in to two hubs, a project on each')

  // --- Create, with the project's templates ---
  await a.phone.client.template.create.mutate({
    projectId: a.projectId,
    name: 'Bug',
    defaultPriority: 2
  })
  const feature = await a.phone.client.template.create.mutate({
    projectId: a.projectId,
    name: 'Feature',
    defaultStatus: 'in_progress',
    defaultPriority: 1,
    isDefault: true
  })
  const templates = await a.phone.client.template.getByProject.query({ projectId: a.projectId })
  const { choices, initial } = templateChoices(templates)
  check(
    initial === feature?.id && !choices.some((c) => c.key === NO_TEMPLATE),
    "templates: the project's default preselected, no 'No template' while it has one"
  )
  const boardA = await board(a.phone)
  const projectA = boardA.projects.find((p) => p?.id === a.projectId) ?? undefined
  const statuses = statusChoices(projectA).map((c) => c.key)
  let draft: NewTaskDraft = {
    projectId: a.projectId,
    parentId: null,
    title: '  Ship the phone editor ',
    status: statuses[0],
    priority: 3,
    dueDate: '2027-01-15',
    templateId: initial
  }
  draft = {
    ...draft,
    ...applyTemplate(
      draft,
      templates.find((t) => t.id === initial),
      projectA?.columns_config,
      {
        status: false,
        priority: false
      }
    )
  }
  const input = createTaskInput(draft)
  const created = input ? await a.phone.client.task.create.mutate(input) : null
  check(
    created?.title === 'Ship the phone editor' &&
      created.status === 'in_progress' &&
      created.priority === 1 &&
      created.due_date === '2027-01-15',
    `create: trimmed title, the template's status + priority, the due date (${created?.status}, P${created?.priority})`
  )
  if (!created) throw new Error('no task created')
  const taskId = created.id

  // What a create naming no template gets: the project's default all the same.
  const plain = await a.phone.client.task.create.mutate({
    projectId: a.projectId,
    title: 'No template named'
  })
  check(
    plain.status === 'in_progress' && plain.priority === 1,
    'create without a template id: the hub still applies the default (why the phone offers no "none" then)'
  )

  const onB = await b.phone.client.task.create.mutate(
    createTaskInput({
      ...draft,
      projectId: b.projectId,
      title: 'On hub b',
      templateId: NO_TEMPLATE
    })!
  )
  check(
    !(await board(a.phone)).tasks.some((t) => t.id === onB.id) &&
      (await board(b.phone)).tasks.some((t) => t.id === onB.id),
    "a task created for b's project lives on b only"
  )
  let refused = ''
  await a.phone.client.task.create
    .mutate(createTaskInput({ ...draft, projectId: b.projectId, title: 'Wrong hub' })!)
    .catch((err: unknown) => {
      refused = err instanceof Error ? err.message : String(err)
    })
  check(
    refused !== '' && !(await board(a.phone)).tasks.some((t) => t.title === 'Wrong hub'),
    `b's project on hub a is refused (${refused}), nothing created there`
  )

  // --- Edit ---
  await a.phone.client.task.update.mutate({ id: taskId, title: 'Ship it' })
  await a.phone.client.task.update.mutate({ id: taskId, status: 'review' })
  await a.phone.client.task.update.mutate({ id: taskId, priority: 4 })
  await a.phone.client.task.update.mutate({ id: taskId, dueDate: null })
  const edited = await a.phone.client.task.get.query({ id: taskId })
  check(
    edited?.title === 'Ship it' &&
      edited.status === 'review' &&
      edited.priority === 4 &&
      edited.due_date === null,
    'edit: title, status, priority, due date cleared — read back'
  )

  // --- Subtask ---
  const sub = await a.phone.client.task.create.mutate(
    createTaskInput({ ...draft, parentId: taskId, title: 'Part one', templateId: NO_TEMPLATE })!
  )
  check(
    subtasksOf(await board(a.phone), taskId)
      .map((t) => t.id)
      .join() === sub.id,
    'a subtask shows under its parent'
  )

  // --- Tags ---
  const red = await a.phone.client.tags.create.mutate({
    name: 'red',
    color: '#ef4444',
    projectId: a.projectId
  })
  const blue = await a.phone.client.tags.create.mutate({
    name: 'blue',
    color: '#3b82f6',
    projectId: a.projectId
  })
  await b.phone.client.tags.create.mutate({ name: 'other hub', projectId: b.projectId })
  const tagsOf = projectTags(await board(a.phone), a.projectId).map((t) => t.name)
  check(
    tagsOf.join() === 'red,blue' || tagsOf.join() === 'blue,red',
    `the project's tags: ${tagsOf}`
  )
  let tagIds = toggleTag([], red.id)
  tagIds = toggleTag(tagIds, blue.id)
  await a.phone.client.tags.setForTask.mutate({ taskId, tagIds })
  tagIds = toggleTag(tagIds, red.id)
  await a.phone.client.tags.setForTask.mutate({ taskId, tagIds })
  check(
    ((await board(a.phone)).taskTags[taskId] ?? []).join() === blue.id,
    'tags: toggled on, one off again — the board holds exactly blue'
  )

  // --- Blockers ---
  const blocker = await a.phone.client.task.create.mutate({
    projectId: a.projectId,
    title: 'Legal sign-off'
  })
  const done = await a.phone.client.task.create.mutate({
    projectId: a.projectId,
    title: 'Old',
    status: 'done'
  })
  const candidates = blockerCandidates(await board(a.phone), taskId, [], '').map((t) => t.id)
  check(
    candidates.includes(blocker.id) &&
      !candidates.includes(done.id) &&
      !candidates.includes(taskId),
    'blocker candidates: open tasks of the hub, not itself, not finished ones'
  )
  await a.phone.client.task.addBlocker.mutate({ taskId, blockerTaskId: blocker.id })
  const blockers = await a.phone.client.task.getBlockers.query({ taskId })
  check(
    blockers.map((t) => t.id).join() === blocker.id && isBlocked(await board(a.phone), taskId),
    'blocker added: listed, the board shows the task blocked'
  )
  await a.phone.client.task.removeBlocker.mutate({ taskId, blockerTaskId: blocker.id })
  check(
    (await a.phone.client.task.getBlockers.query({ taskId })).length === 0 &&
      !isBlocked(await board(a.phone), taskId),
    'blocker removed: not blocked any more'
  )
  await a.phone.client.task.update.mutate({
    id: taskId,
    isBlocked: true,
    blockedComment: 'Waiting on legal'
  })
  const flagged = await a.phone.client.task.get.query({ id: taskId })
  check(
    flagged?.is_blocked === true &&
      flagged.blocked_comment === 'Waiting on legal' &&
      isBlocked(await board(a.phone), taskId),
    'blocked flag + comment'
  )
  await a.phone.client.task.update.mutate({ id: taskId, isBlocked: false, blockedComment: null })
  const unflagged = await a.phone.client.task.get.query({ id: taskId })
  check(unflagged?.is_blocked === false && unflagged.blocked_comment === null, 'unblocked')

  // --- Description ---
  await a.phone.client.task.update.mutate({ id: taskId, description: DESKTOP })
  const stored = await a.phone.client.task.get.query({ id: taskId })
  if (!stored) throw new Error('task gone')
  const original = editableDescription(stored)
  check(original === DESKTOP, "desktop's markdown reads back byte for byte")
  check(descriptionUpdate(original, original) === null, 'Done without a change: nothing to write')

  const files = path.join(dir, 'phone-files')
  mkdirSync(files, { recursive: true })
  writeFileSync(path.join(files, 'photo.png'), PNG)
  const target = hubTarget({ entry: a.phone.entry, token: a.phone.token })
  const artifact = await uploadArtifactWith(nodeUploadFile, target, {
    taskId,
    file: { uri: `file://${path.join(files, 'photo.png')}`, name: 'photo.png' }
  })
  const cursor = original.indexOf('- [ ] open')
  const withLink = insertAt(
    original,
    { start: cursor, end: cursor },
    `${artifactLink(artifact.id, artifact.title)}\n`
  )
  const update = descriptionUpdate(original, withLink.text)
  // Before saving, the editor asks the hub whether it changed meanwhile.
  const beforeSave = await a.phone.client.task.get.query({ id: taskId })
  check(!!beforeSave && !hubChanged(stored, beforeSave), 'nobody changed it meanwhile')
  if (update) await a.phone.client.task.update.mutate({ id: taskId, ...update })
  const saved = await a.phone.client.task.get.query({ id: taskId })
  const listed = await a.phone.client.artifacts.getByTask.query({ taskId })
  check(
    saved?.description ===
      `${DESKTOP.slice(0, cursor)}[photo.png](artifact:${artifact.id})\n${DESKTOP.slice(cursor)}` &&
      listed.some((x) => x.id === artifact.id),
    'attachment: uploaded to the task, linked at the cursor, the rest unchanged'
  )

  await a.phone.client.task.update.mutate({ id: taskId, description: 'Changed on desktop' })
  const later = await a.phone.client.task.get.query({ id: taskId })
  check(
    !!later && saved !== null && hubChanged(saved, later),
    "another client's change is detected"
  )
  await a.phone.client.task.update.mutate({ id: taskId, ...descriptionUpdate('x', '')! })
  check(
    (await a.phone.client.task.get.query({ id: taskId }))?.description === null,
    'cleared: null'
  )

  // --- Archive, delete ---
  await a.phone.client.task.archive.mutate({ id: taskId })
  check(!!(await a.phone.client.task.get.query({ id: taskId }))?.archived_at, 'archived')
  await a.phone.client.task.unarchive.mutate({ id: taskId })
  check(!(await a.phone.client.task.get.query({ id: taskId }))?.archived_at, 'unarchived')
  const deleted = await a.phone.client.task.delete.mutate({ id: plain.id })
  check(
    deleted === true && !(await board(a.phone)).tasks.some((t) => t.id === plain.id),
    'deleted: gone from the board'
  )
  const restored = await a.phone.client.task.restore.mutate({ id: plain.id })
  check(
    restored?.id === plain.id && (await board(a.phone)).tasks.some((t) => t.id === plain.id),
    'restored'
  )
  check(
    (await board(b.phone)).tasks.every((t) => t.project_id === b.projectId),
    "hub b holds none of a's tasks"
  )
  for (const h of hubs) h.phone.close()
} catch (err) {
  fail(err)
}
finish()
