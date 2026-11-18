import { afterAll, expect, test } from 'vitest'
import { runWithSecurityContext } from '@slayzone/platform/security-log'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { ChatControlForbiddenError, createChatControlAuthorizer } from './chat-control-authority'

const h = await createTestHarness()
afterAll(() => h.cleanup())
const OWNER = 'user-owner',
  EDITOR = 'user-editor',
  STRANGER = 'user-stranger'
h.db.exec(`INSERT INTO projects (id, name, color, owner_user_id) VALUES ('p', 'P', '#000', '${OWNER}');
  INSERT INTO project_members (project_id, user_id, role) VALUES ('p', '${EDITOR}', 'edit');
  INSERT INTO tasks (id, project_id, title, created_by_user_id, visibility) VALUES ('task', 'p', 'T', '${OWNER}', 'project');
  INSERT INTO terminal_tabs (id, task_id, mode, position, owner_user_id) VALUES ('tab', 'task', 'claude-chat', 0, '${OWNER}');
  INSERT INTO terminal_tabs (id, task_id, mode, position, owner_user_id) VALUES ('tab-editor', 'task', 'claude-chat', 1, '${EDITOR}')`)

const owner = (tabId: string) => ({
  id: 'c',
  taskId: 'task',
  tabId,
  mode: 'claude-chat',
  epoch: 1,
  computerId: 'pc',
  state: 'active' as const
})
const loginHub = createChatControlAuthorizer(h.slayDb, () => true)
const as = (actor: string | null, work: () => Promise<void>) =>
  runWithSecurityContext({ actor, ip: null, route: 'PATCH /api/tasks/task' }, work)

test('login hub: the tab owner may control its chat', async () => {
  await expect(as(OWNER, () => loginHub(owner('tab') as never))).resolves.toBeUndefined()
})

test('login hub: a stranger is refused (no confused deputy)', async () => {
  await expect(as(STRANGER, () => loginHub(owner('tab') as never))).rejects.toBeInstanceOf(
    ChatControlForbiddenError
  )
})

test("login hub: a task editor may not control another user's tab (computer side, never shared)", async () => {
  await expect(as(EDITOR, () => loginHub(owner('tab') as never))).rejects.toBeInstanceOf(
    ChatControlForbiddenError
  )
  await expect(as(EDITOR, () => loginHub(owner('tab-editor') as never))).resolves.toBeUndefined()
})

test('login hub: a tab row already gone falls back to the task owner', async () => {
  await expect(as(OWNER, () => loginHub(owner('gone') as never))).resolves.toBeUndefined()
  await expect(as(EDITOR, () => loginHub(owner('gone') as never))).rejects.toBeInstanceOf(
    ChatControlForbiddenError
  )
})

test("the hub's own work (no context, or actor null) is allowed", async () => {
  await expect(loginHub(owner('tab') as never)).resolves.toBeUndefined()
  await expect(as(null, () => loginHub(owner('tab') as never))).resolves.toBeUndefined()
})

test('a hub without login allows every caller', async () => {
  const open = createChatControlAuthorizer(h.slayDb, () => false)
  await expect(as(STRANGER, () => open(owner('tab') as never))).resolves.toBeUndefined()
})
