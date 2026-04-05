import { test, expect, seed, goHome, clickProject, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import fs from 'fs'
import path from 'path'

test.describe('File editor', () => {
  let projectAbbrev: string

  /** The editor panel wrapper (surface panel containing "Files" heading) */
  const editorPanel = (page: import('@playwright/test').Page) =>
    page.locator('[data-panel-id="editor"]:visible').filter({ hasText: 'Files' })

  /** File tree entry by name (tree buttons have w-full, tab buttons don't) */
  const treeFile = (page: import('@playwright/test').Page, name: string) =>
    editorPanel(page).locator(`button.w-full:has-text("${name}")`).first()

  /** Editor tab by filename (tab buttons have title=filePath) */
  const editorTab = (page: import('@playwright/test').Page, name: string) =>
    page.locator(`button[title$="${name}"]:visible`).first()

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    // Create test files in the test project directory
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'hello.ts'), 'export const hello = "world"\n')
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'second.ts'), 'export const second = 2\n')
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'readme.md'), '# Test\n\nA test file.\n')
    fs.mkdirSync(path.join(TEST_PROJECT_PATH, 'src'), { recursive: true })
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'src', 'index.ts'), 'console.log("hi")\n')
    // Create a .gitignore
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, '.gitignore'), 'node_modules\ndist\n*.log\n')
    // Create an ignored directory
    fs.mkdirSync(path.join(TEST_PROJECT_PATH, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'node_modules', 'pkg.json'), '{}')
    fs.mkdirSync(path.join(TEST_PROJECT_PATH, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'dist', 'bundle.js'), '')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'FEditor Test', color: '#10b981', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Editor test task', status: 'todo' })
    await s.refreshData()

    // Navigate to task
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Editor test task').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('Editor test task').first().click()
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })

    // Toggle editor panel on via Cmd+E
    await mainWindow.keyboard.press('Meta+e')
    await expect(editorPanel(mainWindow).getByText('Files')).toBeVisible({ timeout: 5_000 })
  })

  // --- .gitignore awareness ---

  test('editor panel is visible with file tree', async ({ mainWindow }) => {
    // Editor button in PanelToggle should have active class (bg-muted)
    const btn = mainWindow.locator('.bg-surface-2.rounded-lg:visible').locator('button:has-text("Editor")')
    await expect(btn).toHaveClass(/bg-muted/)
    await expect(editorPanel(mainWindow).getByText('Files')).toBeVisible()
  })

  test('file tree shows project files', async ({ mainWindow }) => {
    await expect(treeFile(mainWindow, 'hello.ts')).toBeVisible({ timeout: 5_000 })
    await expect(treeFile(mainWindow, 'second.ts')).toBeVisible()
    await expect(treeFile(mainWindow, 'readme.md')).toBeVisible()
    await expect(treeFile(mainWindow, 'src')).toBeVisible()
  })

  test('file tree includes node_modules and dist entries', async ({ mainWindow }) => {
    await expect(editorPanel(mainWindow).getByText('node_modules')).toBeVisible()
    await expect(editorPanel(mainWindow).getByText('dist')).toBeVisible()
  })

  test('.gitignore itself is visible (not ignored)', async ({ mainWindow }) => {
    await expect(treeFile(mainWindow, '.gitignore')).toBeVisible()
  })

  // --- Open file + tabs ---

  test('clicking a file opens it in editor with tab', async ({ mainWindow }) => {
    await treeFile(mainWindow, 'hello.ts').click()

    // Tab should appear
    await expect(editorTab(mainWindow, 'hello.ts')).toBeVisible()
    // CodeMirror should render
    await expect(mainWindow.locator('.cm-editor:visible .cm-content')).toBeVisible()
  })

  test('opening another file creates a second tab', async ({ mainWindow }) => {
    await treeFile(mainWindow, 'second.ts').click()

    await expect(editorTab(mainWindow, 'hello.ts')).toBeVisible({ timeout: 5_000 })
    await expect(editorTab(mainWindow, 'second.ts')).toBeVisible({ timeout: 5_000 })
  })

  // --- Large file guard ---

  test('large file shows "too large" message', async ({ mainWindow }) => {
    // Create a file > 1MB
    const largePath = path.join(TEST_PROJECT_PATH, 'large.txt')
    fs.writeFileSync(largePath, 'x'.repeat(1.5 * 1024 * 1024))

    await expect(treeFile(mainWindow, 'large.txt')).toBeVisible({ timeout: 5_000 })
    await treeFile(mainWindow, 'large.txt').click()

    await expect(mainWindow.getByText('File too large').first()).toBeVisible({ timeout: 5_000 })
    await expect(mainWindow.getByRole('button', { name: 'Open anyway' }).first()).toBeVisible()

    // Clean up
    fs.unlinkSync(largePath)
  })

  test('"Open anyway" bypasses size limit', async ({ mainWindow }) => {
    // Create a file just over 1MB but under 10MB
    const mediumPath = path.join(TEST_PROJECT_PATH, 'medium.txt')
    const content = 'hello '.repeat(200_000) // ~1.2MB
    fs.writeFileSync(mediumPath, content)

    await expect(treeFile(mainWindow, 'medium.txt')).toBeVisible({ timeout: 5_000 })
    await treeFile(mainWindow, 'medium.txt').click()

    await expect(mainWindow.getByText('File too large').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByRole('button', { name: 'Open anyway' }).first().click()

    // Should now show CodeMirror editor
    await expect(mainWindow.locator('.cm-editor:visible')).toBeVisible({ timeout: 5_000 })

    fs.unlinkSync(mediumPath)
  })

  // --- Dirty indicator ---

  test('editing a file shows dirty indicator dot on tab', async ({ mainWindow }) => {
    // Open hello.ts via tree (ensures tab is active even if prior tests changed state)
    await treeFile(mainWindow, 'hello.ts').click()

    // Type something in the CodeMirror editor
    await mainWindow.locator('.cm-editor:visible .cm-content').click()
    await mainWindow.keyboard.type('// modified')

    // Dirty dot should appear (conditionally rendered — check DOM presence)
    const tab = editorTab(mainWindow, 'hello.ts')
    await expect(tab.locator('.rounded-full')).toHaveCount(1)
  })

  // --- Unsaved changes warning ---

  test('closing dirty tab shows unsaved changes dialog', async ({ mainWindow }) => {
    // hello.ts is dirty from previous test — close it
    const tab = editorTab(mainWindow, 'hello.ts')
    // Hover to reveal close button, then click X
    await tab.hover()
    await tab.locator('.lucide-x').click()

    // AlertDialog should appear
    await expect(mainWindow.getByRole('heading', { name: 'Unsaved changes' })).toBeVisible({ timeout: 3_000 })
    await expect(mainWindow.getByText('hello.ts has unsaved changes')).toBeVisible()

    // Cancel — should keep the tab open
    await mainWindow.getByRole('button', { name: 'Cancel' }).click()
    await expect(editorTab(mainWindow, 'hello.ts')).toBeVisible()
  })

  test('discard closes dirty tab without saving', async ({ mainWindow }) => {
    const tab = editorTab(mainWindow, 'hello.ts')
    await tab.hover()
    await tab.locator('.lucide-x').click()

    await mainWindow.getByRole('button', { name: 'Discard' }).click()

    // Tab should be gone
    await expect(editorTab(mainWindow, 'hello.ts')).not.toBeVisible()

    // File on disk should be unchanged
    const content = fs.readFileSync(path.join(TEST_PROJECT_PATH, 'hello.ts'), 'utf-8')
    expect(content).toBe('export const hello = "world"\n')
  })

  // --- External file change detection ---

  test('external file change reloads clean file in editor', async ({ mainWindow }) => {
    // Open hello.ts fresh
    await treeFile(mainWindow, 'hello.ts').click()

    // Modify file on disk externally
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'hello.ts'), 'export const hello = "changed"\n')

    // Wait for watcher to detect + debounce + reload
    await expect.poll(
      async () => await mainWindow.locator('.cm-editor:visible .cm-content').textContent(),
      { timeout: 5_000 }
    ).toContain('changed')

    // Restore original
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'hello.ts'), 'export const hello = "world"\n')
  })

  test('external change on dirty file shows "changed" indicator', async ({ mainWindow }) => {
    // Open hello.ts, make it dirty
    await treeFile(mainWindow, 'hello.ts').click()
    await mainWindow.locator('.cm-editor:visible .cm-content').click()
    await mainWindow.keyboard.type('// dirty edit')

    // Modify file on disk externally
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'hello.ts'), 'export const hello = "disk change"\n')

    // Should show "changed" label on the tab (not auto-reload because dirty)
    await expect(editorTab(mainWindow, 'hello.ts').getByText('changed')).toBeVisible({ timeout: 5_000 })

    // Discard the tab to clean up
    const tab = editorTab(mainWindow, 'hello.ts')
    await tab.hover()
    await tab.locator('.lucide-x').click()
    await mainWindow.getByRole('button', { name: 'Discard' }).click()

    // Restore original
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'hello.ts'), 'export const hello = "world"\n')
  })

  test('new file created externally appears in tree', async ({ mainWindow }) => {
    // Create a new file
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'newfile.ts'), 'export const x = 1\n')

    await expect(treeFile(mainWindow, 'newfile.ts')).toBeVisible({ timeout: 5_000 })

    fs.unlinkSync(path.join(TEST_PROJECT_PATH, 'newfile.ts'))
  })

  // --- Quick open (Cmd+P) ---

  test('Cmd+P opens quick open dialog', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Meta+p')

    // Should see the dialog with search input
    await expect(mainWindow.getByPlaceholder('Open file by name...')).toBeVisible({ timeout: 3_000 })

    // Should list project files
    await expect(mainWindow.locator('[cmdk-item]').first()).toBeVisible({ timeout: 5_000 })

    // Close dialog
    await mainWindow.keyboard.press('Escape')
  })

  test('quick open filters files by query', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Meta+p')

    const input = mainWindow.getByPlaceholder('Open file by name...')
    await input.fill('hello')

    // Should show hello.ts
    await expect(mainWindow.locator('[cmdk-item]').filter({ hasText: 'hello.ts' })).toBeVisible()

    // Close
    await mainWindow.keyboard.press('Escape')
  })

  test('quick open does not show gitignored files', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Meta+p')

    const input = mainWindow.getByPlaceholder('Open file by name...')
    await input.fill('pkg.json')

    // Should show "No files found" since node_modules/pkg.json is gitignored
    await expect(mainWindow.getByText('No files found.')).toBeVisible()

    await mainWindow.keyboard.press('Escape')
  })

  test('selecting a file in quick open opens it', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Meta+p')

    const input = mainWindow.getByPlaceholder('Open file by name...')
    await input.fill('index.ts')

    // Select the first match
    await mainWindow.locator('[cmdk-item]').filter({ hasText: 'index.ts' }).first().click()

    // Tab should appear for src/index.ts
    await expect(editorTab(mainWindow, 'index.ts')).toBeVisible()
  })

  // --- Cmd+S save ---

  test('Cmd+S saves the file', async ({ mainWindow }) => {
    // Open hello.ts via tree and edit it
    await treeFile(mainWindow, 'hello.ts').click()
    await mainWindow.locator('.cm-editor:visible .cm-content').click()

    // Select all and replace
    await mainWindow.keyboard.press('Meta+a')
    await mainWindow.keyboard.type('export const hello = "saved"\n')

    // Dirty indicator should exist (conditionally rendered)
    await expect(editorTab(mainWindow, 'hello.ts').locator('.rounded-full')).toHaveCount(1)

    // Save with Cmd+S (CodeMirror intercepts this)
    await mainWindow.keyboard.press('Meta+s')

    // Dirty indicator should be gone
    await expect(editorTab(mainWindow, 'hello.ts').locator('.rounded-full')).toHaveCount(0)

    // File on disk should be updated
    const content = fs.readFileSync(path.join(TEST_PROJECT_PATH, 'hello.ts'), 'utf-8')
    expect(content).toContain('saved')

    // Restore
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'hello.ts'), 'export const hello = "world"\n')
  })

  // --- Editor state persistence ---

  test('open files persist across editor panel toggle', async ({ mainWindow }) => {
    // Open hello.ts and second.ts
    await treeFile(mainWindow, 'hello.ts').click()
    await treeFile(mainWindow, 'second.ts').click()

    // Verify both tabs exist
    await expect(editorTab(mainWindow, 'hello.ts')).toBeVisible()
    await expect(editorTab(mainWindow, 'second.ts')).toBeVisible()

    // Wait for debounced save to DB (500ms + margin)
    await mainWindow.waitForTimeout(800)

    // Toggle editor panel off
    await mainWindow.keyboard.press('Meta+e')
    await expect(editorPanel(mainWindow)).not.toBeVisible()

    // Toggle editor panel back on
    await mainWindow.keyboard.press('Meta+e')
    await expect(editorPanel(mainWindow).getByText('Files')).toBeVisible({ timeout: 5_000 })

    // Both tabs should be restored
    await expect(editorTab(mainWindow, 'hello.ts')).toBeVisible({ timeout: 5_000 })
    await expect(editorTab(mainWindow, 'second.ts')).toBeVisible()
  })

  test('active file persists across editor panel toggle', async ({ mainWindow }) => {
    // Click hello.ts to make it active
    await editorTab(mainWindow, 'hello.ts').click()
    await expect(editorTab(mainWindow, 'hello.ts')).toHaveClass(/border/)

    // Wait for debounced save
    await mainWindow.waitForTimeout(800)

    // Toggle editor off/on
    await mainWindow.keyboard.press('Meta+e')
    await mainWindow.keyboard.press('Meta+e')
    await expect(editorPanel(mainWindow).getByText('Files')).toBeVisible({ timeout: 5_000 })

    // hello.ts should still be active (has border class)
    await expect(editorTab(mainWindow, 'hello.ts')).toBeVisible({ timeout: 5_000 })
    await expect(editorTab(mainWindow, 'hello.ts')).toHaveClass(/border/)
  })

  test('deleted file silently skipped on restore', async ({ mainWindow }) => {
    // Create a temp file and open it
    const tempPath = path.join(TEST_PROJECT_PATH, 'temp-persist.ts')
    fs.writeFileSync(tempPath, 'export const temp = true\n')

    await expect(treeFile(mainWindow, 'temp-persist.ts')).toBeVisible({ timeout: 5_000 })
    await treeFile(mainWindow, 'temp-persist.ts').click()
    await expect(editorTab(mainWindow, 'temp-persist.ts')).toBeVisible()

    // Wait for debounced save
    await mainWindow.waitForTimeout(800)

    // Toggle editor off
    await mainWindow.keyboard.press('Meta+e')
    await expect(editorPanel(mainWindow)).not.toBeVisible()

    // Delete the file while editor is closed
    fs.unlinkSync(tempPath)

    // Toggle editor back on
    await mainWindow.keyboard.press('Meta+e')
    await expect(editorPanel(mainWindow).getByText('Files')).toBeVisible({ timeout: 5_000 })

    // temp-persist.ts should NOT be restored (file doesn't exist)
    await expect(editorTab(mainWindow, 'temp-persist.ts')).not.toBeVisible()

    // Other files should still be there
    await expect(editorTab(mainWindow, 'hello.ts')).toBeVisible({ timeout: 5_000 })
  })

  test('tree visibility persists across editor panel toggle', async ({ mainWindow }) => {
    // Hide the file tree
    const hideBtn = mainWindow.locator('button[title="Hide file tree"]:visible').first()
    await expect(hideBtn).toBeVisible()
    await hideBtn.click()

    // Show button should appear (tree is hidden)
    await expect(mainWindow.locator('button[title="Show file tree"]:visible').first()).toBeVisible()

    // Wait for debounced save
    await mainWindow.waitForTimeout(800)

    // Toggle editor off/on
    await mainWindow.keyboard.press('Meta+e')
    await mainWindow.keyboard.press('Meta+e')

    // Wait for tabs to restore (proves editor remounted)
    await expect(editorTab(mainWindow, 'hello.ts')).toBeVisible({ timeout: 5_000 })

    // Tree should still be hidden — "Show file tree" button visible
    await expect(mainWindow.locator('button[title="Show file tree"]:visible').first()).toBeVisible()

    // Restore tree visibility for subsequent tests
    await mainWindow.locator('button[title="Show file tree"]:visible').first().click()
    await expect(editorPanel(mainWindow).getByText('Files')).toBeVisible()
  })

  // --- Drag and drop within file tree ---

  test('drag file into folder moves it', async ({ mainWindow }) => {
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'dragme.txt'), 'drag content\n')
    fs.mkdirSync(path.join(TEST_PROJECT_PATH, 'target-folder'), { recursive: true })

    await expect(treeFile(mainWindow, 'dragme.txt')).toBeVisible({ timeout: 5_000 })
    await expect(treeFile(mainWindow, 'target-folder')).toBeVisible({ timeout: 5_000 })

    // Dispatch DnD events manually — synthetic DragEvent has null dataTransfer,
    // but the tree DnD logic uses refs (set by dragstart) not dataTransfer.
    await mainWindow.evaluate(async () => {
      const allButtons = Array.from(document.querySelectorAll('button.w-full'))
        .filter(b => b.offsetParent !== null)
      const srcBtn = allButtons.find(b => b.textContent?.includes('dragme.txt'))
      const tgtBtn = allButtons.find(b => b.textContent?.includes('target-folder'))
      if (!srcBtn || !tgtBtn) throw new Error('buttons not found')

      // Drop target is the wrapper div (parent of ContextMenu > button)
      const tgtWrapper = tgtBtn.parentElement!

      srcBtn.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 50))

      tgtWrapper.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true }))
      tgtWrapper.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 50))

      tgtWrapper.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 1500))

      srcBtn.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }))
    })

    expect(fs.existsSync(path.join(TEST_PROJECT_PATH, 'dragme.txt'))).toBe(false)
    expect(fs.existsSync(path.join(TEST_PROJECT_PATH, 'target-folder', 'dragme.txt'))).toBe(true)

    // Cleanup
    fs.rmSync(path.join(TEST_PROJECT_PATH, 'target-folder'), { recursive: true })
  })
})
