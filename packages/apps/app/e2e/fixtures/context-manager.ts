import { expect, type Locator, type Page } from '@playwright/test'
import { clickSettings, goHome, openProjectSettings } from './electron'

type ProjectSection = 'providers' | 'instructions' | 'skills' | 'mcp'

function globalSettingsDialog(mainWindow: Page): Locator {
  return mainWindow.locator('[role="dialog"][aria-label="Settings"]').last()
}

function projectSettingsDialog(mainWindow: Page): Locator {
  return mainWindow
    .getByRole('dialog')
    .filter({ has: mainWindow.getByRole('heading', { name: 'Project Settings' }) })
    .last()
}

export async function closeTopDialog(mainWindow: Page): Promise<void> {
  const openDialogs = mainWindow.locator('[role="dialog"][data-state="open"], [role="dialog"][aria-modal="true"]')
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

async function openSettingsTabWithRetry(
  mainWindow: Page,
  dialog: Locator,
  tabTestId: string,
  readyLocator: Locator
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await readyLocator.isVisible({ timeout: 600 }).catch(() => false)) return
    const tab = dialog.getByTestId(tabTestId).first()
    await tab.click({ force: true }).catch(() => {})
    if (await readyLocator.isVisible({ timeout: 1_200 }).catch(() => false)) return
    await mainWindow.waitForTimeout(120)
  }
  await expect(readyLocator).toBeVisible({ timeout: 5_000 })
}

async function ensureProjectConfigTabSelected(
  mainWindow: Page,
  dialog: Locator,
  options?: { strict?: boolean }
): Promise<boolean> {
  const strict = options?.strict === true
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const configTabById = dialog.getByTestId('project-context-tab-config').first()
    const hasConfigTabById = (await configTabById.count()) > 0
    const fallbackConfigTab = dialog.getByRole('tab', { name: 'Config', exact: true }).first()
    const hasFallbackConfigTab = (await fallbackConfigTab.count()) > 0
    if (!hasConfigTabById && !hasFallbackConfigTab) {
      if (!strict) return false
      await mainWindow.waitForTimeout(120)
      continue
    }
    const configTab = hasConfigTabById ? configTabById : fallbackConfigTab
    const isSelected = await configTab
      .getAttribute('aria-selected', { timeout: 400 })
      .then((value) => value === 'true')
      .catch(() => false)
    if (!isSelected) {
      await configTab.click({ force: true, timeout: 800 }).catch(() => {})
    }
    const selectedNow = await configTab
      .getAttribute('aria-selected', { timeout: 400 })
      .then((value) => value === 'true')
      .catch(() => false)
    if (selectedNow) return true
    await mainWindow.waitForTimeout(120)
  }

  if (!strict) return false

  const finalConfigTabById = dialog.getByTestId('project-context-tab-config').first()
  if ((await finalConfigTabById.count()) > 0) {
    await expect(finalConfigTabById).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 })
    return true
  }
  const finalConfigTab = dialog.getByRole('tab', { name: 'Config', exact: true }).first()
  if ((await finalConfigTab.count()) > 0) {
    await expect(finalConfigTab).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 })
    return true
  }
  return false
}

async function isProjectSectionVisible(dialog: Locator, section: ProjectSection): Promise<boolean> {
  if (section === 'instructions') {
    return dialog.getByTestId('instructions-textarea').isVisible({ timeout: 300 }).catch(() => false)
  }
  if (section === 'skills') {
    if (await dialog.getByTestId('project-context-add-skill').isVisible({ timeout: 300 }).catch(() => false)) return true
    const anySkillRows = dialog.locator('[data-testid^="project-context-item-skill-"], [data-testid^="project-context-item-unmanaged-skill-"]')
    return (await anySkillRows.count()) > 0
  }
  if (section === 'mcp') {
    return dialog.getByText('Add MCP server', { exact: false }).isVisible({ timeout: 300 }).catch(() => false)
  }
  return dialog.getByRole('button', { name: /claude|codex|cursor|gemini|opencode/i }).first().isVisible({ timeout: 300 }).catch(() => false)
}

export async function openGlobalContextManager(mainWindow: Page): Promise<Locator> {
  const dialog = globalSettingsDialog(mainWindow)

  for (let reopenAttempt = 0; reopenAttempt < 2; reopenAttempt += 1) {
    await closeTopDialog(mainWindow)
    await goHome(mainWindow)

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await mainWindow.bringToFront().catch(() => {})
      if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) break

      await clickSettings(mainWindow)
      if (await dialog.isVisible({ timeout: 1_500 }).catch(() => false)) break

      await mainWindow.keyboard.press('Meta+,').catch(() => {})
      if (await dialog.isVisible({ timeout: 1_500 }).catch(() => false)) break

      const sidebarSettingsButton = mainWindow.getByRole('button', { name: 'Settings', exact: true }).first()
      if (await sidebarSettingsButton.isVisible({ timeout: 600 }).catch(() => false)) {
        await sidebarSettingsButton.click({ force: true }).catch(() => {})
        if (await dialog.isVisible({ timeout: 1_500 }).catch(() => false)) break
      }

      await mainWindow.waitForTimeout(150)
    }

    if (await dialog.isVisible({ timeout: 800 }).catch(() => false)) break
  }

  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await openSettingsTabWithRetry(
    mainWindow,
    dialog,
    'settings-tab-ai-config',
    dialog.getByRole('heading', { name: 'Context Manager' })
  )
  const backToOverview = dialog.getByRole('button', { name: 'Overview' })
  if (await backToOverview.count()) {
    await backToOverview.click()
  }
  await expect(dialog.getByTestId('context-overview-providers')).toBeVisible({ timeout: 5_000 })
  return dialog
}

export async function openProjectContextManager(mainWindow: Page, projectAbbrev: string): Promise<Locator> {
  await closeTopDialog(mainWindow)
  const dialog = await openProjectSettings(mainWindow, projectAbbrev)
  await expect(projectSettingsDialog(mainWindow).getByRole('heading', { name: 'Project Settings' })).toBeVisible({ timeout: 5_000 })
  await openSettingsTabWithRetry(
    mainWindow,
    dialog,
    'settings-tab-ai-config',
    dialog.getByRole('heading', { name: 'Context Manager' })
  )
  await ensureProjectConfigTabSelected(mainWindow, dialog, { strict: true })
  return dialog
}

export async function openProjectContextSection(
  mainWindow: Page,
  projectAbbrev: string,
  section: ProjectSection
): Promise<Locator> {
  const sectionTestIdMap: Record<ProjectSection, string> = {
    providers: 'project-context-overview-providers',
    instructions: 'project-context-overview-instructions',
    skills: 'project-context-overview-skills',
    mcp: 'project-context-overview-mcp'
  }

  for (let reopenAttempt = 0; reopenAttempt < 3; reopenAttempt += 1) {
    const dialog = await openProjectContextManager(mainWindow, projectAbbrev)
    if (await isProjectSectionVisible(dialog, section)) return dialog

    const sectionCard = dialog.getByTestId(sectionTestIdMap[section]).first()
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await isProjectSectionVisible(dialog, section)) return dialog

      if (await sectionCard.isVisible({ timeout: 400 }).catch(() => false)) {
        await sectionCard.click({ force: true }).catch(() => {})
        if (await isProjectSectionVisible(dialog, section)) return dialog
      }

      const backToOverview = dialog.getByRole('button', { name: /^(Providers|Instructions|Skills|MCP Servers)$/ }).first()
      if (await backToOverview.isVisible({ timeout: 400 }).catch(() => false)) {
        await backToOverview.click({ force: true }).catch(() => {})
      }

      await mainWindow.waitForTimeout(140)
    }
    await closeTopDialog(mainWindow).catch(() => {})
  }

  const dialog = await openProjectContextManager(mainWindow, projectAbbrev)
  await expect(dialog.getByTestId(sectionTestIdMap[section]).first()).toBeVisible({ timeout: 5_000 })
  await dialog.getByTestId(sectionTestIdMap[section]).first().click({ force: true })
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
