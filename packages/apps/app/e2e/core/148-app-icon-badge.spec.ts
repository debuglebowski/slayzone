/**
 * App icon badge — the "App icon badge" settings card drives the macOS dock badge:
 * enabling "Unread tasks" shows the unread count live (no dialog close needed),
 * the dot style swaps the number for a dot, and turning it off clears the badge.
 */
import { test, expect, seed, resetApp, clickSettings } from '../fixtures/electron'
import type { ElectronApplication } from '@playwright/test'

const dockBadge = (electronApp: ElectronApplication): Promise<string> =>
  electronApp.evaluate(({ app }) => app.dock?.getBadge() ?? '')

test.describe('App icon badge', () => {
  test.skip(process.platform !== 'darwin', 'dock badge is macOS-only')

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const project = await s.createProject({ name: 'Badge Test', color: '#3b82f6' })
    const a = await s.createTask({ projectId: project.id, title: 'Unread A', status: 'todo' })
    const b = await s.createTask({ projectId: project.id, title: 'Unread B', status: 'todo' })
    await s.createTask({ projectId: project.id, title: 'Read C', status: 'todo' })
    await s.updateTask({ id: a.id, needsAttention: true })
    await s.updateTask({ id: b.id, needsAttention: true })
    await s.refreshData()
  })

  test.afterAll(async ({ mainWindow }) => {
    await seed(mainWindow).setSetting('app_badge_sources', '[]')
    await seed(mainWindow).setSetting('app_badge_style', 'count')
  })

  test('settings card drives the dock badge', async ({ electronApp, mainWindow }) => {
    await expect.poll(() => dockBadge(electronApp)).toBe('')

    await clickSettings(mainWindow)
    const card = mainWindow.getByTestId('app-badge-settings')
    await expect(card).toBeVisible({ timeout: 5_000 })

    await card.getByTestId('app-badge-source-unread').click()
    await expect.poll(() => dockBadge(electronApp)).toBe('2')

    await card.getByRole('combobox').first().click()
    await mainWindow.getByRole('option', { name: 'Dot only' }).click()
    await expect.poll(() => dockBadge(electronApp)).toBe('•')

    await card.getByTestId('app-badge-source-unread').click()
    await expect.poll(() => dockBadge(electronApp)).toBe('')
  })
})
