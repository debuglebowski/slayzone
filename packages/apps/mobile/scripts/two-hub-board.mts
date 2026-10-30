/**
 * The phone's board code against two real hubs at once — the check no jest suite can
 * make. Not run by any test suite.
 *
 *   pnpm --filter @slayzone/hub build && pnpm --filter @slayzone/computer build
 *   pnpm exec tsx packages/apps/mobile/scripts/two-hub-board.mts   # repo root
 *
 * Boots hubs a (127.0.0.1:47951) and b (:47952), each with a computer and a project
 * (`test-hub.mts`); hub b's project holds top-level tasks, a subtask and an archived task
 * in one status. With the app's own modules (`board/board-model.ts`, `board/moves.ts`,
 * `board/send-move.ts`, `hub-board.ts`'s `ownerClient`, `board/task-search.ts`):
 * - a drag within a column (last visible row to the top): the full ordered list goes to hub b, which reorders exactly
 *   that; the board read back shows the drop where it was made, the hidden rows (subtask,
 *   archived) keep their place relative to the rest, and hub b says its tasks changed;
 * - a swipe (status change): the status only, the order kept;
 * - a drag to another column before a row: status + that column's full list;
 * - hub a untouched by any of it (its board identical before and after);
 * - task search over both hubs' boards finds titles and descriptions, each on its hub.
 */
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import type { ResolvedHub } from '@slayzone/transport/client'
import { NO_AGENT_SESSIONS } from '../src/agents/hub-agents.ts'
import { DEFAULT_BOARD_FILTER, boardColumns } from '../src/board/board-model.ts'
import { planDrop, planStatusChange } from '../src/board/moves.ts'
import { sendMovePlan } from '../src/board/send-move.ts'
import { searchTasks } from '../src/board/task-search.ts'
import { type BoardData, type HubFeed, ownerClient } from '../src/hub-board.ts'
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

// The hubs' ports: the first two arguments, else 47951 and 47952.
const PORTS = [Number(process.argv[2] ?? 47951), Number(process.argv[3] ?? 47952)]

const dir = freshStateDir('two-hub-board')

interface Hub {
  phone: PhoneHub
  projectId: string
}

const feedOf = (hub: Hub, board: BoardData): HubFeed => ({
  hub: hub.phone.entry,
  connection: { status: 'open', error: null },
  stalled: false,
  board: { data: board, pending: false, error: null, refreshing: false },
  agents: NO_AGENT_SESSIONS
})

try {
  const hubs: Hub[] = []
  for (const [i, name] of ['a', 'b'].entries()) {
    const hubDir = path.join(dir, name)
    const home = path.join(hubDir, 'home')
    const work = path.join(home, 'work')
    mkdirSync(work, { recursive: true })
    const hub = await startTestHub({ name: `mobile-board-${name}`, port: PORTS[i], dir: hubDir })
    const account = await hub.createUser(`mobile@board-${name}.test`)
    hub.startComputer({ forUser: account.email, allowedRoot: home })
    const phone = await signInPhone(hub.address, account)
    const project = await createProject(phone.client, {
      name: 'Board',
      color: name === 'a' ? '#8b5cf6' : '#10b981',
      path: work
    })
    hubs.push({ phone, projectId: project.id })
  }
  const [a, b] = hubs
  const board = (hub: Hub): Promise<BoardData> => hub.phone.client.task.loadBoardData.query()
  const create = (hub: Hub, title: string, extra: Record<string, unknown> = {}) =>
    hub.phone.client.task.create.mutate({
      projectId: hub.projectId,
      title,
      status: 'todo',
      terminalMode: 'terminal',
      ...extra
    } as never) as Promise<{ id: string }>

  // Hub a: one task (same title as one on b). Hub b: one, two, three (top level), a
  // subtask of one, an archived task — all "todo"; one in "in_progress".
  await create(a, 'one')
  const one = await create(b, 'one', { description: 'The launch checklist' })
  const two = await create(b, 'two')
  await create(b, 'three')
  const sub = await create(b, 'one child', { parentId: one.id })
  const old = await create(b, 'archived')
  await b.phone.client.task.archive.mutate({ id: old.id })
  const doing = await create(b, 'doing', { status: 'in_progress' })
  const aBefore = JSON.stringify((await board(a)).tasks.map((t) => [t.id, t.status, t.order]))

  const resolve = (hubId: string): ResolvedHub | null => {
    const hub = hubs.find((h) => h.phone.entry.id === hubId)
    return hub ? ({ ws: { client: hub.phone.client } } as unknown as ResolvedHub) : null
  }
  const projectOf = (data: BoardData) => {
    const project = data.projects.find((p) => p?.id === b.projectId)
    if (!project) throw new Error('hub b lost its project')
    return project
  }
  const column = (data: BoardData, status: string): string[] =>
    boardColumns(data, projectOf(data), DEFAULT_BOARD_FILTER)
      .find((c) => c.id === status)
      ?.tasks.map((t) => t.id) ?? []
  /** The project's full "todo" order as the hub keeps it (board order). */
  const fullTodo = (data: BoardData): string[] =>
    data.tasks.filter((t) => t.project_id === b.projectId && t.status === 'todo').map((t) => t.id)

  // Hub b says its tasks changed (what reloads the app's board).
  let changed = 0
  const sub$ = b.phone.client.notify.onTasksChanged.subscribe(undefined, {
    onData: () => void changed++
  })

  let data = await board(b)
  const visibleTodo = column(data, 'todo')
  check(
    !visibleTodo.includes(sub.id) && !visibleTodo.includes(old.id) && visibleTodo.length === 3,
    `todo column shows the 3 top-level tasks, hides subtask + archived (${visibleTodo.length})`
  )
  const fullBefore = fullTodo(data)
  check(fullBefore.length === 5, `hub's todo set counts 5 rows incl. hidden (${fullBefore.length})`)

  // 1. Drag the last visible row above the first (new tasks land on top: board order is
  // the hub's, whatever it is).
  const firstVisible = visibleTodo[0]
  const moved = visibleTodo[visibleTodo.length - 1]
  const drag = planDrop(
    data,
    b.projectId,
    { taskId: moved, fromColumn: 'todo', toColumn: 'todo', beforeTaskId: firstVisible },
    visibleTodo
  )
  if (!drag?.reorder) throw new Error('no reorder planned')
  check(
    drag.reorder.length === 5,
    'the reorder sent is the FULL list (5 ids, hidden rows included)'
  )
  await sendMovePlan(ownerClient(resolve, b.phone.entry.id), drag)
  data = await board(b)
  check(
    column(data, 'todo')[0] === moved,
    'read back: the dragged task is first in the todo column'
  )
  check(
    JSON.stringify(fullTodo(data)) === JSON.stringify(drag.reorder),
    "read back: the hub's full todo order is exactly the list sent"
  )
  const hiddenOrder = (ids: string[]) => ids.filter((id) => id === sub.id || id === old.id)
  check(
    JSON.stringify(hiddenOrder(fullTodo(data))) === JSON.stringify(hiddenOrder(fullBefore)),
    'hidden rows keep their relative order'
  )
  await until('hub b says its tasks changed', () => (changed > 0 ? true : null), 10_000)
  check(changed > 0, `hub b pushed onTasksChanged (${changed})`)

  // 2. Swipe "two" to in_progress: the status only.
  const orderOfTwo = data.tasks.find((t) => t.id === two.id)?.order
  const swipe = planStatusChange(two.id, 'in_progress')
  check(swipe.reorder === null, 'a swipe sends no reorder')
  await sendMovePlan(ownerClient(resolve, b.phone.entry.id), swipe)
  data = await board(b)
  const twoRow = data.tasks.find((t) => t.id === two.id)
  check(twoRow?.status === 'in_progress', 'read back: "two" is in progress')
  check(twoRow?.order === orderOfTwo, 'read back: its order unchanged')

  // 3. Drag "one" to in_progress, before "doing".
  const inProgress = column(data, 'in_progress')
  const cross = planDrop(
    data,
    b.projectId,
    { taskId: one.id, fromColumn: 'todo', toColumn: 'in_progress', beforeTaskId: doing.id },
    inProgress
  )
  if (!cross) throw new Error('no cross-column plan')
  check(cross.update?.status === 'in_progress', 'cross-column drop updates the status')
  await sendMovePlan(ownerClient(resolve, b.phone.entry.id), cross)
  data = await board(b)
  const after = column(data, 'in_progress')
  check(
    after.indexOf(one.id) === after.indexOf(doing.id) - 1,
    `read back: "one" right before "doing" (${after.join(',')})`
  )
  check(
    data.tasks.find((t) => t.id === sub.id)?.parent_id === one.id,
    "the subtask stays its parent's (status moves never reparent)"
  )

  // 4. Hub a untouched.
  const aAfter = JSON.stringify((await board(a)).tasks.map((t) => [t.id, t.status, t.order]))
  check(aAfter === aBefore, 'hub a: board identical before and after')

  // 5. Task search over both hubs.
  const feeds = [feedOf(a, await board(a)), feedOf(b, data)]
  const byTitle = searchTasks(feeds, 'one')
  check(
    byTitle.some((r) => r.hubId === a.phone.entry.id) &&
      byTitle.some((r) => r.hubId === b.phone.entry.id && r.task.id === one.id),
    `search "one": a hit on each hub (${byTitle.length})`
  )
  const byDescription = searchTasks(feeds, 'launch checklist')
  check(
    byDescription.length === 1 &&
      byDescription[0].task.id === one.id &&
      byDescription[0].matchedIn === 'description',
    'search finds a description, on hub b'
  )

  sub$.unsubscribe()
  for (const hub of hubs) hub.phone.close()
} catch (err) {
  fail(err)
}
finish()
