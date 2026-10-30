/**
 * The phone's projects / computers / hubs code against two real hubs at once — the
 * check no jest suite can make. Not run by any test suite.
 *
 *   pnpm --filter @slayzone/hub build && pnpm --filter @slayzone/computer build
 *   pnpm exec tsx packages/apps/mobile/scripts/two-hub-workspace.mts   # repo root
 *
 * Boots hubs a (127.0.0.1:47931) and b (:47932), each with a computer enrolled for a
 * phone account of its own (`test-hub.mts`), and runs the app's own modules and calls:
 * - `projects/hub-projects.ts` over both hubs' boards: every project grouped under its
 *   hub, in sign-in order, rows unique across hubs;
 * - `projects/folders.ts` + the folder picker's calls: browse the computer
 *   (`workspace.listRoots` → `pickerStartDir` → `listDir`), create a folder (`mkdir`),
 *   set it (`workspace.setProjectPath`: ready), a folder outside the computer's roots
 *   (refused, nothing recorded), remove it (`workspace.forgetProjectPath`), the default
 *   computer (`computers.setProjectDefaultComputer`);
 * - a task's computer (`computers.setTaskComputer`) through `hub-board.ts`'s
 *   `ownerClient`: lands on the hub that owns the task, which says its tasks changed;
 *   the same ids on the other hub are refused; an unknown hub throws;
 * - computers live: `computers.list` + `computers.onStatusChange`, words from
 *   `@slayzone/computers/labels` (Connected → Offline when the computer stops);
 * - who is signed in on each hub (`fetchSessionEmail`, as `hubs/use-hub-account.ts`);
 * - removing hub b (its client closed): hub a's rows stay and it still answers.
 */
import { mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { computerStatus } from '@slayzone/computers/labels'
import { pickerStartDir } from '@slayzone/file-editor/dir-picker'
import { fetchSessionEmail, signInWithPassword } from '@slayzone/hub-auth/client'
import { nodeHubTransport } from '@slayzone/hub-auth/client-node'
import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'
import type { ResolvedHub } from '@slayzone/transport/client'
import { NO_AGENT_SESSIONS } from '../src/agents/hub-agents.ts'
import type { HubComputer } from '../src/computers/hub-computers.ts'
import { type BoardData, type HubFeed, ownerClient } from '../src/hub-board.ts'
import { projectFolders } from '../src/projects/folders.ts'
import { findProjectRow, mergeHubProjects } from '../src/projects/hub-projects.ts'
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
} from './test-hub.mts'

// The hubs' ports: the first two arguments, else 47931 and 47932.
const PORTS = [Number(process.argv[2] ?? 47931), Number(process.argv[3] ?? 47932)]

const dir = freshStateDir('two-hub-workspace')

interface Hub {
  phone: PhoneHub
  email: string
  password: string
  projectId: string
  taskId: string
  /** The computer's allowed root, as the computer resolves it. */
  root: string
  stopComputer: () => void
}

const feedOf = (hub: Hub, board: BoardData): HubFeed => ({
  hub: hub.phone.entry,
  connection: { status: 'open', error: null },
  stalled: false,
  board: { data: board, pending: false, error: null, refreshing: false },
  agents: NO_AGENT_SESSIONS
})

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Polls an async `test` until it gives a value; throws after `ms`. */
async function poll<T>(what: string, test: () => Promise<T | null>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await test()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

try {
  // Two hubs, each with its own phone account and computer; one project + task each.
  const hubs: Hub[] = []
  for (const [i, name] of ['a', 'b'].entries()) {
    const hubDir = path.join(dir, name)
    const home = path.join(hubDir, 'home')
    const work = path.join(home, 'work')
    mkdirSync(work, { recursive: true })
    const hub = await startTestHub({ name: `mobile-ws-${name}`, port: PORTS[i], dir: hubDir })
    const account = await hub.createUser(`mobile@ws-${name}.test`)
    const stopComputer = hub.startComputer({ forUser: account.email, allowedRoot: home })
    const phone = await signInPhone(hub.address, account)
    // The same project id cannot be forced, but the same NAME on both hubs must still
    // stay two rows: the merged list keys by hub + id.
    const project = await createProject(phone.client, {
      name: 'Website',
      color: name === 'a' ? '#8b5cf6' : '#10b981',
      path: work
    })
    const task = await phone.client.task.create.mutate({
      projectId: project.id,
      title: `${name.toUpperCase()}: first task`,
      terminalMode: 'terminal'
    })
    hubs.push({
      phone,
      email: account.email,
      password: account.password,
      projectId: project.id,
      taskId: task.id,
      root: realpathSync(home),
      stopComputer
    })
  }
  check(hubs.length === 2, 'signed in to two hubs, a project and a task on each')
  const [a, b] = hubs
  const board = (hub: Hub): Promise<BoardData> => hub.phone.client.task.loadBoardData.query()
  const computersOf = (hub: Hub): Promise<HubComputer[]> =>
    hub.phone.client.computers.list.query() as Promise<HubComputer[]>

  // 1. Projects of both hubs, merged: grouped by hub, in sign-in order.
  const groups = mergeHubProjects([feedOf(a, await board(a)), feedOf(b, await board(b))])
  check(
    groups.map((g) => g.hub.id).join() === [a.phone.entry.id, b.phone.entry.id].join(),
    'projects grouped by hub, in sign-in order'
  )
  check(
    groups.every((g, i) => g.projects.some((r) => r.project.id === hubs[i].projectId)),
    "each hub's group holds its own project"
  )
  const keys = groups.flatMap((g) => g.projects.map((r) => r.key))
  check(new Set(keys).size === keys.length, `merged rows unique across hubs (${keys.length})`)

  // 2. Computers: each hub lists the phone user's own, connected.
  const computerA = await poll('hub a lists its computer as usable', async () => {
    const [c] = await computersOf(a)
    return c?.usable ? c : null
  })
  const [computerB] = await computersOf(b)
  check(
    computerStatus(computerA).label === 'Connected',
    `hub a's computer: ${computerStatus(computerA).label}`
  )
  check(
    computerB !== undefined && computerB.id !== computerA.id,
    'hub b lists only its own computer'
  )

  // 3. Folders: the project's folder on hub a's computer, as the project screen lists it.
  const projectA = async () => {
    const row = findProjectRow(feedOf(a, await board(a)), a.projectId)
    if (!row) throw new Error("hub a's project is gone")
    return row.project
  }
  const foldersA = async () => {
    const folders = projectFolders(await projectA(), await computersOf(a))
    if (folders.kind !== 'per-computer') throw new Error('expected folders per computer')
    return folders.rows
  }
  const firstRows = await foldersA()
  check(
    firstRows[0]?.computerId === computerA.id &&
      firstRows[0].isDefault &&
      firstRows[0].placement?.status === 'ready' &&
      firstRows[0].placement.path === path.join(a.root, 'work'),
    `folder on the default computer, ready: ${firstRows[0]?.placement?.path}`
  )

  // 4. The folder picker's calls, on THAT computer.
  const target = { computerId: computerA.id, projectId: a.projectId }
  const roots = await a.phone.client.workspace.listRoots.query(target)
  const start = pickerStartDir({ roots: roots.roots, sep: roots.sep, home: roots.home })
  check(start === a.root, `picker opens at the computer's home: ${start}`)
  const listed = await a.phone.client.workspace.listDir.query({
    ...target,
    path: start ?? '',
    dirsOnly: true
  })
  check(
    listed.entries.some((e) => e.name === 'work'),
    `lists that computer's folders (${listed.entries.map((e) => e.name).join(', ')})`
  )
  const made = await a.phone.client.workspace.mkdir.mutate({
    ...target,
    path: `${start}${roots.sep}site`
  })
  await a.phone.client.workspace.setProjectPath.mutate({ ...target, path: made.path })
  const afterSet = await foldersA()
  check(
    afterSet[0]?.placement?.path === made.path && afterSet[0].placement.status === 'ready',
    `set the folder there: ${afterSet[0]?.placement?.path} (${afterSet[0]?.placement?.status})`
  )

  const outside = path.join(dir, 'outside')
  mkdirSync(outside, { recursive: true })
  const refused = await a.phone.client.workspace.setProjectPath
    .mutate({ ...target, path: outside })
    .then(() => 'accepted', messageOf)
  check(
    /outside the folders this computer allows/.test(refused),
    `a folder outside the computer's roots is refused: ${refused}`
  )
  check((await foldersA())[0]?.placement?.path === made.path, 'the refused folder records nothing')

  await a.phone.client.workspace.forgetProjectPath.mutate(target)
  check((await foldersA())[0]?.placement === null, 'removed the folder (the computer row stays)')

  await a.phone.client.computers.setProjectDefaultComputer.mutate({
    projectId: a.projectId,
    computerId: null
  })
  check((await projectA()).default_computer_id === null, 'default computer: Local (none)')
  await a.phone.client.computers.setProjectDefaultComputer.mutate({
    projectId: a.projectId,
    computerId: computerA.id
  })
  check((await projectA()).default_computer_id === computerA.id, 'default computer: back to it')

  // 5. A task's computer, through the owner client: only the owning hub changes.
  const resolved = (hubId: string): ResolvedHub | null => {
    const hub = hubs.find((h) => h.phone.entry.id === hubId)
    return hub ? ({ ws: { client: hub.phone.client } } as unknown as ResolvedHub) : null
  }
  let changedOnB = 0
  const changes = b.phone.client.notify.onTasksChanged.subscribe(undefined, {
    onData: () => {
      changedOnB++
    }
  })
  await new Promise((r) => setTimeout(r, 300))
  await ownerClient(resolved, b.phone.entry.id).computers.setTaskComputer.mutate({
    taskId: b.taskId,
    computerId: computerB.id
  })
  const taskB = (await board(b)).tasks.find((t) => t.id === b.taskId)
  check(taskB?.computer_id === computerB.id, 'task moved on its own hub (b)')
  await until('hub b says its tasks changed', () => changedOnB > 0, 10_000)
  check(changedOnB > 0, `hub b pushed onTasksChanged (${changedOnB})`)
  changes.unsubscribe()
  const wrongHub = await ownerClient(resolved, a.phone.entry.id)
    .computers.setTaskComputer.mutate({ taskId: b.taskId, computerId: computerB.id })
    .then(() => 'accepted', messageOf)
  check(wrongHub !== 'accepted', `the same write on hub a is refused: ${wrongHub}`)
  let unknown = ''
  try {
    ownerClient(resolved, 'hub:wss://nowhere.example/trpc')
  } catch (err) {
    unknown = messageOf(err)
  }
  check(/not signed in/.test(unknown), `an unknown hub throws: ${unknown}`)

  // 6. Computers live: stop hub a's computer → onStatusChange → the list says offline.
  let pushed = false
  const statusSub = a.phone.client.computers.onStatusChange.subscribe(undefined, {
    onData: (e) => {
      if (e.computerId === computerA.id && !e.connected) pushed = true
    }
  })
  await new Promise((r) => setTimeout(r, 300))
  a.stopComputer()
  await until('hub a pushes the computer offline', () => pushed, 30_000)
  check(pushed, 'hub a pushed computers.onStatusChange (disconnected)')
  const [offline] = await computersOf(a)
  check(
    offline?.usable === false && computerStatus(offline).label.startsWith('Offline · last seen'),
    `hub a's computer now: ${offline ? computerStatus(offline).label : 'missing'}`
  )
  statusSub.unsubscribe()

  // 7. Who is signed in on each hub: the account of a bearer, as the hubs screen asks.
  for (const hub of hubs) {
    const baseUrl = hubUrlFromAddr(hub.phone.entry.label, 'http')
    const signed = await signInWithPassword(nodeHubTransport, baseUrl, {
      email: hub.email,
      password: hub.password
    })
    const email = signed.ok
      ? await fetchSessionEmail(nodeHubTransport, baseUrl, signed.token)
      : null
    check(email === hub.email, `signed in on ${hub.phone.entry.label} as ${email}`)
  }

  // 8. Removing hub b: its client goes; hub a's rows stay, and hub a still answers.
  b.phone.close()
  const remaining = mergeHubProjects([feedOf(a, await board(a))])
  check(
    remaining.length === 1 && remaining[0].hub.id === a.phone.entry.id,
    "after removing hub b only hub a's projects are listed"
  )
  a.phone.close()
} catch (err) {
  fail(err)
}
finish()
