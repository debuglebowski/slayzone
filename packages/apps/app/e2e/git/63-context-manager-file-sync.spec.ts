import { test, expect, seed, goHome, projectBlob, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  closeTopDialog,
  openProjectContextSection,
  openSkillEditPanel,
  openSkillSyncPanel
} from '../fixtures/context-manager'
import type { Page, Locator } from '@playwright/test'
import path from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const projectName = 'FS Sync'
const projectAbbrev = 'FS'
const skillSlug = 'e2e-file-sync-skill'
const unmanagedSkillSlug = 'commit-changes'
const manageableUnmanagedSkillSlug = 'e2e-manage-unmanaged-skill'
const codexOnlySkillSlug = 'e2e-codex-only-linked-skill'
const codexOnlyWithUnmanagedClaudeSlug = 'e2e-codex-only-with-unmanaged-claude'
const frontmatterMismatchSkillSlug = 'e2e-frontmatter-mismatch-skill'
const skillContentV1 = '# File sync skill v1\n\nContent for testing.\n'
const skillContentV2 = '# File sync skill v2\n\nUpdated content.\n'
const instructionsV1 = '# Project instructions v1\n\nThese are test instructions.\n'
const instructionsV2 = '# Project instructions v2\n\nUpdated instructions.\n'
const codexOnlySkillContent = '# Codex-only linked skill\n'
const codexOnlyWithUnmanagedClaudeContent = '# Codex-only with unmanaged claude file\n'
const manageableUnmanagedSkillContent = '# unmanaged skill to manage\n'
const frontmatterMismatchSkillInitialContent = '# Frontmatter mismatch body\n\nSame body.\n'
const frontmatterMismatchSkillDbContent = '---\nname: e2e-frontmatter-mismatch-skill\ndescription: DB frontmatter mismatch\n---\n# Frontmatter mismatch body\n\nSame body.\n'
const releasePromptBody = `Create a new release for SlayZone. The version argument is: patch

## Steps

1. Determine version
2. Bump version
3. Generate changelog
`

// Disk paths
const claudeInstructionsPath = () => path.join(TEST_PROJECT_PATH, 'CLAUDE.md')
const codexInstructionsPath = () => path.join(TEST_PROJECT_PATH, 'AGENTS.md')
const claudeSkillPath = () => path.join(TEST_PROJECT_PATH, '.claude', 'skills', skillSlug, 'SKILL.md')
const codexSkillPath = () => path.join(TEST_PROJECT_PATH, '.agents', 'skills', skillSlug, 'SKILL.md')
const unmanagedCodexSkillPath = () => path.join(TEST_PROJECT_PATH, '.agents', 'skills', unmanagedSkillSlug, 'SKILL.md')
const manageableUnmanagedCodexSkillPath = () => path.join(TEST_PROJECT_PATH, '.agents', 'skills', manageableUnmanagedSkillSlug, 'SKILL.md')
const codexOnlySkillPath = () => path.join(TEST_PROJECT_PATH, '.agents', 'skills', codexOnlySkillSlug, 'SKILL.md')
const codexOnlyWithUnmanagedClaudeCodexPath = () => path.join(TEST_PROJECT_PATH, '.agents', 'skills', codexOnlyWithUnmanagedClaudeSlug, 'SKILL.md')
const codexOnlyWithUnmanagedClaudeClaudePath = () => path.join(TEST_PROJECT_PATH, '.claude', 'skills', codexOnlyWithUnmanagedClaudeSlug, 'SKILL.md')
const frontmatterMismatchClaudePath = () => path.join(TEST_PROJECT_PATH, '.claude', 'skills', frontmatterMismatchSkillSlug, 'SKILL.md')
const frontmatterMismatchCodexPath = () => path.join(TEST_PROJECT_PATH, '.agents', 'skills', frontmatterMismatchSkillSlug, 'SKILL.md')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFileSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8') } catch { return '' }
}

function skillDocument(slug: string, body: string): string {
  const normalizedBody = body.endsWith('\n') ? body : `${body}\n`
  return `---\nname: ${slug}\ndescription: ${slug}\n---\n\n${normalizedBody}`
}

async function setInstructionsContent(mainWindow: Page, projectId: string, content: string): Promise<void> {
  await mainWindow.evaluate(({ id, projectPath, next }) => {
    return window.api.aiConfig.saveInstructionsContent(id, projectPath, next)
  }, { id: projectId, projectPath: TEST_PROJECT_PATH, next: content })
}

function cleanupDiskFiles(): void {
  for (const f of [
    claudeInstructionsPath(),
    codexInstructionsPath(),
    claudeSkillPath(),
    codexSkillPath(),
    unmanagedCodexSkillPath(),
    manageableUnmanagedCodexSkillPath(),
    codexOnlySkillPath(),
    codexOnlyWithUnmanagedClaudeCodexPath(),
    codexOnlyWithUnmanagedClaudeClaudePath(),
    frontmatterMismatchClaudePath(),
    frontmatterMismatchCodexPath()
  ]) {
    try { fs.unlinkSync(f) } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe.skip('Context manager file sync', () => {
  let projectId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    cleanupDiskFiles()

    const s = seed(mainWindow)
    const project = await s.createProject({ name: projectName, color: '#6366f1', path: TEST_PROJECT_PATH })
    projectId = project.id

    // Enable claude + codex providers
    await mainWindow.evaluate(({ id }) => {
      return window.api.aiConfig.setProjectProviders(id, ['claude', 'codex'])
    }, { id: project.id })

    // Seed instructions content in DB
    await mainWindow.evaluate(({ id, projectPath, content }) => {
      return window.api.aiConfig.saveInstructionsContent(id, projectPath, content)
    }, { id: project.id, projectPath: TEST_PROJECT_PATH, content: instructionsV1 })

    // Create and link a global skill
    await mainWindow.evaluate(async ({ slug, content }) => {
      const existing = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
      const match = existing.find((item) => item.slug === slug)
      if (match) {
        await window.api.aiConfig.updateItem({ id: match.id, content })
      } else {
        await window.api.aiConfig.createItem({ type: 'skill', scope: 'global', slug, content })
      }
    }, { slug: skillSlug, content: skillDocument(skillSlug, skillContentV1) })

    // Link global skill to project
    await mainWindow.evaluate(async ({ projectId: pid, projectPath, slug }) => {
      const items = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
      const item = items.find((i) => i.slug === slug)
      if (!item) throw new Error('Skill not found')
      await window.api.aiConfig.loadGlobalItem({
        projectId: pid, projectPath, itemId: item.id, providers: ['claude', 'codex']
      })
    }, { projectId: project.id, projectPath: TEST_PROJECT_PATH, slug: skillSlug })

    await s.refreshData()
    await goHome(mainWindow)
    await expect(projectBlob(mainWindow, projectAbbrev)).toBeVisible({ timeout: 5_000 })
  })

  // =========================================================================
  // Instructions tests
  // =========================================================================

  test.describe('Instructions', () => {
    test.afterAll(async ({ mainWindow }) => {
      await closeTopDialog(mainWindow).catch(() => {})
    })

    async function openInstructionsDialog(mainWindow: Page): Promise<Locator> {
      const dialog = mainWindow
        .getByRole('dialog')
        .filter({ has: mainWindow.getByRole('heading', { name: 'Project Settings' }) })
        .last()
      const textarea = dialog.getByTestId('instructions-textarea')

      if (await textarea.isVisible({ timeout: 500 }).catch(() => false)) return dialog

      if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
        const sectionCard = dialog.getByTestId('project-context-overview-instructions').first()
        if (await sectionCard.isVisible({ timeout: 500 }).catch(() => false)) {
          await sectionCard.click().catch(() => {})
          if (await textarea.isVisible({ timeout: 1_500 }).catch(() => false)) return dialog
        }
      }

      return openProjectContextSection(mainWindow, projectAbbrev, 'instructions')
    }

    async function reopenInstructionsSection(dialog: Locator): Promise<void> {
      const backToOverview = dialog.getByRole('button', { name: 'Instructions', exact: true }).first()
      if (await backToOverview.isVisible({ timeout: 500 }).catch(() => false)) {
        await backToOverview.click().catch(() => {})
      }
      const instructionsCard = dialog.getByTestId('project-context-overview-instructions').first()
      await expect(instructionsCard).toBeVisible({ timeout: 5_000 })
      await instructionsCard.click()
      await expect(dialog.getByTestId('instructions-textarea')).toBeVisible({ timeout: 5_000 })
    }

    async function ensureInstructionsV2AndSyncAll(mainWindow: Page): Promise<Locator> {
      await setInstructionsContent(mainWindow, projectId, instructionsV2)
      const dialog = await openInstructionsDialog(mainWindow)
      const textarea = dialog.getByTestId('instructions-textarea')
      await expect(textarea).toBeVisible({ timeout: 5_000 })
      await textarea.fill(instructionsV2)
      await expect.poll(async () => {
        const result = await mainWindow.evaluate(({ id, projectPath }) => {
          return window.api.aiConfig.getRootInstructions(id, projectPath)
        }, { id: projectId, projectPath: TEST_PROJECT_PATH })
        return result.content
      }, { timeout: 5_000 }).toBe(instructionsV2)
      const pushAll = dialog.getByTestId('instructions-push-all')
      if (await pushAll.isVisible({ timeout: 600 }).catch(() => false)) {
        await pushAll.click()
      }
      await expect(dialog.getByTestId('instructions-provider-card-claude')).toContainText('Synced', { timeout: 5_000 })
      await expect(dialog.getByTestId('instructions-provider-card-codex')).toContainText('Synced', { timeout: 5_000 })
      return dialog
    }

    test('edit auto-saves to DB', async ({ mainWindow }) => {
      const dialog = await openInstructionsDialog(mainWindow)
      const textarea = dialog.getByTestId('instructions-textarea')
      await expect(textarea).toBeVisible({ timeout: 5_000 })

      await textarea.fill(instructionsV2)

      // Wait for debounced save (800ms) + processing
      await expect.poll(async () => {
        const result = await mainWindow.evaluate(({ id, projectPath }) => {
          return window.api.aiConfig.getRootInstructions(id, projectPath)
        }, { id: projectId, projectPath: TEST_PROJECT_PATH })
        return result.content
      }, { timeout: 5_000 }).toBe(instructionsV2)
    })

    test('Config → File pushes to specific provider', async ({ mainWindow }) => {
      await setInstructionsContent(mainWindow, projectId, instructionsV2)
      const dialog = await openInstructionsDialog(mainWindow)
      const textarea = dialog.getByTestId('instructions-textarea')
      await expect(textarea).toBeVisible({ timeout: 5_000 })
      await textarea.fill(instructionsV2)
      await expect.poll(async () => {
        const result = await mainWindow.evaluate(({ id, projectPath }) => {
          return window.api.aiConfig.getRootInstructions(id, projectPath)
        }, { id: projectId, projectPath: TEST_PROJECT_PATH })
        return result.content
      }, { timeout: 5_000 }).toBe(instructionsV2)

      const pushClaude = dialog.getByTestId('instructions-push-claude')
      await expect(pushClaude).toBeVisible({ timeout: 5_000 })
      await pushClaude.click()

      // Verify CLAUDE.md written on disk
      await expect.poll(() => readFileSafe(claudeInstructionsPath())).toBe(instructionsV2)

      // Verify card shows Synced
      const card = dialog.getByTestId('instructions-provider-card-claude')
      await expect(card).toContainText('Synced', { timeout: 5_000 })
    })

    test('Config → All Files pushes to all providers', async ({ mainWindow }) => {
      await setInstructionsContent(mainWindow, projectId, instructionsV2)
      const dialog = await openInstructionsDialog(mainWindow)
      const textarea = dialog.getByTestId('instructions-textarea')
      await expect(textarea).toBeVisible({ timeout: 5_000 })
      await textarea.fill(instructionsV2)
      await expect.poll(async () => {
        const result = await mainWindow.evaluate(({ id, projectPath }) => {
          return window.api.aiConfig.getRootInstructions(id, projectPath)
        }, { id: projectId, projectPath: TEST_PROJECT_PATH })
        return result.content
      }, { timeout: 5_000 }).toBe(instructionsV2)

      const pushAll = dialog.getByTestId('instructions-push-all')
      await expect(pushAll).toBeVisible({ timeout: 5_000 })
      await pushAll.click()

      // Verify both files on disk
      await expect.poll(() => readFileSafe(claudeInstructionsPath())).toBe(instructionsV2)
      await expect.poll(() => readFileSafe(codexInstructionsPath())).toBe(instructionsV2)

      // Verify both cards show Synced
      await expect(dialog.getByTestId('instructions-provider-card-claude')).toContainText('Synced', { timeout: 5_000 })
      await expect(dialog.getByTestId('instructions-provider-card-codex')).toContainText('Synced', { timeout: 5_000 })
    })

    test('stale detection after disk modification', async ({ mainWindow }) => {
      const dialog = await ensureInstructionsV2AndSyncAll(mainWindow)
      // Modify CLAUDE.md externally
      fs.writeFileSync(claudeInstructionsPath(), '# Externally modified\n')

      // Remount section to refresh status
      await reopenInstructionsSection(dialog)
      const card = dialog.getByTestId('instructions-provider-card-claude')
      await expect(card).toContainText('Stale', { timeout: 5_000 })

      // Codex should still be synced
      await expect(dialog.getByTestId('instructions-provider-card-codex')).toContainText('Synced', { timeout: 5_000 })
    })

    test('stale card shows pull action', async ({ mainWindow }) => {
      const dialog = await ensureInstructionsV2AndSyncAll(mainWindow)
      fs.writeFileSync(claudeInstructionsPath(), '# Externally modified\n')
      await reopenInstructionsSection(dialog)
      const card = dialog.getByTestId('instructions-provider-card-claude')
      await expect(card).toContainText('Stale', { timeout: 5_000 })
      await expect(dialog.getByTestId('instructions-pull-claude')).toBeVisible({ timeout: 5_000 })
    })

    test('File → Config pulls from disk', async ({ mainWindow }) => {
      const dialog = await ensureInstructionsV2AndSyncAll(mainWindow)
      const diskContent = '# Externally modified\n'
      fs.writeFileSync(claudeInstructionsPath(), diskContent)

      await reopenInstructionsSection(dialog)

      const pullClaude = dialog.getByTestId('instructions-pull-claude')
      await expect(pullClaude).toBeVisible({ timeout: 5_000 })
      await pullClaude.click()

      // Verify textarea updated with disk content
      const textarea = dialog.getByTestId('instructions-textarea')
      await expect(textarea).toHaveValue(diskContent, { timeout: 5_000 })

      // Verify all providers now synced
      await expect(dialog.getByTestId('instructions-provider-card-claude')).toContainText('Synced', { timeout: 5_000 })

      // DB should also reflect pulled content
      await expect.poll(async () => {
        const result = await mainWindow.evaluate(({ id, projectPath }) => {
          return window.api.aiConfig.getRootInstructions(id, projectPath)
        }, { id: projectId, projectPath: TEST_PROJECT_PATH })
        return result.content
      }).toBe(diskContent)
    })
  })

  // =========================================================================
  // Skills tests
  // =========================================================================

  test.describe('Skills', () => {
    test('expand shows editor with auto-save', async ({ mainWindow }) => {
      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')

      await openSkillEditPanel(dialog, skillSlug)

      // Verify content editor visible
      const content = dialog.getByTestId('skill-detail-content')
      await expect(content).toBeVisible({ timeout: 5_000 })
      await expect(content).toHaveValue(new RegExp(`---\\nname: ${skillSlug}[\\s\\S]*${skillContentV1.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), { timeout: 5_000 })

      // Edit and verify auto-save
      await content.fill(skillDocument(skillSlug, skillContentV2))

      await expect.poll(async () => {
        return await mainWindow.evaluate(async ({ slug, expectedBody }) => {
          const items = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
          const match = items.find((i) => i.slug === slug)
          return !!match?.content.includes(`name: ${slug}`) && !!match?.content.includes(expectedBody.trim())
        }, { slug: skillSlug, expectedBody: skillContentV2 })
      }, { timeout: 5_000 }).toBe(true)

      await closeTopDialog(mainWindow)
    })

    test('Config → File pushes skill to specific provider', async ({ mainWindow }) => {
      const pendingBody = `# File sync skill provider push\n\n${Date.now()}\n`
      const pendingContent = skillDocument(skillSlug, pendingBody)
      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      await openSkillEditPanel(dialog, skillSlug)
      const content = dialog.getByTestId('skill-detail-content')
      await expect(content).toBeVisible({ timeout: 5_000 })
      await content.fill(pendingContent)
      await expect.poll(async () => {
        return await mainWindow.evaluate(async ({ slug, expectedBody }) => {
          const items = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
          const match = items.find((i) => i.slug === slug)
          return !!match?.content.includes(`name: ${slug}`) && !!match?.content.includes(expectedBody.trim())
        }, { slug: skillSlug, expectedBody: pendingBody })
      }, { timeout: 5_000 }).toBe(true)
      await openSkillSyncPanel(dialog, skillSlug)

      const pushClaude = dialog.getByTestId(`skill-push-claude-${skillSlug}`)
      await expect(pushClaude).toBeVisible({ timeout: 5_000 })
      await pushClaude.click()

      // Verify .claude/skills/{slug}/SKILL.md written with frontmatter
      await expect.poll(() => {
        const content = readFileSafe(claudeSkillPath())
        return content.includes(`name: ${skillSlug}`) && content.includes(pendingBody.trim())
      }).toBe(true)

      // Verify claude card shows synced
      const claudeCard = dialog.getByTestId(`skill-provider-card-claude-${skillSlug}`)
      await expect(claudeCard).toContainText('Synced', { timeout: 5_000 })

      await closeTopDialog(mainWindow)
    })

    test('Config → All Files pushes to all providers', async ({ mainWindow }) => {
      const pendingBody = `# File sync skill push all\n\n${Date.now()}\n`
      const pendingContent = skillDocument(skillSlug, pendingBody)
      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      await openSkillEditPanel(dialog, skillSlug)
      const content = dialog.getByTestId('skill-detail-content')
      await expect(content).toBeVisible({ timeout: 5_000 })
      await content.fill(pendingContent)
      await expect.poll(async () => {
        return await mainWindow.evaluate(async ({ slug, expectedBody }) => {
          const items = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
          const match = items.find((i) => i.slug === slug)
          return !!match?.content.includes(`name: ${slug}`) && !!match?.content.includes(expectedBody.trim())
        }, { slug: skillSlug, expectedBody: pendingBody })
      }, { timeout: 5_000 }).toBe(true)
      await openSkillSyncPanel(dialog, skillSlug)

      const pushAll = dialog.getByTestId(`skill-push-all-${skillSlug}`)
      await expect(pushAll).toBeVisible({ timeout: 5_000 })
      await pushAll.click()

      // Verify both provider files on disk
      await expect.poll(() => {
        const content = readFileSafe(claudeSkillPath())
        return content.includes(`name: ${skillSlug}`) && content.includes(pendingBody.trim())
      }).toBe(true)
      await expect.poll(() => {
        const content = readFileSafe(codexSkillPath())
        return content.includes(`name: ${skillSlug}`) && content.includes(pendingBody.trim())
      }).toBe(true)

      // Verify both cards show synced
      await expect(dialog.getByTestId(`skill-provider-card-claude-${skillSlug}`)).toContainText('Synced', { timeout: 5_000 })
      await expect(dialog.getByTestId(`skill-provider-card-codex-${skillSlug}`)).toContainText('Synced', { timeout: 5_000 })

      await closeTopDialog(mainWindow)
    })

    test('stale detection after external disk modification', async ({ mainWindow }) => {
      // Externally modify the claude skill file
      const modified = '---\nname: modified\n---\n# Modified externally\n'
      fs.writeFileSync(claudeSkillPath(), modified)

      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      const skillRow = dialog.getByTestId(`project-context-item-skill-${skillSlug}`)

      // Row should show stale aggregate
      await expect(skillRow).toContainText('Stale', { timeout: 5_000 })

      // Expand to see per-provider status
      await openSkillSyncPanel(dialog, skillSlug)
      const claudeCard = dialog.getByTestId(`skill-provider-card-claude-${skillSlug}`)
      await expect(claudeCard).toContainText('Stale', { timeout: 5_000 })

      // Codex should still be synced
      await expect(dialog.getByTestId(`skill-provider-card-codex-${skillSlug}`)).toContainText('Synced', { timeout: 5_000 })

      await closeTopDialog(mainWindow)
    })

    test('stale skill card shows pull action', async ({ mainWindow }) => {
      const modified = '---\nname: modified\n---\n# Modified externally\n'
      fs.writeFileSync(claudeSkillPath(), modified)

      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      await openSkillSyncPanel(dialog, skillSlug)

      const claudeCard = dialog.getByTestId(`skill-provider-card-claude-${skillSlug}`)
      await expect(claudeCard).toContainText('Stale', { timeout: 5_000 })
      await expect(dialog.getByTestId(`skill-pull-claude-${skillSlug}`)).toBeVisible({ timeout: 5_000 })

      await closeTopDialog(mainWindow)
    })

    test('File → Config pulls from disk and keeps raw frontmatter', async ({ mainWindow }) => {
      const modified = '---\nname: modified\n---\n# Modified externally\n'
      fs.writeFileSync(claudeSkillPath(), modified)

      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      await openSkillSyncPanel(dialog, skillSlug)
      await expect(dialog.getByTestId(`skill-provider-card-claude-${skillSlug}`)).toContainText('Stale', { timeout: 5_000 })

      const pullClaude = dialog.getByTestId(`skill-pull-claude-${skillSlug}`)
      await expect(pullClaude).toBeVisible({ timeout: 5_000 })
      await pullClaude.click()

      // Verify DB content updated with the raw skill document
      await expect.poll(async () => {
        return await mainWindow.evaluate(async ({ slug, expectedBody }) => {
          const items = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
          const match = items.find((i) => i.slug === slug)
          return !!match?.content.includes('name: modified') && !!match?.content.includes(expectedBody.trim())
        }, { slug: skillSlug, expectedBody: '# Modified externally\n' })
      }, { timeout: 5_000 }).toBe(true)

      await closeTopDialog(mainWindow)
    })

    test('filename rename updates slug', async ({ mainWindow }) => {
      const newSlug = 'e2e-file-sync-renamed'

      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      const skillRow = dialog.getByTestId(`project-context-item-skill-${skillSlug}`)
      await openSkillEditPanel(dialog, skillSlug)

      const filenameInput = dialog.getByTestId('skill-detail-filename')
      await expect(filenameInput).toBeVisible({ timeout: 5_000 })
      await filenameInput.fill(newSlug)

      const renameButton = dialog.getByTestId('skill-detail-rename')
      await expect(renameButton).toBeVisible({ timeout: 5_000 })
      await renameButton.click()

      // Verify slug updated in DB
      await expect.poll(async () => {
        return await mainWindow.evaluate(async (slug) => {
          const items = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
          return items.some((i) => i.slug === slug)
        }, newSlug)
      }, { timeout: 5_000 }).toBe(true)

      // Verify new row visible
      await expect(dialog.getByTestId(`project-context-item-skill-${newSlug}`)).toBeVisible({ timeout: 5_000 })

      // Rename back for subsequent tests — need to close/reopen dialog since onChanged reloads data
      await closeTopDialog(mainWindow)
      const dialog2 = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      await openSkillEditPanel(dialog2, newSlug)
      const input = dialog2.getByTestId('skill-detail-filename')
      await expect(input).toBeVisible({ timeout: 5_000 })
      await input.fill(skillSlug)
      await dialog2.getByTestId('skill-detail-rename').click()
      await expect(dialog2.getByTestId(`project-context-item-skill-${skillSlug}`)).toBeVisible({ timeout: 5_000 })

      await closeTopDialog(mainWindow)
    })

    test('existing managed skill shows frontmatter in the editor and becomes invalid if it is removed', async ({ mainWindow }) => {
      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      await openSkillEditPanel(dialog, skillSlug)

      const contentInput = dialog.getByTestId('skill-detail-content')
      await expect(contentInput).toBeVisible({ timeout: 5_000 })
      await expect(contentInput).toHaveValue(/---\nname: /, { timeout: 5_000 })
      await contentInput.fill(releasePromptBody)

      await expect.poll(async () => {
        return await mainWindow.evaluate(async (slug) => {
          const items = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
          const match = items.find((item) => item.slug === slug)
          if (!match) return null
          const metadata = JSON.parse(match.metadata_json) as {
            skillValidation?: { status?: string }
          }
          return metadata.skillValidation?.status ?? null
        }, skillSlug)
      }, { timeout: 5_000 }).toBe('invalid')

      await expect(dialog.getByText('Frontmatter is invalid')).toBeVisible({ timeout: 5_000 })
      await expect(dialog.getByText(/Skill content must start with YAML frontmatter/i)).toBeVisible({ timeout: 5_000 })
      await expect(dialog.getByTestId(`project-context-item-skill-${skillSlug}`)).toContainText('Invalid frontmatter')

      await closeTopDialog(mainWindow)

      const dialog2 = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      await expect(dialog2.getByTestId(`project-context-item-skill-${skillSlug}`)).toContainText('Invalid frontmatter')
      await openSkillSyncPanel(dialog2, skillSlug)
      await expect(dialog2.getByTestId(`skill-push-all-${skillSlug}`)).toBeDisabled({ timeout: 5_000 })

      await closeTopDialog(mainWindow)
    })

    test('Config → File after pull re-syncs to disk', async ({ mainWindow }) => {
      const resyncedBody = '# Re-synced after pull\n'
      const resyncedContent = skillDocument(skillSlug, resyncedBody)
      await mainWindow.evaluate(async ({ slug, content }) => {
        const items = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
        const item = items.find((entry) => entry.slug === slug)
        if (!item) throw new Error('Skill not found for resync test')
        await window.api.aiConfig.updateItem({ id: item.id, content })
      }, { slug: skillSlug, content: resyncedContent })

      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      await openSkillSyncPanel(dialog, skillSlug)
      await expect(dialog.getByTestId(`project-context-item-skill-${skillSlug}`)).toContainText('Stale', { timeout: 5_000 })

      const pushAll = dialog.getByTestId(`skill-push-all-${skillSlug}`)
      await expect(pushAll).toBeVisible({ timeout: 5_000 })
      await pushAll.click()

      // Verify both synced
      await expect(dialog.getByTestId(`skill-provider-card-claude-${skillSlug}`)).toContainText('Synced', { timeout: 5_000 })
      await expect(dialog.getByTestId(`skill-provider-card-codex-${skillSlug}`)).toContainText('Synced', { timeout: 5_000 })

      // Verify files on disk
      await expect.poll(() => readFileSafe(claudeSkillPath()).includes(resyncedBody.trim())).toBe(true)
      await expect.poll(() => {
        const content = readFileSafe(codexSkillPath())
        return content.includes(`name: ${skillSlug}`) && content.includes(resyncedBody.trim())
      }).toBe(true)

      await closeTopDialog(mainWindow)
    })
  })

  // =========================================================================
  // Cross-feature tests
  // =========================================================================

  test.describe('Integration', () => {
    test('full instructions roundtrip: push → external edit → stale → pull', async ({ mainWindow }) => {
      const testContent = '# Roundtrip test\n\nFull cycle.\n'
      const externalEdit = '# Externally edited\n\nDifferent content.\n'

      // 1. Set instructions via API
      await mainWindow.evaluate(({ id, projectPath, content }) => {
        return window.api.aiConfig.saveInstructionsContent(id, projectPath, content)
      }, { id: projectId, projectPath: TEST_PROJECT_PATH, content: testContent })

      // 2. Push to all
      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'instructions')
      await dialog.getByTestId('instructions-push-all').click()
      await expect.poll(() => readFileSafe(claudeInstructionsPath())).toBe(testContent)

      // 3. Externally edit
      fs.writeFileSync(claudeInstructionsPath(), externalEdit)

      // 4. Close and reopen to pick up stale status
      await closeTopDialog(mainWindow)
      const dialog2 = await openProjectContextSection(mainWindow, projectAbbrev, 'instructions')
      await expect(dialog2.getByTestId('instructions-provider-card-claude')).toContainText('Stale', { timeout: 5_000 })

      // 5. Pull from claude
      await dialog2.getByTestId('instructions-pull-claude').click()
      await expect(dialog2.getByTestId('instructions-textarea')).toHaveValue(externalEdit, { timeout: 5_000 })

      // 6. Push to all again to sync codex
      await dialog2.getByTestId('instructions-push-all').click()
      await expect(dialog2.getByTestId('instructions-provider-card-claude')).toContainText('Synced', { timeout: 5_000 })
      await expect(dialog2.getByTestId('instructions-provider-card-codex')).toContainText('Synced', { timeout: 5_000 })

      await closeTopDialog(mainWindow)
    })

    test('needsSync returns false after all providers synced', async ({ mainWindow }) => {
      // Push all instructions
      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'instructions')
      const pushAllInstructions = dialog.getByTestId('instructions-push-all')
      if (await pushAllInstructions.count()) {
        if (await pushAllInstructions.isVisible({ timeout: 800 }).catch(() => false)) {
          await pushAllInstructions.click()
        }
      }
      if (!(await pushAllInstructions.isVisible({ timeout: 400 }).catch(() => false))) {
        const pushClaude = dialog.getByTestId('instructions-push-claude')
        if (await pushClaude.isVisible({ timeout: 800 }).catch(() => false)) {
          await pushClaude.click()
        }
        const pushCodex = dialog.getByTestId('instructions-push-codex')
        if (await pushCodex.isVisible({ timeout: 800 }).catch(() => false)) {
          await pushCodex.click()
        }
      }
      await expect(dialog.getByTestId('instructions-provider-card-claude')).toContainText('Synced', { timeout: 5_000 })
      await expect(dialog.getByTestId('instructions-provider-card-codex')).toContainText('Synced', { timeout: 5_000 })
      await closeTopDialog(mainWindow)

      // Push all skills
      const dialog2 = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      await openSkillSyncPanel(dialog2, skillSlug)
      const pushAllSkills = dialog2.getByTestId(`skill-push-all-${skillSlug}`)
      if (await pushAllSkills.count()) {
        await pushAllSkills.click()
      }
      await expect(dialog2.getByTestId(`skill-provider-card-claude-${skillSlug}`)).toContainText('Synced', { timeout: 5_000 })
      await expect(dialog2.getByTestId(`skill-provider-card-codex-${skillSlug}`)).toContainText('Synced', { timeout: 5_000 })
      await closeTopDialog(mainWindow)

      // Verify needsSync is false
      await expect.poll(async () => {
        return await mainWindow.evaluate(({ id, projectPath }) => {
          return window.api.aiConfig.needsSync(id, projectPath)
        }, { id: projectId, projectPath: TEST_PROJECT_PATH })
      }).toBe(false)
    })

    test('disk-only skills are shown in Skills section as unmanaged', async ({ mainWindow }) => {
      fs.mkdirSync(path.dirname(unmanagedCodexSkillPath()), { recursive: true })
      fs.writeFileSync(unmanagedCodexSkillPath(), '# unmanaged skill on disk\n')

      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      const unmanagedRow = dialog.getByTestId(`project-context-item-unmanaged-skill-${unmanagedSkillSlug}`)
      await expect(unmanagedRow).toBeVisible({ timeout: 5_000 })
      await expect(unmanagedRow).toContainText('Unmanaged')

      await closeTopDialog(mainWindow)
    })

    test('unmanaged skill can be managed from row button', async ({ mainWindow }) => {
      fs.mkdirSync(path.dirname(manageableUnmanagedCodexSkillPath()), { recursive: true })
      fs.writeFileSync(manageableUnmanagedCodexSkillPath(), manageableUnmanagedSkillContent)

      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      const unmanagedRow = dialog.getByTestId(`project-context-item-unmanaged-skill-${manageableUnmanagedSkillSlug}`)
      await expect(unmanagedRow).toBeVisible({ timeout: 5_000 })
      await unmanagedRow.click()
      await dialog.getByTestId(`unmanaged-skill-manage-${manageableUnmanagedSkillSlug}`).click()

      await expect(dialog.getByTestId(`project-context-item-unmanaged-skill-${manageableUnmanagedSkillSlug}`)).toHaveCount(0)
      const managedRow = dialog.getByTestId(`project-context-item-skill-${manageableUnmanagedSkillSlug}`)
      await expect(managedRow).toBeVisible({ timeout: 5_000 })
      await expect(managedRow).toContainText('Synced', { timeout: 5_000 })

      await expect.poll(async () => {
        return await mainWindow.evaluate(async ({ id, projectPath, slug }) => {
          const statuses = await window.api.aiConfig.getProjectSkillsStatus(id, projectPath)
          const status = statuses.find((entry) => entry.item.slug === slug)
          return status?.providers.codex?.syncHealth ?? null
        }, { id: projectId, projectPath: TEST_PROJECT_PATH, slug: manageableUnmanagedSkillSlug })
      }).toBe('synced')

      await closeTopDialog(mainWindow)
    })

    test('frontmatter-only DB metadata changes mark both linked providers stale', async ({ mainWindow }) => {
      await mainWindow.evaluate(async ({ id, projectPath, slug, initialContent, updatedContent }) => {
        const existing = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
        const match = existing.find((item) => item.slug === slug)
        const item = match
          ? await window.api.aiConfig.updateItem({ id: match.id, content: initialContent })
          : await window.api.aiConfig.createItem({ type: 'skill', scope: 'global', slug, content: initialContent })
        if (!item) throw new Error('Could not create frontmatter mismatch skill')

        await window.api.aiConfig.removeProjectSelection(id, item.id)
        await window.api.aiConfig.loadGlobalItem({
          projectId: id,
          projectPath,
          itemId: item.id,
          providers: ['claude', 'codex']
        })
        await window.api.aiConfig.updateItem({ id: item.id, content: updatedContent })
      }, {
        id: projectId,
        projectPath: TEST_PROJECT_PATH,
        slug: frontmatterMismatchSkillSlug,
        initialContent: skillDocument(frontmatterMismatchSkillSlug, frontmatterMismatchSkillInitialContent),
        updatedContent: frontmatterMismatchSkillDbContent
      })

      await expect.poll(() => {
        const content = readFileSafe(frontmatterMismatchCodexPath())
        return content.includes(`name: ${frontmatterMismatchSkillSlug}`) &&
          content.includes(frontmatterMismatchSkillInitialContent.trim())
      }).toBe(true)
      await expect.poll(async () => {
        return await mainWindow.evaluate(async ({ id, projectPath, slug }) => {
          const statuses = await window.api.aiConfig.getProjectSkillsStatus(id, projectPath)
          const skill = statuses.find((entry) => entry.item.slug === slug)
          return {
            claude: skill?.providers.claude?.syncHealth ?? null,
            codex: skill?.providers.codex?.syncHealth ?? null
          }
        }, { id: projectId, projectPath: TEST_PROJECT_PATH, slug: frontmatterMismatchSkillSlug })
      }).toEqual({ claude: 'stale', codex: 'stale' })

      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      const skillRow = dialog.getByTestId(`project-context-item-skill-${frontmatterMismatchSkillSlug}`)
      await expect(skillRow).toContainText('Stale', { timeout: 5_000 })

      await openSkillSyncPanel(dialog, frontmatterMismatchSkillSlug)
      await expect(dialog.getByTestId(`skill-provider-card-claude-${frontmatterMismatchSkillSlug}`)).toContainText('Stale', { timeout: 5_000 })
      await expect(dialog.getByTestId(`skill-provider-card-codex-${frontmatterMismatchSkillSlug}`)).toContainText('Stale', { timeout: 5_000 })

      await closeTopDialog(mainWindow)
    })

    test('row status uses linked providers only', async ({ mainWindow }) => {
      await mainWindow.evaluate(async ({ id, projectPath, slug, content }) => {
        const existing = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
        const match = existing.find((item) => item.slug === slug)
        const item = match
          ? await window.api.aiConfig.updateItem({ id: match.id, content })
          : await window.api.aiConfig.createItem({ type: 'skill', scope: 'global', slug, content })
        if (!item) throw new Error('Could not create codex-only skill')

        await window.api.aiConfig.removeProjectSelection(id, item.id)
        await window.api.aiConfig.loadGlobalItem({
          projectId: id,
          projectPath,
          itemId: item.id,
          providers: ['codex']
        })
      }, {
        id: projectId,
        projectPath: TEST_PROJECT_PATH,
        slug: codexOnlySkillSlug,
        content: skillDocument(codexOnlySkillSlug, codexOnlySkillContent)
      })

      await expect.poll(() => {
        const content = readFileSafe(codexOnlySkillPath())
        return content.includes(`name: ${codexOnlySkillSlug}`) && content.includes(codexOnlySkillContent.trim())
      }).toBe(true)

      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      const skillRow = dialog.getByTestId(`project-context-item-skill-${codexOnlySkillSlug}`)
      await expect(skillRow).toContainText('Synced', { timeout: 5_000 })

      await openSkillSyncPanel(dialog, codexOnlySkillSlug)
      await expect(dialog.getByTestId(`skill-provider-card-codex-${codexOnlySkillSlug}`)).toBeVisible({ timeout: 5_000 })
      await expect(dialog.getByTestId(`skill-provider-card-claude-${codexOnlySkillSlug}`)).toHaveCount(0)

      await closeTopDialog(mainWindow)
    })

    test('row status reflects unmanaged file on unlinked provider', async ({ mainWindow }) => {
      await mainWindow.evaluate(async ({ id, projectPath, slug, content }) => {
        const existing = await window.api.aiConfig.listItems({ scope: 'global', type: 'skill' })
        const match = existing.find((item) => item.slug === slug)
        const item = match
          ? await window.api.aiConfig.updateItem({ id: match.id, content })
          : await window.api.aiConfig.createItem({ type: 'skill', scope: 'global', slug, content })
        if (!item) throw new Error('Could not create codex-only skill with unmanaged claude')

        await window.api.aiConfig.removeProjectSelection(id, item.id)
        await window.api.aiConfig.loadGlobalItem({
          projectId: id,
          projectPath,
          itemId: item.id,
          providers: ['codex']
        })
      }, {
        id: projectId,
        projectPath: TEST_PROJECT_PATH,
        slug: codexOnlyWithUnmanagedClaudeSlug,
        content: skillDocument(codexOnlyWithUnmanagedClaudeSlug, codexOnlyWithUnmanagedClaudeContent)
      })

      await expect.poll(() => {
        const content = readFileSafe(codexOnlyWithUnmanagedClaudeCodexPath())
        return content.includes(`name: ${codexOnlyWithUnmanagedClaudeSlug}`) &&
          content.includes(codexOnlyWithUnmanagedClaudeContent.trim())
      }).toBe(true)
      fs.mkdirSync(path.dirname(codexOnlyWithUnmanagedClaudeClaudePath()), { recursive: true })
      fs.writeFileSync(codexOnlyWithUnmanagedClaudeClaudePath(), '# unmanaged claude version\n')

      const dialog = await openProjectContextSection(mainWindow, projectAbbrev, 'skills')
      const skillRow = dialog.getByTestId(`project-context-item-skill-${codexOnlyWithUnmanagedClaudeSlug}`)
      await expect(skillRow).toContainText('Unmanaged', { timeout: 5_000 })
      await expect(skillRow).not.toContainText('Synced')

      await closeTopDialog(mainWindow)
    })
  })
})
