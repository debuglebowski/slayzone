import { test, expect, seed, goHome, projectBlob, TEST_PROJECT_PATH, resetApp} from '../fixtures/electron'
import {
  closeTopDialog,
  openGlobalContextManager,
  openProjectContextSection,
  openSkillSyncPanel
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
const claudeSkillPath = () => path.join(TEST_PROJECT_PATH, '.claude', 'skills', skillSlug, 'SKILL.md')
const codexSkillPath = () => path.join(TEST_PROJECT_PATH, '.agents', 'skills', skillSlug, 'SKILL.md')
const localClaudeSkillPath = () => path.join(TEST_PROJECT_PATH, '.claude', 'skills', localSkillSlug, 'SKILL.md')
const localCodexSkillPath = () => path.join(TEST_PROJECT_PATH, '.agents', 'skills', localSkillSlug, 'SKILL.md')

function skillDocument(slug: string, body: string): string {
  const normalizedBody = body.endsWith('\n') ? body : `${body}\n`
  return `---\nname: ${slug}\ndescription: ${slug}\n---\n\n${normalizedBody}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertGlobalSkill(mainWindow: Page, content: string, electronApp?: any): Promise<void> {
  const skillExists = await mainWindow.evaluate(async (slug) => {
    const skills = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
    return skills.some((item) => item.slug === slug)
  }, skillSlug)

  const dialog = await openGlobalContextManager(mainWindow, electronApp)
  await dialog.getByTestId('context-overview-skills').click()
  await expect(dialog.getByTestId('context-new-skill')).toBeVisible({ timeout: 5_000 })

  const existing = dialog.getByTestId(`context-global-item-${skillSlug}`)
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

  await expect.poll(async () => {
    return await mainWindow.evaluate(async ({ slug, expectedBody }) => {
      const skills = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
      const match = skills.find((item) => item.slug === slug)
      return !!match?.content.includes(`name: ${slug}`) && !!match?.content.includes(expectedBody.trim())
    }, { slug: skillSlug, expectedBody: content })
  }).toBe(true)

  await dialog.getByTestId('context-item-editor-close').click()
  await closeTopDialog(mainWindow)
}

test.describe.skip('Context manager sync flow', () => {
  let projectId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const project = await s.createProject({ name: projectName, color: '#22c55e', path: TEST_PROJECT_PATH })
    projectId = project.id

    await mainWindow.evaluate(({ id }) => {
      return window.api.aiConfig.setProjectProviders(id, ['claude', 'codex'])
    }, { id: project.id })

    await s.refreshData()
    await goHome(mainWindow)
    await expect(projectBlob(mainWindow, projectAbbrev)).toBeVisible({ timeout: 5_000 })
  })

  test('creates a global skill file from the Files panel', async ({ mainWindow, electronApp }) => {
    const slug = `e2e-global-file-${Date.now()}`
    const dialog = await openGlobalContextManager(mainWindow, electronApp)
    await dialog.getByTestId('context-overview-files').click()

    const addButton = dialog.locator('[data-testid^="global-files-add-skill-"]').first()
    await expect(addButton).toBeVisible({ timeout: 5_000 })
    const addButtonTestId = await addButton.getAttribute('data-testid')
    if (!addButtonTestId) throw new Error('Expected global skill add button to have a data-testid')
    const provider = addButtonTestId.replace('global-files-add-skill-', '')
    await addButton.scrollIntoViewIfNeeded()
    await addButton.click()
    await dialog.getByTestId('global-files-new-name').fill(slug)
    await dialog.getByTestId('global-files-create').click()

    await expect(dialog.getByText(`${slug}.md`, { exact: true })).toBeVisible({ timeout: 5_000 })

    const createdPath = await mainWindow.evaluate(async ({ candidate }) => {
      const files = await window.api.aiConfig.getGlobalFiles()
      const match = files.find((entry) =>
        entry.category === 'skill' &&
        entry.name.endsWith(`/${candidate}.md`)
      )
      return match?.path ?? null
    }, { candidate: slug })

    if (createdPath) {
      await mainWindow.evaluate(async ({ filePath }) => {
        await window.api.aiConfig.deleteGlobalFile(filePath)
      }, { filePath: createdPath })
    }

    await closeTopDialog(mainWindow)
  })

  test('global body-only skill can be repaired from the UI by adding frontmatter', async ({ mainWindow, electronApp }) => {
    const slug = `e2e-body-only-invalid-${Date.now()}`
    await mainWindow.evaluate(async ({ targetSlug, content }) => {
      await window.api.aiConfig.createItem({
        type: 'skill',
        scope: 'global',
        slug: targetSlug,
        content
      })
    }, { targetSlug: slug, content: releasePromptBody })

    const dialog = await openGlobalContextManager(mainWindow, electronApp)
    await dialog.getByTestId('context-overview-skills').click()
    await expect.poll(async () => {
      return await mainWindow.evaluate(async (targetSlug) => {
        const items = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
        const match = items.find((item) => item.slug === targetSlug)
        if (!match) return null
        const metadata = JSON.parse(match.metadata_json) as {
          skillValidation?: { status?: string }
        }
        return metadata.skillValidation?.status ?? null
      }, slug)
    }, { timeout: 5_000 }).toBe('invalid')

    const skillRow = dialog.getByTestId(`context-global-item-${slug}`)
    await expect(skillRow).toContainText('Invalid frontmatter')

    await skillRow.click()
    await expect(dialog.getByText('Frontmatter is invalid')).toBeVisible({ timeout: 5_000 })
    await expect(dialog.getByText(/Skill content must start with YAML frontmatter/i)).toBeVisible({ timeout: 5_000 })
    const addFrontmatterButton = mainWindow.getByRole('button', { name: 'Add frontmatter', exact: true })
    await expect(addFrontmatterButton).toBeVisible({ timeout: 5_000 })

    await addFrontmatterButton.click()

    await expect(dialog.getByTestId('context-item-editor-content')).toHaveValue(new RegExp(`^---\\nname: ${slug}\\n`), { timeout: 5_000 })
    await expect.poll(async () => {
      return await mainWindow.evaluate(async (targetSlug) => {
        const items = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
        const match = items.find((item) => item.slug === targetSlug)
        if (!match) return null
        const metadata = JSON.parse(match.metadata_json) as {
          skillValidation?: { status?: string }
        }
        return metadata.skillValidation?.status ?? null
      }, slug)
    }, { timeout: 5_000 }).toBe('valid')
    await expect(dialog.getByText('Frontmatter is invalid')).toHaveCount(0)

    await mainWindow.evaluate(async (targetSlug) => {
      const items = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
      const match = items.find((item) => item.slug === targetSlug)
      if (match) await window.api.aiConfig.deleteItem(match.id)
    }, slug)

    await closeTopDialog(mainWindow)
  })

  test('skills section shows a brief help card', async ({ mainWindow, electronApp }) => {
    const dialog = await openGlobalContextManager(mainWindow, electronApp)
    await dialog.getByTestId('context-overview-skills').click()

    const helpCard = mainWindow.getByTestId('global-skill-help-card')
    const toggle = helpCard.getByTestId('global-skill-help-card-toggle')
    await expect(helpCard).toBeVisible({ timeout: 5_000 })
    await expect(helpCard).toContainText('Skill file')
    await expect(helpCard).toContainText('Required structure and field meanings')
    await expect(helpCard).not.toContainText('Frontmatter comes first, followed by the instruction body')

    await toggle.click()
    await expect(helpCard).toContainText('Frontmatter comes first, followed by the instruction body')
    await expect(helpCard).toContainText('name')
    await expect(helpCard).toContainText('description')
    await expect(helpCard).toContainText('trigger')
    await expect(helpCard).toContainText('Options: any value')
    await expect(helpCard).toContainText('Default: auto')

    await toggle.click()
    await expect(helpCard).not.toContainText('Options: any value')
    await expect(helpCard).not.toContainText('Frontmatter comes first, followed by the instruction body')

    await toggle.click()
    await expect(helpCard).toContainText('body')

    await closeTopDialog(mainWindow)
  })

  test('project skills help card is pinned to the modal bottom', async ({ mainWindow }) => {
    const projectDialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')

    const helpCard = projectDialog.getByTestId('project-skill-help-card')
    await expect(helpCard).toBeVisible({ timeout: 5_000 })

    const dialogBox = await projectDialog.boundingBox()
    const helpCardBox = await helpCard.boundingBox()

    expect(dialogBox).not.toBeNull()
    expect(helpCardBox).not.toBeNull()

    const modalBottomGap = Math.round(dialogBox!.y + dialogBox!.height - (helpCardBox!.y + helpCardBox!.height))
    expect(modalBottomGap).toBeLessThanOrEqual(40)

    await closeTopDialog(mainWindow)
  })

  test('project MCP section shows provider columns when MCP entries exist', async ({ mainWindow }) => {
    await mainWindow.evaluate(({ id }) => {
      return window.api.aiConfig.setProjectProviders(id, ['claude', 'codex'])
    }, { id: projectId })

    const projectDialog = await openProjectContextSection(mainWindow, projectAbbrev, 'mcp')

    await expect(projectDialog.getByTestId('project-context-mcp-provider-claude')).toHaveCount(0)
    await expect(projectDialog.getByTestId('project-context-mcp-provider-codex')).toHaveCount(0)

    await projectDialog.getByText('Add MCP server').click()
    const addMcpDialog = mainWindow.getByRole('dialog').filter({ hasText: 'Add MCP Server' }).last()
    await expect(addMcpDialog).toBeVisible({ timeout: 5_000 })
    await addMcpDialog.getByRole('button', { name: 'Filesystem' }).click()

    const serverRow = projectDialog.locator('[data-testid^="project-context-item-mcp-"]').first()
    await expect(serverRow).toBeVisible({ timeout: 5_000 })
    await serverRow.click()
    await expect(projectDialog.getByTestId('project-context-mcp-provider-claude')).toBeVisible({ timeout: 5_000 })
    const codexColumn = projectDialog.getByTestId('project-context-mcp-provider-codex')
    if (await codexColumn.count()) {
      await expect(codexColumn).toBeVisible({ timeout: 5_000 })
    }

    await closeTopDialog(mainWindow)
  })

  test('global skill can be linked to project and re-synced after global edits', async ({ mainWindow, electronApp }) => {
    await upsertGlobalSkill(mainWindow, skillContentV1, electronApp)

    const projectDialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')

    await projectDialog.getByTestId('project-context-add-skill').click()
    const addDialog = mainWindow.getByRole('dialog').filter({ hasText: 'Add Skill' }).last()
    await expect(addDialog).toBeVisible({ timeout: 5_000 })
    await addDialog.getByTestId(`add-item-option-${skillSlug}`).click()

    await expect.poll(() => fs.existsSync(claudeSkillPath())).toBe(true)
    await expect.poll(() => {
      try {
        const content = fs.readFileSync(claudeSkillPath(), 'utf-8')
        return content.includes(`name: ${skillSlug}`) && content.includes(skillContentV1.trim())
      } catch {
        return false
      }
    }).toBe(true)
    if (fs.existsSync(codexSkillPath())) {
      await expect.poll(() => {
        try {
          const content = fs.readFileSync(codexSkillPath(), 'utf-8')
          return content.includes(`name: ${skillSlug}`) && content.includes(skillContentV1.trim())
        } catch {
          return false
        }
      }).toBe(true)
    }

    await closeTopDialog(mainWindow)
    await upsertGlobalSkill(mainWindow, skillContentV2, electronApp)

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

    await expect.poll(() => {
      try {
        const content = fs.readFileSync(claudeSkillPath(), 'utf-8')
        return content.includes(`name: ${skillSlug}`) && content.includes(skillContentV2.trim())
      } catch {
        return false
      }
    }).toBe(true)
    if (fs.existsSync(codexSkillPath())) {
      await expect.poll(() => {
        try {
          const content = fs.readFileSync(codexSkillPath(), 'utf-8')
          return content.includes(`name: ${skillSlug}`) && content.includes(skillContentV2.trim())
        } catch {
          return false
        }
      }).toBe(true)
    }

    await expect.poll(async () => {
      return await mainWindow.evaluate(async ({ id, projectPath }) => {
        return window.api.aiConfig.needsSync(id, projectPath)
      }, { id: projectId, projectPath: TEST_PROJECT_PATH })
    }).toBe(false)

    await closeTopDialog(mainWindow)
  })

  test('project-local skill can be synced to filesystem', async ({ mainWindow }) => {
    await mainWindow.evaluate(({ id }) => {
      return window.api.aiConfig.setProjectProviders(id, ['claude', 'codex'])
    }, { id: projectId })

    const itemId = await mainWindow.evaluate(async ({ id, slug, content }) => {
      const existing = await window.api.aiConfig.listItems({ scope: 'project', projectId: id, type: 'skill' })
      const match = existing.find((item) => item.slug === slug)
      if (match) {
        await window.api.aiConfig.updateItem({ id: match.id, content })
        return match.id
      }
      const created = await window.api.aiConfig.createItem({
        type: 'skill',
        scope: 'project',
        projectId: id,
        slug,
        content
      })
      return created.id
    }, { id: projectId, slug: localSkillSlug, content: localSkillContent })

    await mainWindow.evaluate(async ({ id, itemId, projectPath }) => {
      await window.api.aiConfig.syncLinkedFile(id, projectPath, itemId, 'claude')
      await window.api.aiConfig.syncLinkedFile(id, projectPath, itemId, 'codex')
    }, { id: projectId, itemId, projectPath: TEST_PROJECT_PATH })

    await expect.poll(() => fs.existsSync(localClaudeSkillPath()), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => {
      try {
        const content = fs.readFileSync(localClaudeSkillPath(), 'utf-8')
        return content.includes(`name: ${localSkillSlug}`) && content.includes(localSkillBody.trim())
      } catch {
        return false
      }
    }).toBe(true)
    if (fs.existsSync(localCodexSkillPath())) {
      await expect.poll(() => {
        try {
          const content = fs.readFileSync(localCodexSkillPath(), 'utf-8')
          return content.includes(`name: ${localSkillSlug}`) && content.includes(localSkillBody.trim())
        } catch {
          return false
        }
      }).toBe(true)
    }
  })

})
