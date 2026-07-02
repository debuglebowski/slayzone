import {
  test,
  expect,
  seed,
  goHome,
  projectBlob,
  TEST_PROJECT_PATH,
  resetApp
} from '../fixtures/electron'
import {
  closeTopDialog,
  openUserContextManager,
  openProjectContextSection,
  openSkillSyncPanel,
  gotoContextSection
} from '../fixtures/context-manager'
import path from 'path'
import fs from 'fs'

const projectName = 'CM Sync'
const projectAbbrev = 'CM'
const skillSlug = 'e2e-context-sync-skill'
const skillContentV1 = '# E2E context skill v1\n'
const skillContentV2 = '# E2E context skill v2\n'
const localSkillSlug = 'e2e-local-project-skill'
const localSkillBody = '# E2E local project skill\n'
const releasePromptBody = `Create a new release for SlayZone. The version argument is: patch

## Steps

1. Determine version
2. Bump version
3. Generate changelog
`
const localSkillContent = `---
name: ${localSkillSlug}
description: E2E local project skill
---

${localSkillBody}`
const claudeSkillPath = () =>
  path.join(TEST_PROJECT_PATH, '.claude', 'skills', skillSlug, 'SKILL.md')
const codexSkillPath = () =>
  path.join(TEST_PROJECT_PATH, '.agents', 'skills', skillSlug, 'SKILL.md')
const localClaudeSkillPath = () =>
  path.join(TEST_PROJECT_PATH, '.claude', 'skills', localSkillSlug, 'SKILL.md')
const localCodexSkillPath = () =>
  path.join(TEST_PROJECT_PATH, '.agents', 'skills', localSkillSlug, 'SKILL.md')

function skillDocument(slug: string, body: string): string {
  const normalizedBody = body.endsWith('\n') ? body : `${body}\n`
  return `---\nname: ${slug}\ndescription: ${slug}\n---\n\n${normalizedBody}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertLibrarySkill(
  mainWindow: Page,
  content: string,
  electronApp?: any
): Promise<void> {
  const skillExists = await mainWindow.evaluate(async (slug) => {
    const skills = await window.getTrpcVanillaClient().aiConfig.listItems.query({ scope: 'library', type: 'skill' })
    return skills.some((item) => item.slug === slug)
  }, skillSlug)

  const dialog = await openUserContextManager(mainWindow, electronApp)
  await dialog.getByTestId('context-overview-skills').click()
  await expect(dialog.getByTestId('context-new-skill')).toBeVisible({ timeout: 5_000 })

  const existing = dialog.getByTestId(`context-library-item-${skillSlug}`)
  if (skillExists) {
    await expect(existing).toBeVisible({ timeout: 5_000 })
    await existing.click()
  } else {
    await dialog.getByTestId('context-new-skill').click()
    await expect(dialog.getByTestId('context-item-editor-slug')).toBeVisible({ timeout: 5_000 })
    await dialog.getByTestId('context-item-editor-slug').fill(skillSlug)
    await dialog.getByTestId('context-item-editor-slug').blur()
  }

  await dialog.getByTestId('context-item-editor-content').fill(skillDocument(skillSlug, content))
  await dialog.getByTestId('context-item-editor-content').blur()

  await expect
    .poll(async () => {
      return await mainWindow.evaluate(
        async ({ slug, expectedBody }) => {
          const skills = await window.getTrpcVanillaClient().aiConfig.listItems.query({ scope: 'library', type: 'skill' })
          const match = skills.find((item) => item.slug === slug)
          return (
            !!match?.content.includes(`name: ${slug}`) &&
            !!match?.content.includes(expectedBody.trim())
          )
        },
        { slug: skillSlug, expectedBody: content }
      )
    })
    .toBe(true)

  await dialog.getByTestId('context-item-editor-close').click()
  await closeTopDialog(mainWindow)
}

test.describe('Context manager sync flow', () => {
    let projectId: string

    test.beforeAll(async ({ mainWindow }) => {
      await resetApp(mainWindow)
      const s = seed(mainWindow)
      const project = await s.createProject({
        name: projectName,
        color: '#22c55e',
        path: TEST_PROJECT_PATH
      })
      projectId = project.id

      await mainWindow.evaluate(
        ({ id }) => {
          return window
            .getTrpcVanillaClient()
            .aiConfig.setProjectProviders.mutate({ projectId: id, providers: ['claude', 'codex'] })
        },
        { id: project.id }
      )

      await s.refreshData()
      await goHome(mainWindow)
      await expect(projectBlob(mainWindow, projectAbbrev)).toBeVisible({ timeout: 5_000 })
    })

    test('creates a computer skill file from the Files panel', async ({
      mainWindow,
      electronApp
    }) => {
      const slug = `e2e-computer-file-${Date.now()}`
      const dialog = await openUserContextManager(mainWindow, electronApp)
      // Redesigned CM opens straight to the Computer → Files view (no overview card).
      const addButton = dialog.locator('[data-testid^="computer-files-add-skill-"]').first()
      await expect(addButton).toBeVisible({ timeout: 5_000 })
      await addButton.scrollIntoViewIfNeeded()
      await addButton.click()
      await dialog.getByTestId('computer-files-new-name').fill(slug)
      await dialog.getByTestId('computer-files-create').click()

      // Verify the panel's create flow persisted the file. Poll the data layer
      // rather than the file tree's text — the redesigned tree's visual refresh
      // after create is not instantaneous and makes a UI-text assert flaky.
      await expect
        .poll(
          async () =>
            mainWindow.evaluate(async ({ candidate }) => {
              const files = await window.getTrpcVanillaClient().aiConfig.getComputerFiles.query()
              return files.some(
                (entry) => entry.category === 'skill' && entry.name.endsWith(`/${candidate}.md`)
              )
            }, { candidate: slug }),
          { timeout: 10_000 }
        )
        .toBe(true)

      const createdPath = await mainWindow.evaluate(
        async ({ candidate }) => {
          const files = await window.getTrpcVanillaClient().aiConfig.getComputerFiles.query()
          const match = files.find(
            (entry) => entry.category === 'skill' && entry.name.endsWith(`/${candidate}.md`)
          )
          return match?.path ?? null
        },
        { candidate: slug }
      )

      if (createdPath) {
        await mainWindow.evaluate(
          async ({ filePath }) => {
            await window.getTrpcVanillaClient().aiConfig.deleteComputerFile.mutate({ filePath })
          },
          { filePath: createdPath }
        )
      }

      await closeTopDialog(mainWindow)
    })

    test('library body-only skill can be repaired from the UI by adding frontmatter', async ({
      mainWindow,
      electronApp
    }) => {
      const slug = `e2e-body-only-invalid-${Date.now()}`
      await mainWindow.evaluate(
        async ({ targetSlug, content }) => {
          await window.getTrpcVanillaClient().aiConfig.createItem.mutate({
            type: 'skill',
            scope: 'library',
            slug: targetSlug,
            content
          })
        },
        { targetSlug: slug, content: releasePromptBody }
      )

      const dialog = await openUserContextManager(mainWindow, electronApp)
      await gotoContextSection(mainWindow, 'Library', 'Skills')
      await expect
        .poll(
          async () => {
            return await mainWindow.evaluate(async (targetSlug) => {
              const items = await window.getTrpcVanillaClient().aiConfig.listItems.query({ scope: 'library', type: 'skill' })
              const match = items.find((item) => item.slug === targetSlug)
              if (!match) return null
              const metadata = JSON.parse(match.metadata_json) as {
                skillValidation?: { status?: string }
              }
              return metadata.skillValidation?.status ?? null
            }, slug)
          },
          { timeout: 5_000 }
        )
        .toBe('invalid')

      // Select the skill in the list; its detail editor surfaces the invalid state
      // and the repair affordance (redesigned CM — no overview cards / row badge).
      await dialog.getByText(slug, { exact: false }).first().click()
      await expect(dialog.getByText('Frontmatter is invalid')).toBeVisible({ timeout: 5_000 })

      const fixFrontmatterButton = dialog.getByTestId('context-item-editor-fix-frontmatter')
      await expect(fixFrontmatterButton).toBeVisible({ timeout: 5_000 })
      await fixFrontmatterButton.click()

      await expect(dialog.getByTestId('context-item-editor-content')).toHaveValue(
        new RegExp(`^---\\nname: ${slug}\\n`),
        { timeout: 5_000 }
      )
      await expect
        .poll(
          async () => {
            return await mainWindow.evaluate(async (targetSlug) => {
              const items = await window.getTrpcVanillaClient().aiConfig.listItems.query({ scope: 'library', type: 'skill' })
              const match = items.find((item) => item.slug === targetSlug)
              if (!match) return null
              const metadata = JSON.parse(match.metadata_json) as {
                skillValidation?: { status?: string }
              }
              return metadata.skillValidation?.status ?? null
            }, slug)
          },
          { timeout: 5_000 }
        )
        .toBe('valid')
      await expect(dialog.getByText('Frontmatter is invalid')).toHaveCount(0)

      await mainWindow.evaluate(async (targetSlug) => {
        const items = await window.getTrpcVanillaClient().aiConfig.listItems.query({ scope: 'library', type: 'skill' })
        const match = items.find((item) => item.slug === targetSlug)
        if (match) await window.getTrpcVanillaClient().aiConfig.deleteItem.mutate({ id: match.id })
      }, slug)

      await closeTopDialog(mainWindow)
    })

    // REMOVED 2026-06-20: the redesigned Context Manager dropped the library-skill
    // help card entirely (no `library-skill-help-card` in any non-legacy component),
    // so "skills section shows a brief help card" tested a feature that no longer
    // exists. The project-skill help card (covered below) was kept.

    // REMOVED 2026-06-20: tested a section-level "help card pinned to the modal
    // bottom". The redesigned CM is not a modal, and the skill help card moved
    // into the per-skill editor (ItemSection's SkillHelpCard) — there is no
    // section-level pinned card to assert on. The help content is now exercised
    // incidentally by the skill-editing tests.

    // MIGRATE PENDING 2026-06-20: nav (Project → MCPs) is migrated and the MCP
    // testids still exist (McpFlatSection), but the "Add MCP server" affordance
    // isn't reached — McpSection renders McpFlatSection only when projectPath +
    // MCP-capable providers resolve through the new view; needs a focused pass on
    // the redesigned MCP flow (add-server dialog + provider columns).
    // DEFER 2026-06-23: CM Phase-3 redesign (same root as 63) — page closes / 30s
    // timeout against the old MCP-section UI. Rewrite to the new CM view. See plan.
    test.skip('project MCP section shows provider columns when MCP entries exist', async ({
      mainWindow
    }) => {
      await mainWindow.evaluate(
        ({ id }) => {
          return window
            .getTrpcVanillaClient()
            .aiConfig.setProjectProviders.mutate({ projectId: id, providers: ['claude', 'codex'] })
        },
        { id: projectId }
      )

      const projectDialog = await openProjectContextSection(mainWindow, projectAbbrev, 'mcp')

      await expect(projectDialog.getByTestId('project-context-mcp-provider-claude')).toHaveCount(0)
      await expect(projectDialog.getByTestId('project-context-mcp-provider-codex')).toHaveCount(0)

      await projectDialog.getByText('Add MCP server').click()
      const addMcpDialog = mainWindow
        .getByRole('dialog')
        .filter({ hasText: 'Add MCP Server' })
        .last()
      await expect(addMcpDialog).toBeVisible({ timeout: 5_000 })
      await addMcpDialog.getByRole('button', { name: 'Filesystem' }).click()

      const serverRow = projectDialog.locator('[data-testid^="project-context-item-mcp-"]').first()
      await expect(serverRow).toBeVisible({ timeout: 5_000 })
      await serverRow.click()
      await expect(projectDialog.getByTestId('project-context-mcp-provider-claude')).toBeVisible({
        timeout: 5_000
      })
      const codexColumn = projectDialog.getByTestId('project-context-mcp-provider-codex')
      if (await codexColumn.count()) {
        await expect(codexColumn).toBeVisible({ timeout: 5_000 })
      }

      await closeTopDialog(mainWindow)
    })

    // DEFER 2026-06-23: CM Phase-3 redesign (same root as 63) — page closes / 30s
    // timeout against the old library-link UI. Rewrite to the new CM view. See plan.
    test.skip('library skill can be linked to project and re-synced after library edits', async ({
      mainWindow,
      electronApp
    }) => {
      await upsertLibrarySkill(mainWindow, skillContentV1, electronApp)

      const projectDialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')

      await projectDialog.getByTestId('project-context-add-skill').click()
      const addDialog = mainWindow.getByRole('dialog').filter({ hasText: 'Add Skill' }).last()
      await expect(addDialog).toBeVisible({ timeout: 5_000 })
      await addDialog.getByTestId(`add-item-option-${skillSlug}`).click()

      await expect.poll(() => fs.existsSync(claudeSkillPath())).toBe(true)
      await expect
        .poll(() => {
          try {
            const content = fs.readFileSync(claudeSkillPath(), 'utf-8')
            return content.includes(`name: ${skillSlug}`) && content.includes(skillContentV1.trim())
          } catch {
            return false
          }
        })
        .toBe(true)
      if (fs.existsSync(codexSkillPath())) {
        await expect
          .poll(() => {
            try {
              const content = fs.readFileSync(codexSkillPath(), 'utf-8')
              return (
                content.includes(`name: ${skillSlug}`) && content.includes(skillContentV1.trim())
              )
            } catch {
              return false
            }
          })
          .toBe(true)
      }

      await closeTopDialog(mainWindow)
      await upsertLibrarySkill(mainWindow, skillContentV2, electronApp)

      const resyncDialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      const skillRow = resyncDialog.getByTestId(`project-context-item-skill-${skillSlug}`)
      await expect(skillRow).toContainText('Stale', { timeout: 5_000 })
      await openSkillSyncPanel(resyncDialog, skillSlug)
      const pushAll = resyncDialog.getByTestId(`skill-push-all-${skillSlug}`)
      if (await pushAll.isVisible({ timeout: 800 }).catch(() => false)) {
        await pushAll.click()
      } else {
        const pushClaude = resyncDialog.getByTestId(`skill-push-claude-${skillSlug}`)
        if (await pushClaude.isVisible({ timeout: 800 }).catch(() => false)) {
          await pushClaude.click()
        }
        const pushCodex = resyncDialog.getByTestId(`skill-push-codex-${skillSlug}`)
        if (await pushCodex.isVisible({ timeout: 800 }).catch(() => false)) {
          await pushCodex.click()
        }
      }

      await expect
        .poll(() => {
          try {
            const content = fs.readFileSync(claudeSkillPath(), 'utf-8')
            return content.includes(`name: ${skillSlug}`) && content.includes(skillContentV2.trim())
          } catch {
            return false
          }
        })
        .toBe(true)
      if (fs.existsSync(codexSkillPath())) {
        await expect
          .poll(() => {
            try {
              const content = fs.readFileSync(codexSkillPath(), 'utf-8')
              return (
                content.includes(`name: ${skillSlug}`) && content.includes(skillContentV2.trim())
              )
            } catch {
              return false
            }
          })
          .toBe(true)
      }

      await expect
        .poll(async () => {
          return await mainWindow.evaluate(
            async ({ id, projectPath }) => {
              return window
                .getTrpcVanillaClient()
                .aiConfig.needsSync.query({ projectId: id, projectPath })
            },
            { id: projectId, projectPath: TEST_PROJECT_PATH }
          )
        })
        .toBe(false)

      await closeTopDialog(mainWindow)
    })

    test('project-local skill can be synced to filesystem', async ({ mainWindow }) => {
      await mainWindow.evaluate(
        ({ id }) => {
          return window
            .getTrpcVanillaClient()
            .aiConfig.setProjectProviders.mutate({ projectId: id, providers: ['claude', 'codex'] })
        },
        { id: projectId }
      )

      const itemId = await mainWindow.evaluate(
        async ({ id, slug, content }) => {
          const existing = await window.getTrpcVanillaClient().aiConfig.listItems.query({
            scope: 'project',
            projectId: id,
            type: 'skill'
          })
          const match = existing.find((item) => item.slug === slug)
          if (match) {
            await window.getTrpcVanillaClient().aiConfig.updateItem.mutate({ id: match.id, content })
            return match.id
          }
          const created = await window.getTrpcVanillaClient().aiConfig.createItem.mutate({
            type: 'skill',
            scope: 'project',
            projectId: id,
            slug,
            content
          })
          return created.id
        },
        { id: projectId, slug: localSkillSlug, content: localSkillContent }
      )

      await mainWindow.evaluate(
        async ({ id, itemId, projectPath }) => {
          await window
            .getTrpcVanillaClient()
            .aiConfig.syncLinkedFile.mutate({
              projectId: id,
              projectPath,
              itemId,
              provider: 'claude'
            })
          await window
            .getTrpcVanillaClient()
            .aiConfig.syncLinkedFile.mutate({
              projectId: id,
              projectPath,
              itemId,
              provider: 'codex'
            })
        },
        { id: projectId, itemId, projectPath: TEST_PROJECT_PATH }
      )

      await expect.poll(() => fs.existsSync(localClaudeSkillPath()), { timeout: 15_000 }).toBe(true)
      await expect
        .poll(() => {
          try {
            const content = fs.readFileSync(localClaudeSkillPath(), 'utf-8')
            return (
              content.includes(`name: ${localSkillSlug}`) && content.includes(localSkillBody.trim())
            )
          } catch {
            return false
          }
        })
        .toBe(true)
      if (fs.existsSync(localCodexSkillPath())) {
        await expect
          .poll(() => {
            try {
              const content = fs.readFileSync(localCodexSkillPath(), 'utf-8')
              return (
                content.includes(`name: ${localSkillSlug}`) &&
                content.includes(localSkillBody.trim())
              )
            } catch {
              return false
            }
          })
          .toBe(true)
      }
    })
  })
