import { expect, type Locator, type Page } from '@playwright/test'
import { goHome } from './electron'

type ProjectSection = 'providers' | 'instructions' | 'skills' | 'mcp'

export async function closeTopDialog(mainWindow: Page): Promise<void> {
  const openDialogs = mainWindow.locator(
    '[role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"]'
  )
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await openDialogs.count()) === 0) return

    const top = openDialogs.last()
    const closeButton = top.getByRole('button', { name: /close|cancel|done|skip/i }).first()
    if (await closeButton.count()) {
      await closeButton.click({ force: true }).catch(() => {})
    } else {
      await top.press('Escape').catch(() => {})
      await mainWindow.keyboard.press('Escape').catch(() => {})
    }
    await mainWindow.waitForTimeout(150)
  }
  await expect(openDialogs).toHaveCount(0, { timeout: 5_000 })
}

export async function openUserContextManager(
  mainWindow: Page,
  // electronApp kept for call-site compatibility; no longer needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _electronApp?: any
): Promise<Locator> {
  // The Context Manager moved out of User Settings into a top-level tab-bar view
  // (tabStore activeView === 'context'). Drive the exposed store directly
  // instead of the obsolete Settings-dialog path.
  await closeTopDialog(mainWindow)
  await goHome(mainWindow)
  // Leave the CM view first so the next open remounts it — sections load their
  // data on mount, and tests routinely mutate state via tRPC between opens.
  await mainWindow.evaluate(() => {
    const store = (
      window as unknown as {
        __slayzone_tabStore?: { getState: () => { setActiveView: (v: string) => void } }
      }
    ).__slayzone_tabStore
    if (!store) throw new Error('__slayzone_tabStore not exposed')
    store.getState().setActiveView('tabs')
  })
  await expect(mainWindow.getByRole('heading', { name: 'Context Manager' })).toBeHidden({
    timeout: 5_000
  })
  await mainWindow.evaluate(() => {
    const store = (
      window as unknown as {
        __slayzone_tabStore?: { getState: () => { setActiveView: (v: string) => void } }
      }
    ).__slayzone_tabStore
    if (!store) throw new Error('__slayzone_tabStore not exposed')
    store.getState().setActiveView('context')
  })
  await expect(mainWindow.getByRole('heading', { name: 'Context Manager' })).toBeVisible({
    timeout: 10_000
  })
  // CM is a full-screen view, not a dialog; testids are unique, so scope to body.
  // The redesigned CM opens straight to its sidebar (COMPUTER/PROJECT/...); each
  // caller navigates to the section it needs.
  return mainWindow.locator('body')
}

/**
 * Navigate the redesigned Context Manager sidebar to a given level + section.
 * Levels: 'Computer' | 'Project' | 'Library'. Sections: 'Files' | 'Instructions'
 * | 'Skills' | 'MCPs'.
 *
 * Section names repeat across levels (Project and Library both list
 * Instructions/Skills/MCPs), and the Project → Skills button grows a stale-count
 * dot (`title="N stale"`) that CHANGES its accessible name — so never match
 * buttons by exact name. Instead index the sidebar's section buttons by level
 * order (Project first, Library second) with substring name matching, and verify
 * arrival via the content header ('<Level> — <Section>').
 */
export async function gotoContextSection(
  mainWindow: Page,
  level: 'Computer' | 'Project' | 'Library',
  section: 'Files' | 'Instructions' | 'Skills' | 'MCPs'
): Promise<void> {
  const nav = mainWindow
    .locator('nav')
    .filter({ has: mainWindow.getByRole('heading', { name: 'Context Manager' }) })
  // Non-exact name = case-insensitive substring — immune to the stale-dot title
  // being appended to the Project button's accessible name.
  const buttons = nav.getByRole('button', { name: section })
  const index = level === 'Library' ? 1 : 0
  const button = buttons.nth(index)
  await expect(button).toBeVisible({ timeout: 10_000 })
  await button.click()
  await expect(mainWindow.getByRole('heading', { name: `${level} — ${section}` })).toBeVisible({
    timeout: 10_000
  })
}

export async function openProjectContextManager(
  mainWindow: Page,
  projectAbbrev: string
): Promise<Locator> {
  await closeTopDialog(mainWindow)
  // Leave the CM view first so the next open remounts it — sections load their
  // data on mount, and tests routinely mutate state via tRPC between opens.
  await mainWindow.evaluate(() => {
    const store = (
      window as unknown as {
        __slayzone_tabStore?: { getState: () => { setActiveView: (v: string) => void } }
      }
    ).__slayzone_tabStore
    if (!store) throw new Error('__slayzone_tabStore not exposed')
    store.getState().setActiveView('tabs')
  })
  await expect(mainWindow.getByRole('heading', { name: 'Context Manager' })).toBeHidden({
    timeout: 5_000
  })
  // Select the project (enables the CM's Project level) then open the CM view.
  await mainWindow.evaluate(async (abbrev) => {
    const projects = await window.getTrpcVanillaClient().projects.list.query()
    const match = projects.find((p) => p.name.slice(0, 2).toUpperCase() === abbrev)
    if (!match) throw new Error(`No project found for abbrev ${abbrev}`)
    const store = (
      window as unknown as {
        __slayzone_tabStore?: {
          getState: () => {
            selectProject: (id: string) => void
            setActiveView: (v: string) => void
          }
        }
      }
    ).__slayzone_tabStore
    if (!store) throw new Error('__slayzone_tabStore not exposed')
    store.getState().selectProject(match.id)
    store.getState().setActiveView('context')
  }, projectAbbrev)
  await expect(mainWindow.getByRole('heading', { name: 'Context Manager' })).toBeVisible({
    timeout: 10_000
  })
  return mainWindow.locator('body')
}

// The redesigned CM Project level exposes Instructions / Skills / MCPs. The old
// 'providers' overview card is gone (provider sync lives elsewhere now); callers
// that needed it are migrated individually.
const PROJECT_SECTION_LABELS: Record<ProjectSection, 'Instructions' | 'Skills' | 'MCPs'> = {
  providers: 'Instructions',
  instructions: 'Instructions',
  skills: 'Skills',
  mcp: 'MCPs'
}

export async function openProjectContextSection(
  mainWindow: Page,
  projectAbbrev: string,
  section: ProjectSection
): Promise<Locator> {
  const dialog = await openProjectContextManager(mainWindow, projectAbbrev)
  await gotoContextSection(mainWindow, 'Project', PROJECT_SECTION_LABELS[section])
  return dialog
}

/**
 * Redesigned CM skill rows (SkillListView) open a single ContextItemEditor panel
 * that hosts both editing and sync (stale banner + per-provider actions).
 * `skill-row-<slug>` is on the list row; `context-item-editor-slug` is always
 * rendered in the editor (the content textarea is swapped for a DiffView when a
 * stale provider is auto-selected, so don't wait on it here).
 */
export async function openSkillEditor(body: Locator, slug: string): Promise<void> {
  const row = body.getByTestId(`skill-row-${slug}`)
  await expect(row).toBeVisible({ timeout: 5_000 })
  const editorSlug = body.getByTestId('context-item-editor-slug')
  const openForThisSkill =
    (await editorSlug.isVisible().catch(() => false)) &&
    (await editorSlug.inputValue().catch(() => '')) === slug
  if (!openForThisSkill) {
    await row.click()
  }
  await expect(editorSlug).toBeVisible({ timeout: 5_000 })
}
