/**
 * A skill's "Go to source" link is a one-shot: it drills the marketplace into the
 * skill's registry and opens the entry's preview once it is listed. When the entry is
 * not listed (its registry is disabled), the request must end with that visit — a
 * later visit from the sidebar, after the registry is back, must not pop the preview.
 */
import type { Page } from '@playwright/test'
import { test, expect, resetApp } from '../fixtures/electron'
import { openUserContextManager, gotoContextSection } from '../fixtures/context-manager'

const REGISTRY = 'builtin-slayzone'

type Entry = { id: string; name: string; slug: string }

async function setRegistryEnabled(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(
    (a) =>
      window
        .getTrpcVanillaClient()
        .aiConfig.marketplace.toggleRegistry.mutate({ registryId: a.id, enabled: a.enabled }),
    { id: REGISTRY, enabled }
  )
}

function sidebarButton(page: Page, name: string) {
  return page
    .locator('nav')
    .filter({ has: page.getByRole('heading', { name: 'Context Manager' }) })
    .getByRole('button', { name })
}

test.describe('marketplace "Go to source" link', () => {
  let entry: Entry
  let itemId: string

  test.beforeAll(async ({ mainWindow, electronApp }) => {
    await resetApp(mainWindow)
    entry = { id: 'e2e-oneshot-entry', name: 'E2E One Shot Skill', slug: 'e2e-oneshot-skill' }
    await electronApp.evaluate(
      async ({}, e) => {
        const db = (globalThis as Record<string, unknown>).__db as {
          run: (sql: string, params?: unknown[]) => Promise<unknown>
        }
        await db.run(
          `INSERT OR REPLACE INTO skill_registry_entries
           (id, registry_id, slug, name, description, content, content_hash)
         VALUES (?, ?, ?, ?, '', ?, 'e2e')`,
          [e.id, e.registry, e.slug, e.name, `---\nname: ${e.slug}\ndescription: e2e\n---\n`]
        )
      },
      { ...entry, registry: REGISTRY }
    )
    const item = (await mainWindow.evaluate(
      (entryId) =>
        window
          .getTrpcVanillaClient()
          .aiConfig.marketplace.installSkill.mutate({ entryId, scope: 'library' }),
      entry.id
    )) as { id: string }
    itemId = item.id
  })

  test.afterAll(async ({ mainWindow, electronApp }) => {
    await setRegistryEnabled(mainWindow, true).catch(() => {})
    await mainWindow
      .evaluate((id) => window.getTrpcVanillaClient().aiConfig.deleteItem.mutate({ id }), itemId)
      .catch(() => {})
    await electronApp
      .evaluate(async ({}, id) => {
        const db = (globalThis as Record<string, unknown>).__db as {
          run: (sql: string, params?: unknown[]) => Promise<unknown>
        }
        await db.run('DELETE FROM skill_registry_entries WHERE id = ?', [id])
      }, entry.id)
      .catch(() => {})
  })

  test('an entry that was not listed does not pop open on a later visit', async ({
    mainWindow
  }) => {
    const preview = mainWindow.getByRole('dialog').filter({ hasText: entry.name })

    // The skill's registry is disabled, so its entry is not listed.
    await setRegistryEnabled(mainWindow, false)
    await openUserContextManager(mainWindow)
    await gotoContextSection(mainWindow, 'Library', 'Skills')
    await mainWindow.getByText(entry.slug, { exact: true }).first().click()
    await mainWindow.getByTestId('context-item-editor-go-to-source').click()
    await expect(sidebarButton(mainWindow, 'Marketplace')).toBeVisible()
    await expect(mainWindow.getByRole('heading', { name: 'Library — Skills' })).toBeHidden()
    await expect(preview).toHaveCount(0)

    // Leave, bring the registry back, and open the marketplace from the sidebar.
    await gotoContextSection(mainWindow, 'Library', 'Skills')
    await setRegistryEnabled(mainWindow, true)
    await sidebarButton(mainWindow, 'Marketplace').click()
    await expect(mainWindow.getByRole('heading', { name: 'Library — Skills' })).toBeHidden()

    // Never shown: sample past the entries load (it lists every enabled registry).
    for (let i = 0; i < 15; i++) {
      await expect(preview).toHaveCount(0)
      await mainWindow.waitForTimeout(200)
    }
  })
})
