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
 * | 'Skills' | 'MCPs'. Scopes to the level group (which contains both the level
 * label and its section buttons) to disambiguate the duplicated section names.
 */
export async function gotoContextSection(
  mainWindow: Page,
  level: 'Computer' | 'Project' | 'Library',
  section: 'Files' | 'Instructions' | 'Skills' | 'MCPs'
): Promise<void> {
  const group = mainWindow
    .locator('div')
    .filter({ hasText: level })
    .filter({ has: mainWindow.getByRole('button', { name: section, exact: true }) })
    .last()
  await expect(group.getByRole('button', { name: section, exact: true })).toBeVisible({
    timeout: 10_000
  })
  await group.getByRole('button', { name: section, exact: true }).click()
}

export async function openProjectContextManager(
  mainWindow: Page,
  projectAbbrev: string
): Promise<Locator> {
  await closeTopDialog(mainWindow)
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

export async function openSkillSyncPanel(dialog: Locator, slug: string): Promise<void> {
  const skillRow = dialog.getByTestId(`project-context-item-skill-${slug}`)
  await expect(skillRow).toBeVisible({ timeout: 5_000 })
  const syncSection = dialog.getByTestId(`skill-sync-section-${slug}`)
  if (!(await syncSection.isVisible().catch(() => false))) {
    await skillRow.click()
  }
  await expect(syncSection).toBeVisible({ timeout: 5_000 })
}

export async function openSkillEditPanel(dialog: Locator, slug: string): Promise<void> {
  const skillRow = dialog.getByTestId(`project-context-item-skill-${slug}`)
  await expect(skillRow).toBeVisible({ timeout: 5_000 })
  const editSection = dialog.getByTestId(`skill-edit-section-${slug}`)
  if (!(await editSection.isVisible().catch(() => false))) {
    await skillRow.click()
  }
  await expect(editSection).toBeVisible({ timeout: 5_000 })
}
