import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { chromium, test, expect, type Browser, type Page } from '@playwright/test'
import { scrubbedEnv, until } from '../fixtures/web-shell-computer'

/**
 * T-100 sharing, through the real UI: two people on one login hub, each in their own
 * browser. The owner adds the second person to a project as View in Project Settings →
 * Members; that person then sees the project's tasks, gets the read-only agent pane,
 * and loses a task live the moment the owner makes it private.
 *
 * Sharing reaches project members only: the task "Add person" picker lists the
 * project's people and nobody else on the hub, and a file of a private task shared
 * with a member on its own shows under the sidebar's Shared button — never its task.
 *
 * The access rules themselves (roles × kinds × grants) are covered by unit tests on a
 * real hub (`apps/hub/src/sharing.test.ts`); this proves the screens reach them.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'hub')
const HUB_BIN = path.join(HUB_DIR, 'dist', 'bin.cjs')
const WEB_INDEX = path.join(HUB_DIR, 'dist', 'web', 'index.html')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

interface Owner {
  email: string
  password: string
  token: string
}

interface Hub {
  base: string
  root: string
  owner: Owner
  /** Everything the hub has written so far (its security log included). */
  output: () => string
  stop: () => Promise<void>
}

async function spawnLoginHub(): Promise<Hub> {
  if (!fs.existsSync(HUB_BIN) || !fs.existsSync(WEB_INDEX)) {
    throw new Error(`hub or web shell not built (${HUB_BIN}, ${WEB_INDEX}): run pnpm build`)
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-web-shell-sharing-'))
  const port = await freePort()
  const proc: ChildProcess = spawn(require('electron') as unknown as string, [HUB_BIN], {
    env: {
      ...scrubbedEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      PLAYWRIGHT: '1',
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_LISTEN_ADDRESS: `127.0.0.1:${port}`,
      SLAYZONE_HUB_REQUIRE_LOGIN: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let output = ''
  proc.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  const stop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      const t = setTimeout(() => proc.kill('SIGKILL'), 3_000)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      proc.kill('SIGTERM')
    })
  const base = `http://127.0.0.1:${port}`
  try {
    await until(async () => ((await fetch(`${base}/health`)).ok ? true : null), 'hub /health')
    const owner = await until<Owner>(() => {
      const o = JSON.parse(fs.readFileSync(path.join(root, 'hub.owner.json'), 'utf8')) as Owner
      return o.token && o.email && o.password ? o : null
    }, 'bootstrap owner')
    return { base, root, owner, output: () => output, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

/** POST as the owner (the hub's admin); the response's `data`. */
async function postAsOwner<T>(hub: Hub, url: string, body: unknown): Promise<T> {
  const r = await fetch(`${hub.base}${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${hub.owner.token}`
    },
    body: JSON.stringify(body)
  })
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`)
  return ((await r.json()) as { data: T }).data
}

/** One SQL statement on the hub (E2E-gated dev endpoint); its `result`. */
async function devSql<T>(
  hub: Hub,
  method: 'get' | 'run',
  sql: string,
  params: unknown[] = []
): Promise<T> {
  const r = await fetch(`${hub.base}/api/dev/sql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${hub.owner.token}`
    },
    body: JSON.stringify({ sql, params, method })
  })
  const body = (await r.json()) as { ok: boolean; result: T; error?: string }
  if (!body.ok) throw new Error(`dev sql: ${body.error}`)
  return body.result
}

async function signIn(page: Page, hub: Hub, email: string, password: string): Promise<void> {
  await page.goto(`${hub.base}/`)
  await page.getByTestId('web-login-email').fill(email)
  await page.getByTestId('web-login-password').fill(password)
  await Promise.all([
    page.waitForEvent('framenavigated'),
    page.getByTestId('web-login-submit').click()
  ])
  await expect(page.getByTestId('web-login-screen')).toHaveCount(0, { timeout: 30_000 })
}

test.describe('web shell sharing — two people, one login hub', () => {
  let hub: Hub
  let browser: Browser

  test.beforeAll(async () => {
    hub = await spawnLoginHub()
    browser = await chromium.launch()
  })

  test.afterAll(async () => {
    await browser?.close()
    await hub?.stop()
    if (hub) fs.rmSync(hub.root, { recursive: true, force: true })
  })

  test('a View member sees the project, may only view, and loses a task made private', async () => {
    test.setTimeout(120_000)
    await postAsOwner(hub, '/api/dev/sql', {
      sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', 'true')",
      method: 'run'
    })
    const project = await postAsOwner<{ id: string }>(hub, '/api/projects', {
      name: 'Shared Project'
    })
    await postAsOwner(hub, '/api/tasks', { projectId: project.id, title: 'Open Task' })
    await postAsOwner(hub, '/api/tasks', { projectId: project.id, title: 'Secret Task' })
    const member = await postAsOwner<{ id: string; password: string }>(hub, '/api/hub/users', {
      email: 'member@example.com'
    })

    const ownerContext = await browser.newContext()
    const memberContext = await browser.newContext()
    try {
      const ownerPage = await ownerContext.newPage()
      const memberPage = await memberContext.newPage()

      // Before any sharing the member's hub is empty.
      await signIn(memberPage, hub, 'member@example.com', member.password)
      await expect(memberPage.getByText('Click + in sidebar to create a project')).toBeVisible({
        timeout: 30_000
      })

      // The owner adds the member as View in Project Settings → Members.
      await signIn(ownerPage, hub, hub.owner.email, hub.owner.password)
      await expect(ownerPage.getByText('Secret Task').first()).toBeVisible({ timeout: 30_000 })
      // The project's page in the full-window Settings view.
      const dialog = ownerPage.getByTestId('settings-project-page')
      await ownerPage
        .locator('[data-slot="sidebar"]')
        .first()
        .getByRole('button', { name: 'SH', exact: true })
        .last()
        .click({ button: 'right' })
      await ownerPage.getByRole('menuitem', { name: 'Settings', exact: true }).click()
      await dialog.getByTestId('project-settings-tab-members').click()
      await expect(dialog.getByTestId('project-members-tab')).toBeVisible()
      // Page-level test ids: an open Select hides the page from role queries.
      const person = ownerPage.getByTestId('project-member-picker-person')
      await expect(async () => {
        if (!(await ownerPage.getByRole('listbox').isVisible())) await person.click()
        await ownerPage
          .getByRole('option', { name: /member@example\.com/ })
          .click({ timeout: 2_000 })
        await expect(person).toContainText('member@example.com', { timeout: 2_000 })
      }).toPass({ timeout: 15_000 })
      await expect(ownerPage.getByTestId('project-member-picker-role')).toContainText('Can view')
      await ownerPage.getByTestId('project-member-picker-add').click()
      await expect(dialog.getByTestId(`project-member-${member.id}`)).toBeVisible()
      await ownerPage.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)

      // The member gets the project live, with both tasks.
      await expect(memberPage.getByText('Open Task').first()).toBeVisible({ timeout: 20_000 })
      await expect(memberPage.getByText('Secret Task').first()).toBeVisible()

      // The owner makes one task private: it leaves the member's board live.
      await ownerPage.getByText('Secret Task').first().click()
      const visibility = ownerPage.getByTestId('task-visibility').filter({ visible: true })
      await visibility.click({ timeout: 20_000 })
      await ownerPage.getByRole('option', { name: /^Private/ }).click()
      await expect(visibility).toContainText('Private')
      await expect(memberPage.getByText('Secret Task')).toHaveCount(0, { timeout: 20_000 })
      await expect(memberPage.getByText('Open Task').first()).toBeVisible()

      // On the board the task is view only too: its menu offers copying, nothing else.
      await memberPage.getByText('Open Task').first().click({ button: 'right' })
      await expect(memberPage.getByTestId('task-context-menu-view-only')).toBeVisible()
      await memberPage.keyboard.press('Escape')

      // View only: the task opens, but the agent pane offers nothing to run.
      await memberPage.getByText('Open Task').first().click()
      await expect(
        memberPage.getByTestId('agent-pane-not-yours').filter({ visible: true })
      ).toBeVisible({ timeout: 20_000 })
      await expect(memberPage.getByText('You can view this task').first()).toBeVisible()
      // …and the task itself reads as view only: nothing on it offers an edit.
      await expect(memberPage.getByTestId('task-view-only').filter({ visible: true })).toBeVisible()
      await expect(
        memberPage
          .getByTestId('task-description-editor')
          .filter({ visible: true })
          .locator('[contenteditable]')
          .first()
      ).toHaveAttribute('contenteditable', 'false')
      await expect(
        memberPage
          .getByTestId('task-project-field')
          .filter({ visible: true })
          .getByRole('combobox')
          .first()
      ).toBeDisabled()
      // The owner's own task page has no such limits.
      await expect(ownerPage.getByTestId('task-view-only')).toHaveCount(0)
      // Opening it wrote nothing the member may not write: the hub refused no call of
      // theirs for want of a role (each would be an error toast).
      await memberPage.waitForTimeout(1_500)
      const refused = hub
        .output()
        .split('\n')
        .filter((line) => line.includes('"authz.denied"') && line.includes('insufficient_role'))
      expect(refused).toEqual([])
    } finally {
      await ownerContext.close()
      await memberContext.close()
    }
  })

  test('only project people can be invited; a file shared on its own shows under Shared', async () => {
    test.setTimeout(120_000)
    await devSql(
      hub,
      'run',
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', 'true')"
    )
    const project = await postAsOwner<{ id: string }>(hub, '/api/projects', {
      name: 'Members Only'
    })
    const task = await postAsOwner<{ id: string }>(hub, '/api/tasks', {
      projectId: project.id,
      title: 'Private Plan'
    })
    const reader = await postAsOwner<{ id: string; password: string }>(hub, '/api/hub/users', {
      email: 'reader@example.com'
    })
    await postAsOwner(hub, '/api/hub/users', { email: 'outsider@example.com' })
    const { owner } = await devSql<{ owner: string }>(
      hub,
      'get',
      'SELECT owner_user_id AS owner FROM projects WHERE id = ?',
      [project.id]
    )
    // The task is private to the owner; the reader is a View member of the project and
    // was given one of its files on its own.
    await devSql(
      hub,
      'run',
      "UPDATE tasks SET visibility = 'private', created_by_user_id = ? WHERE id = ?",
      [owner, task.id]
    )
    await devSql(
      hub,
      'run',
      "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'view')",
      [project.id, reader.id]
    )
    await devSql(
      hub,
      'run',
      "INSERT INTO task_artifacts (id, task_id, title) VALUES ('art_shared_alone', ?, 'plan.md')",
      [task.id]
    )
    await devSql(
      hub,
      'run',
      "INSERT INTO artifact_grants (artifact_id, user_id, role, added_by) VALUES ('art_shared_alone', ?, 'view', ?)",
      [reader.id, owner]
    )

    const ownerContext = await browser.newContext()
    const readerContext = await browser.newContext()
    try {
      // The owner's picker on the private task: the project's people, not the hub's.
      const ownerPage = await ownerContext.newPage()
      await signIn(ownerPage, hub, hub.owner.email, hub.owner.password)
      // The owner was last on the first test's project: open this one.
      await ownerPage
        .locator('[data-slot="sidebar"]')
        .first()
        .getByRole('button', { name: 'ME', exact: true })
        .last()
        .click({ timeout: 30_000 })
      await ownerPage.getByText('Private Plan').first().click({ timeout: 30_000 })
      await ownerPage.getByTestId('task-add-person').filter({ visible: true }).click()
      const addDialog = ownerPage.getByTestId('task-add-person-dialog')
      await expect(addDialog).toContainText('Only people in the project can be added')
      await ownerPage.getByTestId('task-add-person-person').click()
      await expect(ownerPage.getByRole('option', { name: /reader@example\.com/ })).toBeVisible()
      await expect(ownerPage.getByRole('option', { name: /outsider@example\.com/ })).toHaveCount(0)
      await expect(ownerPage.getByRole('option', { name: /member@example\.com/ })).toHaveCount(0)
      await ownerPage.keyboard.press('Escape')

      // The reader: the project, but not the private task — the file under Shared.
      const readerPage = await readerContext.newPage()
      await signIn(readerPage, hub, 'reader@example.com', reader.password)
      const shared = readerPage.getByTestId('shared-artifacts-button')
      await expect(shared).toBeVisible({ timeout: 30_000 })
      await expect(readerPage.getByTestId('shared-artifacts-count')).toHaveText('1')
      await expect(readerPage.getByText('Private Plan')).toHaveCount(0)
      await shared.click()
      const popover = readerPage.getByTestId('shared-artifacts-popover')
      await expect(popover).toContainText('plan.md')
      await expect(popover).toContainText('View only')
      await expect(popover.getByTestId('shared-artifact-new')).toBeVisible()
      await popover.getByTestId('shared-artifact-art_shared_alone').click()
      const viewer = readerPage.getByTestId('shared-artifact-dialog')
      await expect(viewer).toContainText('plan.md')
      await readerPage.keyboard.press('Escape')
      await expect(viewer).toHaveCount(0)
      // Opened: no longer new.
      await shared.click()
      await expect(popover).toContainText('plan.md')
      await expect(popover.getByTestId('shared-artifact-new')).toHaveCount(0, { timeout: 10_000 })
      // Still no way into the task.
      await expect(readerPage.getByText('Private Plan')).toHaveCount(0)
    } finally {
      await ownerContext.close()
      await readerContext.close()
    }
  })
})
