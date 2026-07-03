import {
  test,
  expect,
  seed,
  goHome,
  projectBlob,
  resetApp,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import {
  closeTopDialog,
  gotoContextSection,
  openProjectContextSection,
  openSkillEditor,
  openUserContextManager
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
const codexOnlySkillSlug = 'e2e-codex-only-linked-skill'
const codexOnlyWithUnmanagedClaudeSlug = 'e2e-codex-only-with-unmanaged-claude'
const frontmatterMismatchSkillSlug = 'e2e-frontmatter-mismatch-skill'
const skillContentV1 = '# File sync skill v1\n\nContent for testing.\n'
const skillContentV2 = '# File sync skill v2\n\nUpdated content.\n'
const instructionsV1 = '# Project instructions v1\n\nThese are test instructions.\n'
const instructionsV2 = '# Project instructions v2\n\nUpdated instructions.\n'
const variantSlug = 'e2e-fs-instructions-variant'
const variantContent = '# Variant instructions\n\nSynced from a library variant.\n'
const codexOnlySkillContent = '# Codex-only linked skill\n'
const codexOnlyWithUnmanagedClaudeContent = '# Codex-only with unmanaged claude file\n'
const unmanagedSkillContent = '# unmanaged skill on disk\n'
const frontmatterMismatchSkillInitialContent = '# Frontmatter mismatch body\n\nSame body.\n'
const frontmatterMismatchSkillDbContent =
  '---\nname: e2e-frontmatter-mismatch-skill\ndescription: DB frontmatter mismatch\n---\n# Frontmatter mismatch body\n\nSame body.\n'
const releasePromptBody = `Create a new release for SlayZone. The version argument is: patch

## Steps

1. Determine version
2. Bump version
3. Generate changelog
`

// Disk paths
const claudeInstructionsPath = () => path.join(TEST_PROJECT_PATH, 'CLAUDE.md')
const codexInstructionsPath = () => path.join(TEST_PROJECT_PATH, 'AGENTS.md')
const claudeSkillPath = () =>
  path.join(TEST_PROJECT_PATH, '.claude', 'skills', skillSlug, 'SKILL.md')
const codexSkillPath = () =>
  path.join(TEST_PROJECT_PATH, '.agents', 'skills', skillSlug, 'SKILL.md')
const unmanagedCodexSkillPath = () =>
  path.join(TEST_PROJECT_PATH, '.agents', 'skills', unmanagedSkillSlug, 'SKILL.md')
const codexOnlySkillPath = () =>
  path.join(TEST_PROJECT_PATH, '.agents', 'skills', codexOnlySkillSlug, 'SKILL.md')
const codexOnlyWithUnmanagedClaudeCodexPath = () =>
  path.join(TEST_PROJECT_PATH, '.agents', 'skills', codexOnlyWithUnmanagedClaudeSlug, 'SKILL.md')
const codexOnlyWithUnmanagedClaudeClaudePath = () =>
  path.join(TEST_PROJECT_PATH, '.claude', 'skills', codexOnlyWithUnmanagedClaudeSlug, 'SKILL.md')
const frontmatterMismatchClaudePath = () =>
  path.join(TEST_PROJECT_PATH, '.claude', 'skills', frontmatterMismatchSkillSlug, 'SKILL.md')
const frontmatterMismatchCodexPath = () =>
  path.join(TEST_PROJECT_PATH, '.agents', 'skills', frontmatterMismatchSkillSlug, 'SKILL.md')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function skillDocument(slug: string, body: string): string {
  const normalizedBody = body.endsWith('\n') ? body : `${body}\n`
  return `---\nname: ${slug}\ndescription: ${slug}\n---\n\n${normalizedBody}`
}

async function setInstructionsContent(
  mainWindow: Page,
  projectId: string,
  content: string
): Promise<void> {
  await mainWindow.evaluate(
    ({ id, projectPath, next }) => {
      return window
        .getTrpcVanillaClient()
        .aiConfig.saveInstructionsContent.mutate({ projectId: id, projectPath, content: next })
    },
    { id: projectId, projectPath: TEST_PROJECT_PATH, next: content }
  )
}

/** Update a library skill's content directly in the DB (marks linked providers stale). */
async function updateLibrarySkillContent(
  mainWindow: Page,
  slug: string,
  content: string
): Promise<void> {
  await mainWindow.evaluate(
    async ({ slug: targetSlug, content: next }) => {
      const items = await window
        .getTrpcVanillaClient()
        .aiConfig.listItems.query({ scope: 'library', type: 'skill' })
      const match = items.find((i) => i.slug === targetSlug)
      if (!match) throw new Error(`Library skill not found: ${targetSlug}`)
      await window.getTrpcVanillaClient().aiConfig.updateItem.mutate({ id: match.id, content: next })
    },
    { slug, content }
  )
}

async function skillDbContentMatches(
  mainWindow: Page,
  slug: string,
  fragments: string[]
): Promise<boolean> {
  return await mainWindow.evaluate(
    async ({ slug: targetSlug, fragments: parts }) => {
      const items = await window
        .getTrpcVanillaClient()
        .aiConfig.listItems.query({ scope: 'library', type: 'skill' })
      const match = items.find((i) => i.slug === targetSlug)
      if (!match) return false
      return parts.every((part) => match.content.includes(part))
    },
    { slug, fragments }
  )
}

/** Open the Project → Skills section of the full-screen Context Manager. */
async function openProjectSkills(mainWindow: Page): Promise<Locator> {
  return openProjectContextSection(mainWindow, projectAbbrev, 'skills')
}

/** Open the Library → Skills section (editable — project-linked library skills are read-only). */
async function openLibrarySkills(mainWindow: Page): Promise<Locator> {
  const body = await openUserContextManager(mainWindow)
  await gotoContextSection(mainWindow, 'Library', 'Skills')
  return body
}

/** Open Project → Instructions and select a provider file in the redesigned file list. */
async function openInstructionsFile(
  mainWindow: Page,
  fileName: 'CLAUDE.md' | 'AGENTS.md'
): Promise<{ body: Locator; textarea: Locator }> {
  const body = await openProjectContextSection(mainWindow, projectAbbrev, 'instructions')
  const fileRow = body.getByRole('button').filter({ hasText: fileName }).first()
  await expect(fileRow).toBeVisible({ timeout: 5_000 })
  await fileRow.click()
  const textarea = body.getByPlaceholder('Write instructions...')
  await expect(textarea).toBeVisible({ timeout: 5_000 })
  return { body, textarea }
}

function cleanupDiskFiles(): void {
  for (const f of [
    claudeInstructionsPath(),
    codexInstructionsPath(),
    claudeSkillPath(),
    codexSkillPath(),
    unmanagedCodexSkillPath(),
    codexOnlySkillPath(),
    codexOnlyWithUnmanagedClaudeCodexPath(),
    codexOnlyWithUnmanagedClaudeClaudePath(),
    frontmatterMismatchClaudePath(),
    frontmatterMismatchCodexPath()
  ]) {
    try {
      fs.unlinkSync(f)
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
// MIGRATED 2026-07-02 (Phase-3 CM redesign): the old Project Settings dialog UI
// (`instructions-textarea` / `instructions-push-*` / `instructions-provider-card-*`
// / `skill-detail-*` / `project-context-item-skill-*`) is dead code. The reachable
// UI is the full-screen Context Manager: Project → Instructions edits provider
// files directly on disk (library variants replace the DB-push model) and
// Project/Library → Skills uses SkillListView rows (`skill-row-<slug>`) plus a
// single ContextItemEditor (`context-item-editor-*`) hosting edit + sync.

test.describe('Context manager file sync', () => {
  let projectId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    cleanupDiskFiles()

    const s = seed(mainWindow)
    const project = await s.createProject({
      name: projectName,
      color: '#6366f1',
      path: TEST_PROJECT_PATH
    })
    projectId = project.id

    // Enable claude + codex providers
    await mainWindow.evaluate(
      ({ id }) => {
        return window
          .getTrpcVanillaClient()
          .aiConfig.setProjectProviders.mutate({ projectId: id, providers: ['claude', 'codex'] })
      },
      { id: project.id }
    )

    // Seed instructions content in DB
    await mainWindow.evaluate(
      ({ id, projectPath, content }) => {
        return window
          .getTrpcVanillaClient()
          .aiConfig.saveInstructionsContent.mutate({ projectId: id, projectPath, content })
      },
      { id: project.id, projectPath: TEST_PROJECT_PATH, content: instructionsV1 }
    )

    // Create and link a library skill
    await mainWindow.evaluate(
      async ({ slug, content }) => {
        const existing = await window.getTrpcVanillaClient().aiConfig.listItems.query({ scope: 'library', type: 'skill' })
        const match = existing.find((item) => item.slug === slug)
        if (match) {
          await window.getTrpcVanillaClient().aiConfig.updateItem.mutate({ id: match.id, content })
        } else {
          await window.getTrpcVanillaClient().aiConfig.createItem.mutate({ type: 'skill', scope: 'library', slug, content })
        }
      },
      { slug: skillSlug, content: skillDocument(skillSlug, skillContentV1) }
    )

    // Link library skill to project
    await mainWindow.evaluate(
      async ({ projectId: pid, projectPath, slug }) => {
        const items = await window.getTrpcVanillaClient().aiConfig.listItems.query({ scope: 'library', type: 'skill' })
        const item = items.find((i) => i.slug === slug)
        if (!item) throw new Error('Skill not found')
        await window.getTrpcVanillaClient().aiConfig.loadLibraryItem.mutate({
          projectId: pid,
          projectPath,
          itemId: item.id,
          providers: ['claude', 'codex']
        })
      },
      { projectId: project.id, projectPath: TEST_PROJECT_PATH, slug: skillSlug }
    )

    await s.refreshData()
    await goHome(mainWindow)
    await expect(projectBlob(mainWindow, projectAbbrev)).toBeVisible({ timeout: 5_000 })
  })

  // =========================================================================
  // Instructions tests
  // =========================================================================
  // The redesign dropped the DB-centric instructions model (textarea + per-
  // provider push/pull/stale cards). Instructions are now the provider files
  // themselves: a file list (CLAUDE.md / AGENTS.md) with a direct disk editor
  // (auto-save on blur, watcher-driven reload), plus library variants that
  // sync one shared content to all provider files.
  //
  // REMOVED 2026-07-02: 'Database → File pushes to specific provider' — the
  // push affordance no longer exists; editing a file IS the per-provider write
  // (covered below, including the "other file untouched" half of the old test).
  // REMOVED 2026-07-02: 'stale card shows pull action' + 'File → Database pulls
  // from File' — stale/pull cards no longer exist. A clean editor auto-reloads
  // on external change (covered below); the dirty-editor Reload banner is only
  // reachable through a <500ms debounce race, so it is not e2e-testable
  // deterministically (unit-covered in useWatchedFile.test.ts).

  test.describe('Instructions', () => {
    test('editing a provider file auto-saves to that file only', async ({ mainWindow }) => {
      // Seed a sentinel so we can await the editor's initial load before typing
      // (the file read is async — filling before it resolves loses the edit).
      fs.writeFileSync(claudeInstructionsPath(), '# sentinel claude v0\n')

      const { textarea } = await openInstructionsFile(mainWindow, 'CLAUDE.md')
      await expect(textarea).toHaveValue('# sentinel claude v0\n', { timeout: 5_000 })
      await textarea.fill(instructionsV2)
      await textarea.blur()

      await expect
        .poll(() => readFileSafe(claudeInstructionsPath()), { timeout: 5_000 })
        .toBe(instructionsV2)
      // Per-provider write: the codex file is untouched
      expect(readFileSafe(codexInstructionsPath())).toBe('')
    })

    test('linking a library variant syncs all provider files', async ({ mainWindow }) => {
      // Seed a library instruction variant via API
      const variantId = await mainWindow.evaluate(
        async ({ slug, content }) => {
          const existing = await window.getTrpcVanillaClient().aiConfig.listInstructionVariants.query()
          const match = existing.find((v) => v.slug === slug)
          if (match) {
            await window.getTrpcVanillaClient().aiConfig.updateItem.mutate({ id: match.id, content })
            return match.id
          }
          const created = await window.getTrpcVanillaClient().aiConfig.createItem.mutate({
            type: 'root_instructions',
            scope: 'library',
            slug,
            content
          })
          return created.id
        },
        { slug: variantSlug, content: variantContent }
      )

      const body = await openProjectContextSection(mainWindow, projectAbbrev, 'instructions')
      await body.getByRole('button', { name: 'Use library variant' }).click()
      const pickerDialog = mainWindow
        .getByRole('dialog')
        .filter({ hasText: 'Use Library Variant' })
        .last()
      await expect(pickerDialog).toBeVisible({ timeout: 5_000 })
      await pickerDialog.getByText(variantSlug, { exact: true }).click()

      // Linking writes the variant content to every provider file
      await expect.poll(() => readFileSafe(claudeInstructionsPath())).toBe(variantContent)
      await expect.poll(() => readFileSafe(codexInstructionsPath())).toBe(variantContent)

      // Linked mode is shown (variant chip button replaces the link button)
      await expect(body.getByRole('button', { name: variantSlug })).toBeVisible({ timeout: 5_000 })

      // Unlink to restore custom (per-file) mode for the remaining tests
      await body.getByTitle('Unlink variant').click()
      await expect(body.getByRole('button', { name: 'Use library variant' })).toBeVisible({
        timeout: 5_000
      })

      // Cleanup: drop the variant selection rows + the variant item so the
      // needsSync check later is not polluted by variant selections.
      await mainWindow.evaluate(
        async ({ id, pid }) => {
          try {
            await window
              .getTrpcVanillaClient()
              .aiConfig.removeProjectSelection.mutate({ projectId: pid, itemId: id })
          } catch {
            /* ignore */
          }
          await window.getTrpcVanillaClient().aiConfig.deleteItem.mutate({ id })
        },
        { id: variantId, pid: projectId }
      )
    })

    test('external disk change auto-reloads the open file editor', async ({ mainWindow }) => {
      fs.writeFileSync(claudeInstructionsPath(), instructionsV1)

      const { textarea } = await openInstructionsFile(mainWindow, 'CLAUDE.md')
      await expect(textarea).toHaveValue(instructionsV1, { timeout: 5_000 })

      const external = '# Externally modified\n'
      fs.writeFileSync(claudeInstructionsPath(), external)

      // Clean editor auto-reloads from disk via the file watcher
      await expect(textarea).toHaveValue(external, { timeout: 15_000 })
    })
  })

  // =========================================================================
  // Skills tests
  // =========================================================================

  test.describe('Skills', () => {
    test('skill editor auto-saves content to DB', async ({ mainWindow }) => {
      // Project-linked library skills are read-only in the project view; the
      // editable editor lives in Library → Skills.
      const body = await openLibrarySkills(mainWindow)
      await openSkillEditor(body, skillSlug)

      const content = body.getByTestId('context-item-editor-content')
      await expect(content).toBeVisible({ timeout: 5_000 })
      await expect(content).toHaveValue(
        new RegExp(
          `---\\nname: ${skillSlug}[\\s\\S]*${skillContentV1.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
        ),
        { timeout: 5_000 }
      )

      // Edit and verify auto-save (save fires on blur)
      await content.fill(skillDocument(skillSlug, skillContentV2))
      await content.blur()

      await expect
        .poll(
          () =>
            skillDbContentMatches(mainWindow, skillSlug, [
              `name: ${skillSlug}`,
              skillContentV2.trim()
            ]),
          { timeout: 5_000 }
        )
        .toBe(true)
    })

    test('Database → File pushes skill to specific provider', async ({ mainWindow }) => {
      const pendingBody = `# File sync skill provider push\n\n${Date.now()}\n`
      await updateLibrarySkillContent(mainWindow, skillSlug, skillDocument(skillSlug, pendingBody))

      const body = await openProjectSkills(mainWindow)
      await expect(body.getByTestId(`skill-row-${skillSlug}`)).toContainText('Stale', {
        timeout: 5_000
      })
      await openSkillEditor(body, skillSlug)

      await expect(body.getByTestId('context-item-editor-stale-banner')).toBeVisible({
        timeout: 5_000
      })
      await body.getByTestId('context-item-editor-sync-provider-claude').click()

      // Verify .claude/skills/{slug}/SKILL.md written with frontmatter
      await expect
        .poll(() => {
          const content = readFileSafe(claudeSkillPath())
          return content.includes(`name: ${skillSlug}`) && content.includes(pendingBody.trim())
        })
        .toBe(true)

      // Claude row now synced, codex still stale
      await expect(body.getByTestId('context-item-editor-provider-row-claude')).toContainText(
        'synced',
        { timeout: 5_000 }
      )
      await expect(body.getByTestId('context-item-editor-provider-row-codex')).toContainText(
        'stale',
        { timeout: 5_000 }
      )
    })

    test('Database → All Files pushes to all providers', async ({ mainWindow }) => {
      const pendingBody = `# File sync skill push all\n\n${Date.now()}\n`
      await updateLibrarySkillContent(mainWindow, skillSlug, skillDocument(skillSlug, pendingBody))

      const body = await openProjectSkills(mainWindow)
      await openSkillEditor(body, skillSlug)

      const banner = body.getByTestId('context-item-editor-stale-banner')
      await expect(banner).toBeVisible({ timeout: 5_000 })
      await body.getByTestId('context-item-editor-sync-all-to-disk').click()

      // Verify both provider files on disk
      await expect
        .poll(() => {
          const content = readFileSafe(claudeSkillPath())
          return content.includes(`name: ${skillSlug}`) && content.includes(pendingBody.trim())
        })
        .toBe(true)
      await expect
        .poll(() => {
          const content = readFileSafe(codexSkillPath())
          return content.includes(`name: ${skillSlug}`) && content.includes(pendingBody.trim())
        })
        .toBe(true)

      // Fully synced → stale banner disappears
      await expect(banner).toHaveCount(0, { timeout: 5_000 })
    })

    test('stale detection after external disk modification', async ({ mainWindow }) => {
      // Externally modify the claude skill file
      const modified = '---\nname: modified\n---\n# Modified externally\n'
      fs.writeFileSync(claudeSkillPath(), modified)

      const body = await openProjectSkills(mainWindow)

      // Row shows stale aggregate
      await expect(body.getByTestId(`skill-row-${skillSlug}`)).toContainText('Stale', {
        timeout: 5_000
      })

      // Editor shows per-provider status: claude stale, codex still synced
      await openSkillEditor(body, skillSlug)
      await expect(body.getByTestId('context-item-editor-provider-row-claude')).toContainText(
        'stale',
        { timeout: 5_000 }
      )
      await expect(body.getByTestId('context-item-editor-provider-row-codex')).toContainText(
        'synced',
        { timeout: 5_000 }
      )
    })

    test('stale skill shows pull action', async ({ mainWindow }) => {
      const modified = '---\nname: modified\n---\n# Modified externally\n'
      fs.writeFileSync(claudeSkillPath(), modified)

      const body = await openProjectSkills(mainWindow)
      await openSkillEditor(body, skillSlug)

      await expect(body.getByTestId('context-item-editor-provider-row-claude')).toContainText(
        'stale',
        { timeout: 5_000 }
      )
      await expect(body.getByTestId('context-item-editor-pull-provider-claude')).toBeVisible({
        timeout: 5_000
      })
    })

    test('File → Database pulls from File and keeps raw frontmatter', async ({ mainWindow }) => {
      const modified = '---\nname: modified\n---\n# Modified externally\n'
      fs.writeFileSync(claudeSkillPath(), modified)

      const body = await openProjectSkills(mainWindow)
      await openSkillEditor(body, skillSlug)
      await expect(body.getByTestId('context-item-editor-provider-row-claude')).toContainText(
        'stale',
        { timeout: 5_000 }
      )

      const pullClaude = body.getByTestId('context-item-editor-pull-provider-claude')
      await expect(pullClaude).toBeVisible({ timeout: 5_000 })
      await pullClaude.click()

      // Verify DB content updated with the raw skill document
      await expect
        .poll(
          () =>
            skillDbContentMatches(mainWindow, skillSlug, [
              'name: modified',
              '# Modified externally'
            ]),
          { timeout: 5_000 }
        )
        .toBe(true)
    })

    test('filename rename updates slug', async ({ mainWindow }) => {
      const newSlug = 'e2e-file-sync-renamed'

      // Rename is done in the editable library editor (project view is read-only
      // for linked library skills). Rename saves on blur of the filename input.
      const body = await openLibrarySkills(mainWindow)
      await openSkillEditor(body, skillSlug)

      const slugInput = body.getByTestId('context-item-editor-slug')
      await slugInput.fill(newSlug)
      await slugInput.blur()

      // Verify slug updated in DB
      await expect
        .poll(
          async () => {
            return await mainWindow.evaluate(async (slug) => {
              const items = await window.getTrpcVanillaClient().aiConfig.listItems.query({
                scope: 'library',
                type: 'skill'
              })
              return items.some((i) => i.slug === slug)
            }, newSlug)
          },
          { timeout: 5_000 }
        )
        .toBe(true)

      // Verify new row visible
      await expect(body.getByTestId(`skill-row-${newSlug}`)).toBeVisible({ timeout: 5_000 })

      // Rename back for subsequent tests
      await slugInput.fill(skillSlug)
      await slugInput.blur()
      await expect(body.getByTestId(`skill-row-${skillSlug}`)).toBeVisible({ timeout: 5_000 })
    })

    test('managed skill shows frontmatter in the editor and becomes invalid if it is removed', async ({
      mainWindow
    }) => {
      const body = await openLibrarySkills(mainWindow)
      await openSkillEditor(body, skillSlug)

      const contentInput = body.getByTestId('context-item-editor-content')
      await expect(contentInput).toBeVisible({ timeout: 5_000 })
      await expect(contentInput).toHaveValue(/---\nname: /, { timeout: 5_000 })
      await contentInput.fill(releasePromptBody)
      await contentInput.blur()

      await expect
        .poll(
          async () => {
            return await mainWindow.evaluate(async (slug) => {
              const items = await window.getTrpcVanillaClient().aiConfig.listItems.query({
                scope: 'library',
                type: 'skill'
              })
              const match = items.find((item) => item.slug === slug)
              if (!match) return null
              const metadata = JSON.parse(match.metadata_json) as {
                skillValidation?: { status?: string }
              }
              return metadata.skillValidation?.status ?? null
            }, skillSlug)
          },
          { timeout: 5_000 }
        )
        .toBe('invalid')

      await expect(body.getByText('Frontmatter is invalid')).toBeVisible({ timeout: 5_000 })
      await expect(body.getByText(/Skill content must start with YAML frontmatter/i)).toBeVisible({
        timeout: 5_000
      })
      // The repair affordance is offered
      await expect(body.getByTestId('context-item-editor-fix-frontmatter')).toBeVisible({
        timeout: 5_000
      })

      // Restore valid content for the remaining tests
      await contentInput.fill(skillDocument(skillSlug, skillContentV1))
      await contentInput.blur()
      await expect
        .poll(
          () =>
            skillDbContentMatches(mainWindow, skillSlug, [
              `name: ${skillSlug}`,
              skillContentV1.trim()
            ]),
          { timeout: 5_000 }
        )
        .toBe(true)
    })

    test('Database → File after pull re-syncs File', async ({ mainWindow }) => {
      const resyncedBody = '# Re-synced after pull\n'
      await updateLibrarySkillContent(mainWindow, skillSlug, skillDocument(skillSlug, resyncedBody))

      const body = await openProjectSkills(mainWindow)
      await expect(body.getByTestId(`skill-row-${skillSlug}`)).toContainText('Stale', {
        timeout: 5_000
      })
      await openSkillEditor(body, skillSlug)

      const banner = body.getByTestId('context-item-editor-stale-banner')
      await expect(banner).toBeVisible({ timeout: 5_000 })
      await body.getByTestId('context-item-editor-sync-all-to-disk').click()

      // Verify files on disk
      await expect
        .poll(() => readFileSafe(claudeSkillPath()).includes(resyncedBody.trim()))
        .toBe(true)
      await expect
        .poll(() => {
          const content = readFileSafe(codexSkillPath())
          return content.includes(`name: ${skillSlug}`) && content.includes(resyncedBody.trim())
        })
        .toBe(true)

      // Fully synced → banner gone
      await expect(banner).toHaveCount(0, { timeout: 5_000 })
    })
  })

  // =========================================================================
  // Cross-feature tests
  // =========================================================================
  // REMOVED 2026-07-02: 'full instructions roundtrip: push → external edit →
  // stale → pull' — it exercised the dropped instructions push/pull/stale-card
  // affordances end-to-end. Each constituent behavior that survived the
  // redesign (file edit → disk, variant → all files, external change → reload)
  // is covered by the migrated Instructions tests above.
  // REMOVED 2026-07-02: 'unmanaged skill can be managed from row button' — the
  // manage button no longer exists; opening Project → Skills auto-reconciles
  // disk-only skills into managed project skills (covered below).

  test.describe('Integration', () => {
    test('needsSync returns false after instructions and skills are synced', async ({
      mainWindow
    }) => {
      const aligned = '# needsSync aligned instructions\n'
      await setInstructionsContent(mainWindow, projectId, aligned)

      // Seed sentinels so the editor-load race is deterministic when switching files
      fs.writeFileSync(claudeInstructionsPath(), '# sentinel claude\n')
      fs.writeFileSync(codexInstructionsPath(), '# sentinel codex\n')

      // Align both provider files with the DB content via the file editor
      const { body, textarea } = await openInstructionsFile(mainWindow, 'CLAUDE.md')
      await expect(textarea).toHaveValue('# sentinel claude\n', { timeout: 5_000 })
      await textarea.fill(aligned)
      await textarea.blur()
      await expect.poll(() => readFileSafe(claudeInstructionsPath())).toBe(aligned)

      await body.getByRole('button').filter({ hasText: 'AGENTS.md' }).first().click()
      await expect(textarea).toHaveValue('# sentinel codex\n', { timeout: 5_000 })
      await textarea.fill(aligned)
      await textarea.blur()
      await expect.poll(() => readFileSafe(codexInstructionsPath())).toBe(aligned)

      // Sync the linked skill if any provider is still stale
      const skillsBody = await openProjectSkills(mainWindow)
      const row = skillsBody.getByTestId(`skill-row-${skillSlug}`)
      await expect(row).toBeVisible({ timeout: 5_000 })
      if (
        await row
          .getByText('Stale')
          .isVisible({ timeout: 1_000 })
          .catch(() => false)
      ) {
        await openSkillEditor(skillsBody, skillSlug)
        await skillsBody.getByTestId('context-item-editor-sync-all-to-disk').click()
        await expect(skillsBody.getByTestId('context-item-editor-stale-banner')).toHaveCount(0, {
          timeout: 5_000
        })
      }

      // Verify needsSync is false
      await expect
        .poll(async () => {
          return await mainWindow.evaluate(
            ({ id, projectPath }) => {
              return window
                .getTrpcVanillaClient()
                .aiConfig.needsSync.query({ projectId: id, projectPath })
            },
            { id: projectId, projectPath: TEST_PROJECT_PATH }
          )
        })
        .toBe(false)
    })

    test('disk-only skills are auto-managed into the project', async ({ mainWindow }) => {
      fs.mkdirSync(path.dirname(unmanagedCodexSkillPath()), { recursive: true })
      fs.writeFileSync(unmanagedCodexSkillPath(), unmanagedSkillContent)

      // Opening Project → Skills reconciles disk-only skill files into managed
      // project skills (replaces the old 'Unmanaged' row + manage button).
      const body = await openProjectSkills(mainWindow)
      await expect(body.getByTestId(`skill-row-${unmanagedSkillSlug}`)).toBeVisible({
        timeout: 10_000
      })

      // DB item created (project scope) and the codex provider reports synced
      await expect
        .poll(async () => {
          return await mainWindow.evaluate(
            async ({ id, projectPath, slug }) => {
              const statuses = await window
                .getTrpcVanillaClient()
                .aiConfig.getProjectSkillsStatus.query({ projectId: id, projectPath })
              const status = statuses.find((entry) => entry.item.slug === slug)
              return status?.providers.codex?.syncHealth ?? null
            },
            { id: projectId, projectPath: TEST_PROJECT_PATH, slug: unmanagedSkillSlug }
          )
        })
        .toBe('synced')
    })

    test('frontmatter-only DB metadata changes mark both linked providers stale', async ({
      mainWindow
    }) => {
      await mainWindow.evaluate(
        async ({ id, projectPath, slug, initialContent, updatedContent }) => {
          const existing = await window.getTrpcVanillaClient().aiConfig.listItems.query({
            scope: 'library',
            type: 'skill'
          })
          const match = existing.find((item) => item.slug === slug)
          const item = match
            ? await window.getTrpcVanillaClient().aiConfig.updateItem.mutate({ id: match.id, content: initialContent })
            : await window.getTrpcVanillaClient().aiConfig.createItem.mutate({
                type: 'skill',
                scope: 'library',
                slug,
                content: initialContent
              })
          if (!item) throw new Error('Could not create frontmatter mismatch skill')

          await window
            .getTrpcVanillaClient()
            .aiConfig.removeProjectSelection.mutate({ projectId: id, itemId: item.id })
          await window.getTrpcVanillaClient().aiConfig.loadLibraryItem.mutate({
            projectId: id,
            projectPath,
            itemId: item.id,
            providers: ['claude', 'codex']
          })
          await window.getTrpcVanillaClient().aiConfig.updateItem.mutate({ id: item.id, content: updatedContent })
        },
        {
          id: projectId,
          projectPath: TEST_PROJECT_PATH,
          slug: frontmatterMismatchSkillSlug,
          initialContent: skillDocument(
            frontmatterMismatchSkillSlug,
            frontmatterMismatchSkillInitialContent
          ),
          updatedContent: frontmatterMismatchSkillDbContent
        }
      )

      await expect
        .poll(() => {
          const content = readFileSafe(frontmatterMismatchCodexPath())
          return (
            content.includes(`name: ${frontmatterMismatchSkillSlug}`) &&
            content.includes(frontmatterMismatchSkillInitialContent.trim())
          )
        })
        .toBe(true)
      await expect
        .poll(async () => {
          return await mainWindow.evaluate(
            async ({ id, projectPath, slug }) => {
              const statuses = await window
                .getTrpcVanillaClient()
                .aiConfig.getProjectSkillsStatus.query({ projectId: id, projectPath })
              const skill = statuses.find((entry) => entry.item.slug === slug)
              return {
                claude: skill?.providers.claude?.syncHealth ?? null,
                codex: skill?.providers.codex?.syncHealth ?? null
              }
            },
            { id: projectId, projectPath: TEST_PROJECT_PATH, slug: frontmatterMismatchSkillSlug }
          )
        })
        .toEqual({ claude: 'stale', codex: 'stale' })

      const body = await openProjectSkills(mainWindow)
      await expect(body.getByTestId(`skill-row-${frontmatterMismatchSkillSlug}`)).toContainText(
        'Stale',
        { timeout: 5_000 }
      )

      await openSkillEditor(body, frontmatterMismatchSkillSlug)
      await expect(body.getByTestId('context-item-editor-provider-row-claude')).toContainText(
        'stale',
        { timeout: 5_000 }
      )
      await expect(body.getByTestId('context-item-editor-provider-row-codex')).toContainText(
        'stale',
        { timeout: 5_000 }
      )
    })

    test('row status uses linked providers only', async ({ mainWindow }) => {
      await mainWindow.evaluate(
        async ({ id, projectPath, slug, content }) => {
          const existing = await window.getTrpcVanillaClient().aiConfig.listItems.query({
            scope: 'library',
            type: 'skill'
          })
          const match = existing.find((item) => item.slug === slug)
          const item = match
            ? await window.getTrpcVanillaClient().aiConfig.updateItem.mutate({ id: match.id, content })
            : await window.getTrpcVanillaClient().aiConfig.createItem.mutate({
                type: 'skill',
                scope: 'library',
                slug,
                content
              })
          if (!item) throw new Error('Could not create codex-only skill')

          await window
            .getTrpcVanillaClient()
            .aiConfig.removeProjectSelection.mutate({ projectId: id, itemId: item.id })
          await window.getTrpcVanillaClient().aiConfig.loadLibraryItem.mutate({
            projectId: id,
            projectPath,
            itemId: item.id,
            providers: ['codex']
          })
        },
        {
          id: projectId,
          projectPath: TEST_PROJECT_PATH,
          slug: codexOnlySkillSlug,
          content: skillDocument(codexOnlySkillSlug, codexOnlySkillContent)
        }
      )

      await expect
        .poll(() => {
          const content = readFileSafe(codexOnlySkillPath())
          return (
            content.includes(`name: ${codexOnlySkillSlug}`) &&
            content.includes(codexOnlySkillContent.trim())
          )
        })
        .toBe(true)

      // The missing claude file must NOT mark the row stale — claude is not linked.
      const body = await openProjectSkills(mainWindow)
      const row = body.getByTestId(`skill-row-${codexOnlySkillSlug}`)
      await expect(row).toBeVisible({ timeout: 5_000 })
      await expect(row).not.toContainText('Stale')

      // Editor shows no stale banner either
      await openSkillEditor(body, codexOnlySkillSlug)
      await expect(body.getByTestId('context-item-editor-stale-banner')).toHaveCount(0)
    })

    // MIGRATED 2026-07-02: the 'Unmanaged' row badge no longer exists — opening
    // Project → Skills auto-reconciles an unmanaged file on an unlinked provider
    // into a linked selection, which then reports stale (file ≠ DB content).
    test('unmanaged file on unlinked provider is auto-linked and marked stale', async ({
      mainWindow
    }) => {
      await mainWindow.evaluate(
        async ({ id, projectPath, slug, content }) => {
          const existing = await window.getTrpcVanillaClient().aiConfig.listItems.query({
            scope: 'library',
            type: 'skill'
          })
          const match = existing.find((item) => item.slug === slug)
          const item = match
            ? await window.getTrpcVanillaClient().aiConfig.updateItem.mutate({ id: match.id, content })
            : await window.getTrpcVanillaClient().aiConfig.createItem.mutate({
                type: 'skill',
                scope: 'library',
                slug,
                content
              })
          if (!item) throw new Error('Could not create codex-only skill with unmanaged claude')

          await window
            .getTrpcVanillaClient()
            .aiConfig.removeProjectSelection.mutate({ projectId: id, itemId: item.id })
          await window.getTrpcVanillaClient().aiConfig.loadLibraryItem.mutate({
            projectId: id,
            projectPath,
            itemId: item.id,
            providers: ['codex']
          })
        },
        {
          id: projectId,
          projectPath: TEST_PROJECT_PATH,
          slug: codexOnlyWithUnmanagedClaudeSlug,
          content: skillDocument(
            codexOnlyWithUnmanagedClaudeSlug,
            codexOnlyWithUnmanagedClaudeContent
          )
        }
      )

      await expect
        .poll(() => {
          const content = readFileSafe(codexOnlyWithUnmanagedClaudeCodexPath())
          return (
            content.includes(`name: ${codexOnlyWithUnmanagedClaudeSlug}`) &&
            content.includes(codexOnlyWithUnmanagedClaudeContent.trim())
          )
        })
        .toBe(true)
      fs.mkdirSync(path.dirname(codexOnlyWithUnmanagedClaudeClaudePath()), { recursive: true })
      fs.writeFileSync(codexOnlyWithUnmanagedClaudeClaudePath(), '# unmanaged claude version\n')

      const body = await openProjectSkills(mainWindow)
      const row = body.getByTestId(`skill-row-${codexOnlyWithUnmanagedClaudeSlug}`)
      await expect(row).toContainText('Stale', { timeout: 10_000 })

      // Reconcile linked the claude provider; its file content differs from DB
      await expect
        .poll(async () => {
          return await mainWindow.evaluate(
            async ({ id, projectPath, slug }) => {
              const statuses = await window
                .getTrpcVanillaClient()
                .aiConfig.getProjectSkillsStatus.query({ projectId: id, projectPath })
              const status = statuses.find((entry) => entry.item.slug === slug)
              return status?.providers.claude?.syncHealth ?? null
            },
            { id: projectId, projectPath: TEST_PROJECT_PATH, slug: codexOnlyWithUnmanagedClaudeSlug }
          )
        })
        .toBe('stale')
    })
  })

  test.afterAll(async ({ mainWindow }) => {
    await closeTopDialog(mainWindow).catch(() => {})
  })
})
