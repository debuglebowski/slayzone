import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { app } from 'electron'
import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type {
  AiConfigItem,
  AiConfigProjectSelection,
  CliProvider,
  CliProviderInfo,
  ContextFileInfo,
  ContextFileCategory,
  ContextTreeEntry,
  CreateAiConfigItemInput,
  ListAiConfigItemsInput,
  LoadLibraryItemInput,
  McpConfigFileResult,
  McpTarget,
  McpServerConfig,
  ProjectSkillStatus,
  ProviderFileContent,
  SyncHealth,
  SyncReason,
  RootInstructionsResult,
  SetAiConfigProjectSelectionInput,
  SyncAllInput,
  SyncConflict,
  SyncResult,
  UpdateAiConfigItemInput,
  WriteMcpServerInput,
  RemoveMcpServerInput,
  WriteComputerMcpServerInput,
  RemoveComputerMcpServerInput,
} from '../shared'
import {
  parseSkillFrontmatter,
  deriveSkillValidation
} from '../shared'
import {
  PROVIDER_PATHS,
  PROVIDER_LABELS,
  COMPUTER_PROVIDER_PATHS,
  isConfigurableCliProvider,
  filterConfigurableCliProviders,
  isConfigurableMcpTarget,
  getConfigurableMcpTargets,
  PROJECT_MCP_SPECS,
  COMPUTER_MCP_SPECS,
} from '../shared/provider-registry'
import type { McpConfigSpec } from '../shared/provider-registry'
import type { ComputerFileEntry } from '../shared'
import { skillSlugFromContextPath } from '../shared/skill-slug'
import { registerMarketplaceHandlers } from './handlers-marketplace'
import {
  normalizeSkillForPersistence,
  stripCanonicalSkillMetadata,
  writeSkillValidationMetadata
} from './skill-normalize'

const SLAY_NUDGE_KEYWORD = 'slay'

const KNOWN_CONTEXT_FILES: Array<{ relative: string; name: string; category: ContextFileCategory }> = [
  { relative: 'CLAUDE.md', name: 'CLAUDE.md', category: 'claude' },
  { relative: 'AGENTS.md', name: 'AGENTS.md', category: 'agents' },
  { relative: '.mcp.json', name: '.mcp.json', category: 'mcp' },
  { relative: '.cursor/mcp.json', name: '.cursor/mcp.json', category: 'mcp' },
  { relative: '.copilot/mcp-config.json', name: '.copilot/mcp-config.json', category: 'mcp' },
]

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function computeLinkedSyncState(filePath: string, expectedContent: string): {
  syncHealth: SyncHealth
  syncReason: SyncReason | null
  diskContent: string | null
} {
  if (!fs.existsSync(filePath)) {
    return {
      syncHealth: 'stale',
      syncReason: 'missing_file',
      diskContent: null
    }
  }

  const diskContent = fs.readFileSync(filePath, 'utf-8')
  const diskHash = contentHash(diskContent)
  const expectedHash = contentHash(expectedContent)
  if (diskHash === expectedHash) {
    return {
      syncHealth: 'synced',
      syncReason: null,
      diskContent
    }
  }

  return {
    syncHealth: 'stale',
    syncReason: 'external_edit',
    diskContent
  }
}

function computeUnlinkedSyncState(filePath: string): {
  syncHealth: SyncHealth
  syncReason: SyncReason
} {
  if (!fs.existsSync(filePath)) {
    return {
      syncHealth: 'not_synced',
      syncReason: 'not_linked'
    }
  }
  return {
    syncHealth: 'unmanaged',
    syncReason: 'not_linked'
  }
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled'
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('UNIQUE constraint failed')
}

function parseConfiguredProviders(rawValue: string): CliProvider[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawValue)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const providers = parsed.filter((value): value is string => typeof value === 'string')
  return filterConfigurableCliProviders(providers)
}

function getSkillPath(provider: CliProvider, slug: string): string | null {
  const mapping = PROVIDER_PATHS[provider]
  if (!mapping.skillsDir) return null
  return `${mapping.skillsDir}/${slug}/SKILL.md`
}


function getLegacySkillPath(provider: CliProvider, itemType: string, itemSlug: string): string | null {
  if (itemType !== 'skill') return null
  const mapping = PROVIDER_PATHS[provider]
  if (!mapping.skillsDir) return null
  return `${mapping.skillsDir}/${itemSlug}.md`
}

function isLegacySkillTargetPath(provider: CliProvider, targetPath: string, itemSlug: string): boolean {
  if (path.basename(targetPath) !== `${itemSlug}.md`) return false
  const mapping = PROVIDER_PATHS[provider]
  if (!mapping.skillsDir) return false
  const normalizedSkillsDir = mapping.skillsDir.replace(/\\/g, '/').replace(/^\.\/+/, '')
  const parent = path.dirname(targetPath).replace(/\\/g, '/').replace(/^\.\/+/, '')
  return parent === normalizedSkillsDir || parent.endsWith(`/${normalizedSkillsDir}`)
}

interface ProjectSkillSelectionRow {
  provider: string
  target_path: string
  content_hash: string | null
  item_content: string
  item_type: string
  item_slug: string
  item_metadata: string
}

function queryProjectSkillSelections(db: Database, projectId: string): ProjectSkillSelectionRow[] {
  return db.prepare(`
    SELECT ps.provider, ps.target_path, ps.content_hash, i.content as item_content, i.type as item_type, i.slug as item_slug, i.metadata_json as item_metadata
    FROM ai_config_project_selections ps
    JOIN ai_config_items i ON i.id = ps.item_id
    WHERE ps.project_id = ? AND i.type = 'skill'
  `).all(projectId) as ProjectSkillSelectionRow[]
}

function getCanonicalSelectionTargetPath(provider: CliProvider, itemType: string, itemSlug: string, targetPath: string): string {
  if (itemType !== 'skill') return targetPath

  // Heal stale DB rows pointing at an old provider folder (e.g. gemini selections stored as
  // `.gemini/skills/<slug>/SKILL.md` before gemini moved to the shared `.agents/skills`).
  // Predicate: any `.<dir>/skills/<slug>/SKILL.md` shape — covers both current and removed
  // provider folders. Custom manual paths (e.g. `.claude/skills/manual/foo.md`) don't match
  // because the segment before `SKILL.md` is the slug, so they're left alone.
  const canonical = getSkillPath(provider, itemSlug)
  if (canonical && targetPath !== canonical) {
    const escapedSlug = itemSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const providerFolderShape = new RegExp(`^\\.[\\w-]+\\/skills\\/${escapedSlug}\\/SKILL\\.md$`)
    if (providerFolderShape.test(targetPath)) return canonical
  }

  // Legacy fallback: slug.md → slug/SKILL.md when stored path is the old flat shape.
  if (!isLegacySkillTargetPath(provider, targetPath, itemSlug)) return targetPath
  const canonicalPath = path.join(path.dirname(targetPath), itemSlug, 'SKILL.md')
  return path.isAbsolute(targetPath) ? canonicalPath : canonicalPath.split(path.sep).join('/')
}

function removeLegacySkillFileIfPresent(
  provider: CliProvider,
  itemType: string,
  itemSlug: string,
  currentTargetPath: string,
  resolvedProject: string,
  projectPath: string
): void {
  const legacyPath = getLegacySkillPath(provider, itemType, itemSlug)
  if (!legacyPath) return
  if (currentTargetPath === legacyPath) return
  const legacyFilePath = path.join(resolvedProject, legacyPath)
  if (!fs.existsSync(legacyFilePath)) return
  if (!isPathAllowed(legacyFilePath, projectPath)) return
  fs.unlinkSync(legacyFilePath)
}

function ensureSkillValidationForSync(itemSlug: string, itemContent: string, _itemMetadataJson: string): void {
  const parsed = parseSkillFrontmatter(itemContent)
  if (!parsed) {
    throw new Error(`Cannot sync skill "${itemSlug}" because frontmatter is missing.`)
  }
  const parseError = parsed.issues.find((issue) => issue.severity === 'error')
  if (!parseError) return
  const lineHint = parseError.line ? ` (line ${parseError.line})` : ''
  throw new Error(`Cannot sync skill "${itemSlug}" because frontmatter is invalid${lineHint}: ${parseError.message}`)
}

function getSyncedItemContent(
  _provider: CliProvider,
  itemType: string,
  _itemSlug: string,
  targetPath: string,
  itemContent: string,
  _itemMetadataJson = '{}'
): string {
  if (itemType !== 'skill') return itemContent.replace(/\r\n/g, '\n')

  const normalizedContent = itemContent.replace(/\r\n/g, '\n')
  const parsedFrontmatter = parseSkillFrontmatter(normalizedContent)
  const body = (parsedFrontmatter?.body ?? normalizedContent).replace(/^\n+/, '')

  if (!targetPath.endsWith('/SKILL.md')) return body
  return normalizedContent
}

function withDerivedSkillValidation(item: AiConfigItem): AiConfigItem {
  if (item.type !== 'skill') return item
  const metadataWithoutCanonical = stripCanonicalSkillMetadata(item.metadata_json)
  const nextMetadataJson = writeSkillValidationMetadata(
    metadataWithoutCanonical,
    deriveSkillValidation(item.slug, item.content)
  )
  if (nextMetadataJson === item.metadata_json) return item
  return {
    ...item,
    metadata_json: nextMetadataJson
  }
}

function isPathAllowed(filePath: string, projectPath: string | null): boolean {
  const resolved = path.resolve(filePath)
  const home = app.getPath('home')
  // Allow all computer-level provider base dirs
  for (const [, spec] of Object.entries(COMPUTER_PROVIDER_PATHS)) {
    const dir = path.join(home, spec.baseDir)
    if (resolved.startsWith(dir + path.sep) || resolved === dir) return true
  }
  if (projectPath) {
    const resolvedProject = path.resolve(projectPath)
    if (resolved.startsWith(resolvedProject + path.sep) || resolved === resolvedProject) return true
  }
  return false
}

function collectMarkdownFilesRecursive(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return []
  const files: string[] = []
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFilesRecursive(fullPath))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath)
    }
  }
  return files
}

function toProjectRelativePath(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).split(path.sep).join('/')
}

export function registerAiConfigHandlers(ipcMain: IpcMain, db: Database): void {
  ipcMain.handle('ai-config:list-items', (_event, input: ListAiConfigItemsInput) => {
    const where: string[] = ['scope = ?']
    const values: unknown[] = [input.scope]

    if (input.scope === 'project' && input.projectId) {
      where.push('project_id = ?')
      values.push(input.projectId)
    }

    if (input.type) {
      where.push('type = ?')
      values.push(input.type)
    }

    const rows = db.prepare(`
      SELECT * FROM ai_config_items
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, created_at DESC
    `).all(...values) as AiConfigItem[]

    return rows.map(withDerivedSkillValidation)
  })

  ipcMain.handle('ai-config:get-item', (_event, id: string) => {
    const row = db.prepare('SELECT * FROM ai_config_items WHERE id = ?').get(id) as AiConfigItem | undefined
    return row ? withDerivedSkillValidation(row) : null
  })

  ipcMain.handle('ai-config:create-item', (_event, input: CreateAiConfigItemInput) => {
    const id = crypto.randomUUID()
    if (input.scope === 'project' && !input.projectId) {
      throw new Error('Project ID is required for project-scoped items')
    }
    const projectId = input.scope === 'project' ? input.projectId! : null
    const slug = normalizeSlug(input.slug)
    const rawContent = input.content ?? ''
    const normalizedSkill = input.type === 'skill'
      ? normalizeSkillForPersistence(slug, rawContent, '{}')
      : null
    const persistedContent = normalizedSkill ? normalizedSkill.content : rawContent
    const persistedMetadataJson = normalizedSkill ? normalizedSkill.metadataJson : '{}'
    try {
      db.prepare(`
        INSERT INTO ai_config_items (
          id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        id,
        input.type,
        input.scope,
        projectId,
        slug,
        slug,
        persistedContent,
        persistedMetadataJson
      )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error(`An item with slug "${slug}" already exists in this scope`)
      }
      throw error
    }

    const row = db.prepare('SELECT * FROM ai_config_items WHERE id = ?').get(id) as AiConfigItem
    return row
  })

  ipcMain.handle('ai-config:update-item', (_event, input: UpdateAiConfigItemInput) => {
    const existing = db.prepare(
      'SELECT id, type, scope, project_id, slug, content, metadata_json FROM ai_config_items WHERE id = ?'
    ).get(input.id) as Pick<AiConfigItem, 'id' | 'type' | 'scope' | 'project_id' | 'slug' | 'content' | 'metadata_json'> | undefined
    if (!existing) return null

    const fields: string[] = []
    const values: unknown[] = []
    const nextType = input.type ?? existing.type
    const nextScope = input.scope ?? existing.scope
    const nextSlug = input.slug !== undefined
      ? normalizeSlug(input.slug)
      : existing.slug

    if (input.type !== undefined) {
      fields.push('type = ?')
      values.push(input.type)
    }
    if (input.scope !== undefined) {
      fields.push('scope = ?')
      values.push(input.scope)
      if (input.scope === 'library') {
        fields.push('project_id = NULL')
      }
    }
    if (input.projectId !== undefined || nextScope === 'project') {
      const projectId = input.projectId !== undefined
        ? input.projectId
        : existing.project_id
      if (nextScope === 'project' && !projectId) {
        throw new Error('Project ID is required for project-scoped items')
      }
    }
    if (input.projectId !== undefined) {
      fields.push('project_id = ?')
      values.push(input.projectId)
    }
    if (input.slug !== undefined) {
      fields.push('slug = ?')
      values.push(nextSlug)
      fields.push('name = ?')
      values.push(nextSlug)
    }

    let normalizedSkill: { content: string; metadataJson: string } | null = null
    if (nextType === 'skill' && (input.content !== undefined || input.slug !== undefined || input.type !== undefined)) {
      const rawContent = input.content !== undefined
        ? input.content
        : existing.content
      normalizedSkill = normalizeSkillForPersistence(nextSlug, rawContent, existing.metadata_json, existing.slug)
    }

    if (normalizedSkill) {
      fields.push('content = ?')
      values.push(normalizedSkill.content)
      fields.push('metadata_json = ?')
      values.push(normalizedSkill.metadataJson)
    } else if (input.content !== undefined) {
      fields.push('content = ?')
      values.push(input.content)
    }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')")
      values.push(input.id)
      try {
        db.prepare(`UPDATE ai_config_items SET ${fields.join(', ')} WHERE id = ?`).run(...values)
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new Error('An item with that slug already exists in this scope')
        }
        throw error
      }
    }

    const row = db.prepare('SELECT * FROM ai_config_items WHERE id = ?').get(input.id) as AiConfigItem | undefined
    return row ?? null
  })

  ipcMain.handle('ai-config:delete-item', (_event, id: string) => {
    db.prepare('DELETE FROM ai_config_project_selections WHERE item_id = ?').run(id)
    const result = db.prepare('DELETE FROM ai_config_items WHERE id = ?').run(id)
    return result.changes > 0
  })

  ipcMain.handle('ai-config:list-project-selections', (_event, projectId: string) => {
    const rows = db.prepare(`
      SELECT * FROM ai_config_project_selections
      WHERE project_id = ?
      ORDER BY selected_at DESC
    `).all(projectId) as AiConfigProjectSelection[]
    return rows.filter((row) => isConfigurableCliProvider(row.provider))
  })

  ipcMain.handle('ai-config:set-project-selection', (_event, input: SetAiConfigProjectSelectionInput) => {
    const provider = input.provider ?? 'claude'
    if (!isConfigurableCliProvider(provider)) throw new Error(`Provider ${provider} is not configurable`)
    const item = db.prepare('SELECT type, slug FROM ai_config_items WHERE id = ?').get(input.itemId) as { type: string; slug: string } | undefined
    if (!item) throw new Error('Item not found')
    const targetPath = getCanonicalSelectionTargetPath(provider, item.type, item.slug, input.targetPath)
    const id = crypto.randomUUID()
    db.prepare(`
      INSERT INTO ai_config_project_selections (
        id, project_id, item_id, provider, target_path, selected_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(project_id, item_id, provider) DO UPDATE SET
        target_path = excluded.target_path,
        selected_at = datetime('now')
    `).run(id, input.projectId, input.itemId, provider, targetPath)
  })

  ipcMain.handle('ai-config:remove-project-selection', (_event, projectId: string, itemId: string, provider?: string) => {
    if (provider) {
      const result = db.prepare(`
        DELETE FROM ai_config_project_selections
        WHERE project_id = ? AND item_id = ? AND provider = ?
      `).run(projectId, itemId, provider)
      return result.changes > 0
    }
    const result = db.prepare(`
      DELETE FROM ai_config_project_selections
      WHERE project_id = ? AND item_id = ?
    `).run(projectId, itemId)
    return result.changes > 0
  })

  ipcMain.handle('ai-config:discover-context-files', (_event, projectPath: string) => {
    const results: ContextFileInfo[] = []

    // Project-specific files (only if project path provided)
    if (projectPath) {
      const resolvedProject = path.resolve(projectPath)
      for (const spec of KNOWN_CONTEXT_FILES) {
        const filePath = path.join(resolvedProject, spec.relative)
        results.push({
          path: filePath,
          name: spec.name,
          exists: fs.existsSync(filePath),
          category: spec.category
        })
      }
    }

    // ~/.claude/CLAUDE.md (always shown — computer-level config)
    const computerClaude = path.join(app.getPath('home'), '.claude', 'CLAUDE.md')
    results.push({
      path: computerClaude,
      name: '~/.claude/CLAUDE.md',
      exists: fs.existsSync(computerClaude),
      category: 'claude'
    })

    const computerCopilot = path.join(app.getPath('home'), '.copilot', 'AGENTS.md')
    results.push({
      path: computerCopilot,
      name: '~/.copilot/AGENTS.md',
      exists: fs.existsSync(computerCopilot),
      category: 'agents'
    })

    return results
  })

  function fileContentMeta(filePath: string): { contentHash: string; lineCount: number } | undefined {
    try {
      const text = fs.readFileSync(filePath, 'utf-8')
      return {
        contentHash: createHash('md5').update(text).digest('hex'),
        lineCount: text.split('\n').length,
      }
    } catch { return undefined }
  }

  ipcMain.handle('ai-config:get-computer-files', () => {
    const home = app.getPath('home')
    const entries: ComputerFileEntry[] = []

    for (const [key, spec] of Object.entries(COMPUTER_PROVIDER_PATHS)) {
      const baseDir = path.join(home, spec.baseDir)

      // Instructions file
      if (spec.instructions) {
        const filePath = path.join(baseDir, spec.instructions)
        const exists = fs.existsSync(filePath)
        const meta = exists ? fileContentMeta(filePath) : undefined
        entries.push({
          path: filePath,
          name: `~/${spec.baseDir}/${spec.instructions}`,
          provider: key,
          category: 'instructions',
          exists,
          ...meta,
        })
      }

      // MCP config file
      if (spec.mcpConfig) {
        const filePath = path.join(baseDir, spec.mcpConfig)
        const exists = fs.existsSync(filePath)
        const meta = exists ? fileContentMeta(filePath) : undefined
        entries.push({
          path: filePath,
          name: `~/${spec.baseDir}/${spec.mcpConfig}`,
          provider: key,
          category: 'mcp',
          exists,
          ...meta,
        })
      }

      // Skills directory — supports both flat (slug.md) and directory (slug/SKILL.md) formats
      if (spec.skillsDir) {
        const dir = path.join(baseDir, spec.skillsDir)
        if (fs.existsSync(dir)) {
          try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (entry.isFile() && entry.name.endsWith('.md')) {
                const fp = path.join(dir, entry.name)
                entries.push({
                  path: fp,
                  name: `~/${spec.baseDir}/${spec.skillsDir}/${entry.name}`,
                  provider: key,
                  category: 'skill',
                  exists: true,
                  ...fileContentMeta(fp),
                })
              } else if (entry.isDirectory()) {
                const skillFile = path.join(dir, entry.name, 'SKILL.md')
                if (fs.existsSync(skillFile)) {
                  entries.push({
                    path: skillFile,
                    name: `~/${spec.baseDir}/${spec.skillsDir}/${entry.name}/SKILL.md`,
                    provider: key,
                    category: 'skill',
                    exists: true,
                    ...fileContentMeta(skillFile),
                  })
                }
              }
            }
          } catch { /* ignore permission errors */ }
        }
      }

    }

    return entries
  })

  ipcMain.handle('ai-config:read-context-file', (_event, filePath: string, projectPath: string) => {
    if (!isPathAllowed(filePath, projectPath)) throw new Error('Path not allowed')
    return fs.readFileSync(filePath, 'utf-8')
  })

  ipcMain.handle('ai-config:write-context-file', (_event, filePath: string, content: string, projectPath: string) => {
    if (!isPathAllowed(filePath, projectPath)) throw new Error('Path not allowed')
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, content, 'utf-8')
  })

  ipcMain.handle('ai-config:delete-computer-file', (_event, filePath: string) => {
    if (!isPathAllowed(filePath, null)) throw new Error('Path not allowed')
    if (!fs.existsSync(filePath)) return
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) throw new Error('Only files can be deleted')
    fs.unlinkSync(filePath)
  })

  ipcMain.handle('ai-config:create-computer-file', (
    _event,
    provider: string,
    category: 'skill',
    slugInput: string
  ): ComputerFileEntry => {
    const spec = COMPUTER_PROVIDER_PATHS[provider]
    if (!spec) throw new Error(`Provider ${provider} does not support computer-level file management`)

    const dirSegment = spec.skillsDir
    if (!dirSegment) throw new Error(`${spec.label} does not support skills`)

    const slug = normalizeSlug(slugInput)
    const fileName = `${slug}.md`
    const home = app.getPath('home')
    const filePath = path.join(home, spec.baseDir, dirSegment, fileName)
    if (!isPathAllowed(filePath, null)) throw new Error('Path not allowed')
    if (fs.existsSync(filePath)) throw new Error('File already exists')

    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, '', 'utf-8')

    return {
      path: filePath,
      name: `~/${spec.baseDir}/${dirSegment}/${fileName}`,
      provider,
      category,
      exists: true
    }
  })

  ipcMain.handle('ai-config:write-computer-skill', (
    _event,
    provider: CliProvider,
    slug: string,
    content: string,
  ) => {
    if (!isConfigurableCliProvider(provider)) throw new Error(`Provider ${provider} is not configurable`)
    const spec = COMPUTER_PROVIDER_PATHS[provider]
    if (!spec?.skillsDir) throw new Error(`${provider} does not support computer-level skills`)
    const home = app.getPath('home')
    const normalizedSlug = normalizeSlug(slug)
    const filePath = path.join(home, spec.baseDir, spec.skillsDir, normalizedSlug, 'SKILL.md')
    if (!isPathAllowed(filePath, null)) throw new Error('Path not allowed')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf-8')
  })

  ipcMain.handle('ai-config:get-context-tree', (_event, projectPath: string, projectId: string) => {
    const entries: ContextTreeEntry[] = []
    const resolvedProject = path.resolve(projectPath)
    const seenPaths = new Set<string>()

    // 1. Discovered known files
    for (const spec of KNOWN_CONTEXT_FILES) {
      const filePath = path.join(resolvedProject, spec.relative)
      const exists = fs.existsSync(filePath)
      seenPaths.add(filePath)
      entries.push({
        path: filePath,
        relativePath: spec.relative,
        exists,
        category: spec.category,
        linkedItemId: null,
        syncHealth: exists ? 'unmanaged' : 'not_synced',
        syncReason: 'not_linked'
      })
    }

    // ~/.claude/CLAUDE.md
    const computerClaude = path.join(app.getPath('home'), '.claude', 'CLAUDE.md')
    const computerClaudeExists = fs.existsSync(computerClaude)
    seenPaths.add(computerClaude)
    entries.push({
      path: computerClaude,
      relativePath: '~/.claude/CLAUDE.md',
      exists: computerClaudeExists,
      category: 'claude',
      linkedItemId: null,
      syncHealth: computerClaudeExists ? 'unmanaged' : 'not_synced',
      syncReason: 'not_linked'
    })

    // 2. Scan provider skill directories for markdown files.
    const scanDirs: Array<{ dir: string; relDir: string; category: 'skill'; provider?: CliProvider }> = []
    for (const [providerKey, mapping] of Object.entries(PROVIDER_PATHS)) {
      if (!isConfigurableCliProvider(providerKey)) continue
      if (!mapping.skillsDir) continue
      scanDirs.push({
        dir: path.join(resolvedProject, mapping.skillsDir),
        relDir: mapping.skillsDir,
        category: 'skill',
        provider: providerKey as CliProvider
      })
    }
    // Backward compatibility with early local experiments.
    scanDirs.push({ dir: path.join(resolvedProject, 'agents'), relDir: 'agents', category: 'skill' })
    for (const { dir, relDir, category, provider: scanProvider } of scanDirs) {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        for (const filePath of collectMarkdownFilesRecursive(dir)) {
          if (seenPaths.has(filePath)) continue
          seenPaths.add(filePath)
          const relFile = path.relative(dir, filePath).split(path.sep).join('/')
          entries.push({
            path: filePath,
            relativePath: `${relDir}/${relFile}`,
            exists: true,
            category,
            provider: scanProvider,
            linkedItemId: null,
            syncHealth: 'unmanaged',
            syncReason: 'not_linked'
          })
        }
      }
    }

    // 3. Check project selections for linked library items
    const selections = db.prepare(`
      SELECT ps.*, i.content as item_content, i.type as item_type, i.slug as item_slug, i.metadata_json as item_metadata
      FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ?
    `).all(projectId) as Array<AiConfigProjectSelection & { item_content: string; item_type: string; item_slug: string; item_metadata: string }>

    for (const sel of selections) {
      if (!isConfigurableCliProvider(sel.provider)) continue
      const provider = sel.provider as CliProvider
      const effectiveTargetPath = getCanonicalSelectionTargetPath(provider, sel.item_type, sel.item_slug, sel.target_path)
      const expectedContent = getSyncedItemContent(provider, sel.item_type, sel.item_slug, effectiveTargetPath, sel.item_content, sel.item_metadata)
      const filePath = path.isAbsolute(effectiveTargetPath)
        ? effectiveTargetPath
        : path.join(resolvedProject, effectiveTargetPath)

      const existing = entries.find((e) => e.path === filePath)
      if (existing) {
        existing.linkedItemId = sel.item_id
        const syncState = computeLinkedSyncState(filePath, expectedContent)
        existing.syncHealth = syncState.syncHealth
        existing.syncReason = syncState.syncReason
      } else {
        const exists = fs.existsSync(filePath)
        const syncState = computeLinkedSyncState(filePath, expectedContent)
        seenPaths.add(filePath)
        entries.push({
          path: filePath,
          relativePath: effectiveTargetPath,
          exists,
          category: 'custom',
          linkedItemId: sel.item_id,
          syncHealth: syncState.syncHealth,
          syncReason: syncState.syncReason
        })
      }
    }

    return entries
  })

  ipcMain.handle('ai-config:load-library-item', (_event, input: LoadLibraryItemInput) => {
    const item = db.prepare('SELECT * FROM ai_config_items WHERE id = ?').get(input.itemId) as AiConfigItem | undefined
    if (!item) throw new Error('Item not found')
    if (item.type === 'skill') {
      ensureSkillValidationForSync(item.slug, item.content, item.metadata_json)
    }

    const resolvedProject = path.resolve(input.projectPath)
    const entries: ContextTreeEntry[] = []

    // If manual path provided, write there (no provider-based logic)
    if (input.manualPath) {
      const manualProvider = filterConfigurableCliProviders(input.providers)[0] ?? 'claude'
      const filePath = path.join(resolvedProject, input.manualPath)
      const syncedContent = getSyncedItemContent(manualProvider, item.type, item.slug, input.manualPath, item.content, item.metadata_json)
      const hash = contentHash(syncedContent)
      if (!isPathAllowed(filePath, input.projectPath)) throw new Error('Path not allowed')
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(filePath, syncedContent, 'utf-8')

      db.prepare(`
        INSERT INTO ai_config_project_selections (id, project_id, item_id, provider, target_path, content_hash, selected_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(project_id, item_id, provider) DO UPDATE SET
          target_path = excluded.target_path, content_hash = excluded.content_hash, selected_at = datetime('now')
      `).run(crypto.randomUUID(), input.projectId, input.itemId, manualProvider, input.manualPath, hash)

      entries.push({
        path: filePath, relativePath: input.manualPath, exists: true,
        category: 'skill',
        provider: manualProvider,
        linkedItemId: item.id,
        syncHealth: 'synced',
        syncReason: null
      })
      return entries[0]
    }

    // Write to each selected provider
    for (const provider of filterConfigurableCliProviders(input.providers)) {
      const relativePath = getSkillPath(provider, item.slug)
      if (!relativePath) continue

      const filePath = path.join(resolvedProject, relativePath)
      const syncedContent = getSyncedItemContent(provider, item.type, item.slug, relativePath, item.content, item.metadata_json)
      const hash = contentHash(syncedContent)
      if (!isPathAllowed(filePath, input.projectPath)) continue

      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(filePath, syncedContent, 'utf-8')

      db.prepare(`
        INSERT INTO ai_config_project_selections (id, project_id, item_id, provider, target_path, content_hash, selected_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(project_id, item_id, provider) DO UPDATE SET
          target_path = excluded.target_path, content_hash = excluded.content_hash, selected_at = datetime('now')
      `).run(crypto.randomUUID(), input.projectId, input.itemId, provider, relativePath, hash)

      entries.push({
        path: filePath, relativePath, exists: true,
        category: 'skill',
        provider,
        linkedItemId: item.id,
        syncHealth: 'synced',
        syncReason: null
      })
    }

    return entries[0] ?? null
  })

  ipcMain.handle('ai-config:sync-linked-file', (_event, projectId: string, projectPath: string, itemId: string, provider?: CliProvider) => {
    const rows = provider
      ? db.prepare(`
        SELECT ps.*, i.content as item_content, i.type as item_type, i.slug as item_slug, i.metadata_json as item_metadata
        FROM ai_config_project_selections ps
        JOIN ai_config_items i ON i.id = ps.item_id
        WHERE ps.project_id = ? AND ps.item_id = ? AND ps.provider = ?
      `).all(projectId, itemId, provider)
      : db.prepare(`
        SELECT ps.*, i.content as item_content, i.type as item_type, i.slug as item_slug, i.metadata_json as item_metadata
        FROM ai_config_project_selections ps
        JOIN ai_config_items i ON i.id = ps.item_id
        WHERE ps.project_id = ? AND ps.item_id = ?
      `).all(projectId, itemId)

    const selections = rows as Array<AiConfigProjectSelection & { item_content: string; item_type: string; item_slug: string; item_metadata: string }>

    const resolvedProject = path.resolve(projectPath)

    if (selections.length === 0) {
      const localItem = db.prepare(`
        SELECT id, project_id, scope, type, slug, content, metadata_json
        FROM ai_config_items
        WHERE id = ?
      `).get(itemId) as {
        id: string
        project_id: string | null
        scope: string
        type: string
        slug: string
        content: string
        metadata_json: string
      } | undefined

      const isProjectLocalItem = localItem
        && localItem.scope === 'project'
        && localItem.project_id === projectId
        && localItem.type === 'skill'
      if (!isProjectLocalItem) throw new Error('Selection not found')
      ensureSkillValidationForSync(localItem.slug, localItem.content, localItem.metadata_json)

      const providersToSync = provider
        ? filterConfigurableCliProviders([provider])
        : getEnabledProviders(projectId)

      const insertSelection = db.prepare(`
        INSERT INTO ai_config_project_selections (id, project_id, item_id, provider, target_path, content_hash, selected_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(project_id, item_id, provider) DO UPDATE SET
          target_path = excluded.target_path, content_hash = excluded.content_hash, selected_at = datetime('now')
      `)

      let firstEntry: ContextTreeEntry | null = null
      for (const providerId of providersToSync) {
        const relativePath = getSkillPath(providerId, localItem.slug)
        if (!relativePath) continue

        const syncedContent = getSyncedItemContent(providerId, localItem.type, localItem.slug, relativePath, localItem.content, localItem.metadata_json)
        const filePath = path.join(resolvedProject, relativePath)
        if (!isPathAllowed(filePath, projectPath)) continue

        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(filePath, syncedContent, 'utf-8')
        insertSelection.run(crypto.randomUUID(), projectId, localItem.id, providerId, relativePath, contentHash(syncedContent))
        removeLegacySkillFileIfPresent(
          providerId,
          localItem.type,
          localItem.slug,
          relativePath,
          resolvedProject,
          projectPath
        )

        if (!firstEntry) {
          firstEntry = {
            path: filePath,
            relativePath,
            exists: true,
            category: 'skill',
            provider: providerId,
            linkedItemId: localItem.id,
            syncHealth: 'synced',
            syncReason: null
          }
        }
      }

      if (!firstEntry) throw new Error('No compatible providers enabled')
      return firstEntry
    }

    const updateSelection = db.prepare(`
      UPDATE ai_config_project_selections
      SET target_path = ?, content_hash = ?, selected_at = datetime('now')
      WHERE id = ?
    `)

    let firstEntry: ContextTreeEntry | null = null
    for (const sel of selections) {
      if (!isConfigurableCliProvider(sel.provider)) continue
      const providerId = sel.provider as CliProvider
      if (sel.item_type === 'skill') {
        ensureSkillValidationForSync(sel.item_slug, sel.item_content, sel.item_metadata)
      }
      const effectiveTargetPath = getCanonicalSelectionTargetPath(providerId, sel.item_type, sel.item_slug, sel.target_path)
      const syncedContent = getSyncedItemContent(providerId, sel.item_type, sel.item_slug, effectiveTargetPath, sel.item_content, sel.item_metadata)
      const filePath = path.isAbsolute(effectiveTargetPath)
        ? effectiveTargetPath
        : path.join(resolvedProject, effectiveTargetPath)

      if (!isPathAllowed(filePath, projectPath)) continue

      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(filePath, syncedContent, 'utf-8')
      updateSelection.run(effectiveTargetPath, contentHash(syncedContent), sel.id)
      removeLegacySkillFileIfPresent(
        providerId,
        sel.item_type,
        sel.item_slug,
        effectiveTargetPath,
        resolvedProject,
        projectPath
      )

      if (effectiveTargetPath !== sel.target_path) {
        const oldFilePath = path.isAbsolute(sel.target_path)
          ? sel.target_path
          : path.join(resolvedProject, sel.target_path)
        if (oldFilePath !== filePath && fs.existsSync(oldFilePath) && isPathAllowed(oldFilePath, projectPath)) {
          fs.unlinkSync(oldFilePath)
        }
      }

      if (!firstEntry) {
        firstEntry = {
          path: filePath,
          relativePath: effectiveTargetPath,
          exists: true,
          category: 'skill',
          linkedItemId: sel.item_id,
          syncHealth: 'synced',
          syncReason: null
        }
      }
    }

    if (!firstEntry) throw new Error('Selection not found')
    return firstEntry
  })

  ipcMain.handle('ai-config:unlink-file', (_event, projectId: string, itemId: string) => {
    const result = db.prepare(`
      DELETE FROM ai_config_project_selections WHERE project_id = ? AND item_id = ?
    `).run(projectId, itemId)
    return result.changes > 0
  })

  ipcMain.handle('ai-config:rename-context-file', (_event, oldPath: string, newPath: string, projectPath: string) => {
    if (!isPathAllowed(oldPath, projectPath)) throw new Error('Path not allowed')
    if (!isPathAllowed(newPath, projectPath)) throw new Error('Path not allowed')
    if (!fs.existsSync(oldPath)) throw new Error('File not found')
    const dir = path.dirname(newPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.renameSync(oldPath, newPath)
    // Update any project selections pointing to old path
    const resolvedProject = path.resolve(projectPath)
    const oldRel = path.relative(resolvedProject, oldPath)
    const newRel = path.relative(resolvedProject, newPath)
    db.prepare(`
      UPDATE ai_config_project_selections SET target_path = ? WHERE target_path = ?
    `).run(newRel, oldRel)
  })

  ipcMain.handle('ai-config:delete-context-file', (_event, filePath: string, projectPath: string, projectId: string) => {
    if (!isPathAllowed(filePath, projectPath)) throw new Error('Path not allowed')
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    // Remove empty parent dir (e.g. skills/slug/ after deleting SKILL.md)
    const parentDir = path.dirname(filePath)
    try {
      const remaining = fs.readdirSync(parentDir)
      if (remaining.length === 0) fs.rmdirSync(parentDir)
    } catch { /* ignore — dir may not exist or not be empty */ }
    // Remove any project selections pointing to this file
    const resolvedProject = path.resolve(projectPath)
    const rel = path.relative(resolvedProject, filePath)
    db.prepare(`
      DELETE FROM ai_config_project_selections WHERE project_id = ? AND target_path = ?
    `).run(projectId, rel)
  })

  // --- Root instructions + skills status ---

  function getEnabledProviders(projectId: string): CliProvider[] {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?')
      .get(`ai_providers:${projectId}`) as { value: string } | undefined
    if (row) {
      const parsed = parseConfiguredProviders(row.value)
      if (parsed) return parsed
    }
    const active = db.prepare('SELECT kind FROM ai_config_sources WHERE enabled = 1 AND status = ?')
      .all('active') as Array<{ kind: string }>
    return filterConfigurableCliProviders(active.map(p => p.kind))
  }

  function recomputeInstructionsResult(projectId: string, projectPath: string): RootInstructionsResult {
    // Check for linked library variant
    const variantRow = db.prepare("SELECT value FROM settings WHERE key = ?")
      .get(`ai_instruction_variant:${projectId}`) as { value: string } | undefined
    let variant: AiConfigItem | undefined
    if (variantRow) {
      variant = db.prepare(
        "SELECT * FROM ai_config_items WHERE id = ? AND type = 'root_instructions' AND scope = 'library'"
      ).get(variantRow.value) as AiConfigItem | undefined
    }

    const providers = getEnabledProviders(projectId)
    const resolvedProject = path.resolve(projectPath)
    const providerHealth: Partial<Record<CliProvider, { health: SyncHealth; reason: SyncReason | null; contentHash?: string | null; lineCount?: number | null }>> = {}

    for (const provider of providers) {
      const rootPath = PROVIDER_PATHS[provider]?.rootInstructions
      if (!rootPath) continue
      const filePath = path.join(resolvedProject, rootPath)
      let fileHash: string | null = null
      let lineCount: number | null = null
      if (fs.existsSync(filePath)) {
        const text = fs.readFileSync(filePath, 'utf-8')
        fileHash = contentHash(text)
        lineCount = text.split('\n').length
      }
      if (!variant) {
        providerHealth[provider] = { health: 'not_synced', reason: 'not_linked', contentHash: fileHash, lineCount }
        continue
      }
      const syncState = computeLinkedSyncState(filePath, variant.content)
      providerHealth[provider] = {
        health: syncState.syncHealth,
        reason: syncState.syncReason,
        contentHash: fileHash,
        lineCount
      }
    }

    return { content: variant?.content ?? '', providerHealth }
  }

  ipcMain.handle('ai-config:get-root-instructions', (_event, projectId: string, projectPath: string) => {
    return recomputeInstructionsResult(projectId, projectPath)
  })

  ipcMain.handle('ai-config:get-library-instructions', (_event, variantId?: string) => {
    if (variantId) {
      const item = db.prepare(
        "SELECT * FROM ai_config_items WHERE id = ? AND type = 'root_instructions' AND scope = 'library'"
      ).get(variantId) as AiConfigItem | undefined
      return item?.content ?? ''
    }
    // Legacy: return first (default) variant
    const item = db.prepare(
      "SELECT * FROM ai_config_items WHERE type = 'root_instructions' AND scope = 'library' ORDER BY created_at ASC LIMIT 1"
    ).get() as AiConfigItem | undefined
    return item?.content ?? ''
  })

  ipcMain.handle('ai-config:save-library-instructions', (_event, content: string, variantId?: string) => {
    if (variantId) {
      db.prepare("UPDATE ai_config_items SET content = ?, updated_at = datetime('now') WHERE id = ? AND type = 'root_instructions' AND scope = 'library'")
        .run(content, variantId)
      return
    }
    // Legacy: upsert the default variant
    const existing = db.prepare(
      "SELECT id FROM ai_config_items WHERE type = 'root_instructions' AND scope = 'library' ORDER BY created_at ASC LIMIT 1"
    ).get() as { id: string } | undefined

    if (existing) {
      db.prepare("UPDATE ai_config_items SET content = ?, updated_at = datetime('now') WHERE id = ?")
        .run(content, existing.id)
    } else {
      db.prepare(`
        INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
        VALUES (?, 'root_instructions', 'library', NULL, 'root_instructions', 'root_instructions', ?, '{}', datetime('now'), datetime('now'))
      `).run(crypto.randomUUID(), content)
    }
  })

  // Instruction variants
  ipcMain.handle('ai-config:list-instruction-variants', (): AiConfigItem[] => {
    return db.prepare(
      "SELECT * FROM ai_config_items WHERE type = 'root_instructions' AND scope = 'library' ORDER BY updated_at DESC"
    ).all() as AiConfigItem[]
  })

  ipcMain.handle('ai-config:get-project-instruction-variant', (_event, projectId: string): AiConfigItem | null => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?")
      .get(`ai_instruction_variant:${projectId}`) as { value: string } | undefined
    if (!row) return null
    const item = db.prepare(
      "SELECT * FROM ai_config_items WHERE id = ? AND type = 'root_instructions' AND scope = 'library'"
    ).get(row.value) as AiConfigItem | undefined
    return item ?? null
  })

  ipcMain.handle('ai-config:set-project-instruction-variant', (_event, projectId: string, variantItemId: string | null, projectPath?: string) => {
    if (variantItemId === null) {
      db.prepare("DELETE FROM settings WHERE key = ?").run(`ai_instruction_variant:${projectId}`)
      return
    }

    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`ai_instruction_variant:${projectId}`, variantItemId)

    // Auto-sync: write variant content to all provider instruction files
    if (projectPath) {
      const variant = db.prepare(
        "SELECT * FROM ai_config_items WHERE id = ? AND type = 'root_instructions' AND scope = 'library'"
      ).get(variantItemId) as AiConfigItem | undefined
      if (variant) {
        const hash = contentHash(variant.content)
        const providers = getEnabledProviders(projectId)
        const resolvedProject = path.resolve(projectPath)
        for (const provider of providers) {
          const rootPath = PROVIDER_PATHS[provider]?.rootInstructions
          if (!rootPath) continue
          const filePath = path.join(resolvedProject, rootPath)
          if (!isPathAllowed(filePath, projectPath)) continue
          const dir = path.dirname(filePath)
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(filePath, variant.content, 'utf-8')
          db.prepare(`
            INSERT INTO ai_config_project_selections (id, project_id, item_id, provider, target_path, content_hash, selected_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(project_id, item_id, provider) DO UPDATE SET
              target_path = excluded.target_path, content_hash = excluded.content_hash, selected_at = datetime('now')
          `).run(crypto.randomUUID(), projectId, variant.id, provider, rootPath, hash)
        }
      }
    }
  })

  ipcMain.handle('ai-config:save-instructions-content', (_event, projectId: string, projectPath: string, content: string): RootInstructionsResult => {
    const existing = db.prepare(
      "SELECT id FROM ai_config_items WHERE type = 'root_instructions' AND scope = 'project' AND project_id = ?"
    ).get(projectId) as { id: string } | undefined

    if (existing) {
      db.prepare("UPDATE ai_config_items SET content = ?, updated_at = datetime('now') WHERE id = ?")
        .run(content, existing.id)
    } else {
      const id = crypto.randomUUID()
      db.prepare(`
        INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
        VALUES (?, 'root_instructions', 'project', ?, 'root_instructions', 'root_instructions', ?, '{}', datetime('now'), datetime('now'))
      `).run(id, projectId, content)
    }

    return recomputeInstructionsResult(projectId, projectPath)
  })

  ipcMain.handle('ai-config:save-root-instructions', (_event, projectId: string, projectPath: string, content: string) => {
    // Upsert the root_instructions item
    const existing = db.prepare(
      "SELECT id FROM ai_config_items WHERE type = 'root_instructions' AND scope = 'project' AND project_id = ?"
    ).get(projectId) as { id: string } | undefined

    let itemId: string
    if (existing) {
      db.prepare("UPDATE ai_config_items SET content = ?, updated_at = datetime('now') WHERE id = ?")
        .run(content, existing.id)
      itemId = existing.id
    } else {
      itemId = crypto.randomUUID()
      db.prepare(`
        INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
        VALUES (?, 'root_instructions', 'project', ?, 'root_instructions', 'root_instructions', ?, '{}', datetime('now'), datetime('now'))
      `).run(itemId, projectId, content)
    }

    const hash = contentHash(content)
    const providers = getEnabledProviders(projectId)
    const resolvedProject = path.resolve(projectPath)
    const providerHealth: Partial<Record<CliProvider, { health: SyncHealth; reason: SyncReason | null }>> = {}

    for (const provider of providers) {
      const rootPath = PROVIDER_PATHS[provider]?.rootInstructions
      if (!rootPath) continue
      const filePath = path.join(resolvedProject, rootPath)
      if (!isPathAllowed(filePath, projectPath)) continue

      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(filePath, content, 'utf-8')

      db.prepare(`
        INSERT INTO ai_config_project_selections (id, project_id, item_id, provider, target_path, content_hash, selected_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(project_id, item_id, provider) DO UPDATE SET
          target_path = excluded.target_path, content_hash = excluded.content_hash, selected_at = datetime('now')
      `).run(crypto.randomUUID(), projectId, itemId, provider, rootPath, hash)

      providerHealth[provider] = { health: 'synced', reason: null }
    }

    const result: RootInstructionsResult = { content, providerHealth }
    return result
  })

  ipcMain.handle('ai-config:read-provider-instructions', (_event, projectPath: string, provider: CliProvider): ProviderFileContent => {
    const rootPath = PROVIDER_PATHS[provider]?.rootInstructions
    if (!rootPath) return { provider, content: '', exists: false }
    const filePath = path.join(path.resolve(projectPath), rootPath)
    if (!isPathAllowed(filePath, projectPath)) return { provider, content: '', exists: false }
    if (!fs.existsSync(filePath)) return { provider, content: '', exists: false }
    return { provider, content: fs.readFileSync(filePath, 'utf-8'), exists: true }
  })

  ipcMain.handle('ai-config:push-provider-instructions', (_event, projectId: string, projectPath: string, provider: CliProvider, content: string): RootInstructionsResult => {
    const rootPath = PROVIDER_PATHS[provider]?.rootInstructions
    if (!rootPath) throw new Error(`No root instructions path for ${provider}`)
    const resolvedProject = path.resolve(projectPath)
    const filePath = path.join(resolvedProject, rootPath)
    if (!isPathAllowed(filePath, projectPath)) throw new Error('Path not allowed')

    const item = db.prepare(
      "SELECT * FROM ai_config_items WHERE type = 'root_instructions' AND scope = 'project' AND project_id = ?"
    ).get(projectId) as AiConfigItem | undefined
    if (!item) throw new Error('No instructions to push')

    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, content, 'utf-8')

    const hash = contentHash(content)
    db.prepare(`
      INSERT INTO ai_config_project_selections (id, project_id, item_id, provider, target_path, content_hash, selected_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(project_id, item_id, provider) DO UPDATE SET
        target_path = excluded.target_path, content_hash = excluded.content_hash, selected_at = datetime('now')
    `).run(crypto.randomUUID(), projectId, item.id, provider, rootPath, hash)

    return recomputeInstructionsResult(projectId, projectPath)
  })

  ipcMain.handle('ai-config:pull-provider-instructions', (_event, projectId: string, projectPath: string, provider: CliProvider): RootInstructionsResult => {
    const rootPath = PROVIDER_PATHS[provider]?.rootInstructions
    if (!rootPath) throw new Error(`No root instructions path for ${provider}`)
    const filePath = path.join(path.resolve(projectPath), rootPath)
    if (!isPathAllowed(filePath, projectPath)) throw new Error('Path not allowed')
    if (!fs.existsSync(filePath)) throw new Error('Provider file does not exist')

    const diskContent = fs.readFileSync(filePath, 'utf-8')

    const existing = db.prepare(
      "SELECT id FROM ai_config_items WHERE type = 'root_instructions' AND scope = 'project' AND project_id = ?"
    ).get(projectId) as { id: string } | undefined

    if (existing) {
      db.prepare("UPDATE ai_config_items SET content = ?, updated_at = datetime('now') WHERE id = ?")
        .run(diskContent, existing.id)
    } else {
      const id = crypto.randomUUID()
      db.prepare(`
        INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
        VALUES (?, 'root_instructions', 'project', ?, 'root_instructions', 'root_instructions', ?, '{}', datetime('now'), datetime('now'))
      `).run(id, projectId, diskContent)
    }

    return recomputeInstructionsResult(projectId, projectPath)
  })

  ipcMain.handle('ai-config:get-project-skills-status', (_event, projectId: string, projectPath: string) => {
    const providers = getEnabledProviders(projectId)
    const resolvedProject = path.resolve(projectPath)

    const selections = (db.prepare(`
      SELECT ps.*, i.content as item_content, i.type as item_type, i.slug as item_slug,
             i.name as item_name, i.scope as item_scope, i.project_id as item_project_id,
             i.metadata_json as item_metadata,
             i.created_at as item_created, i.updated_at as item_updated
      FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ? AND i.type = 'skill'
    `).all(projectId) as Array<AiConfigProjectSelection & {
      item_content: string; item_type: string; item_slug: string
      item_name: string; item_scope: string; item_project_id: string | null
      item_metadata: string
      item_created: string; item_updated: string
    }>).filter((sel) => isConfigurableCliProvider(sel.provider))

    // Group by item_id
    const byItem = new Map<string, typeof selections>()
    for (const sel of selections) {
      const list = byItem.get(sel.item_id) ?? []
      list.push(sel)
      byItem.set(sel.item_id, list)
    }

    const results: ProjectSkillStatus[] = []
    for (const [, sels] of byItem) {
      const first = sels[0]
      const item = withDerivedSkillValidation({
        id: first.item_id,
        type: first.item_type as AiConfigItem['type'],
        scope: first.item_scope as AiConfigItem['scope'],
        project_id: first.item_project_id ?? null,
        name: first.item_name,
        slug: first.item_slug,
        content: first.item_content,
        metadata_json: first.item_metadata,
        created_at: first.item_created,
        updated_at: first.item_updated
      })

      const providerMap: ProjectSkillStatus['providers'] = {}
      for (const provider of providers) {
        const sel = sels.find(s => s.provider === provider)
        if (sel) {
          const effectiveTargetPath = getCanonicalSelectionTargetPath(provider, sel.item_type, sel.item_slug, sel.target_path)
          const expectedContent = getSyncedItemContent(provider, item.type, item.slug, effectiveTargetPath, item.content, item.metadata_json)
          const filePath = path.isAbsolute(effectiveTargetPath)
            ? effectiveTargetPath
            : path.join(resolvedProject, effectiveTargetPath)
          const syncState = computeLinkedSyncState(filePath, expectedContent)
          providerMap[provider] = {
            path: effectiveTargetPath,
            syncHealth: syncState.syncHealth,
            syncReason: syncState.syncReason,
            ...(syncState.syncHealth === 'stale' && syncState.diskContent !== null
              ? { diskContent: syncState.diskContent }
              : {})
          }
        } else {
          const defaultPath = getSkillPath(provider, item.slug) ?? ''
          if (!defaultPath) {
            providerMap[provider] = { path: '', syncHealth: 'not_synced', syncReason: 'provider_disabled' }
            continue
          }
          const filePath = path.join(resolvedProject, defaultPath)
          const unlinkedState = computeUnlinkedSyncState(filePath)
          providerMap[provider] = {
            path: defaultPath,
            syncHealth: unlinkedState.syncHealth,
            syncReason: unlinkedState.syncReason
          }
        }
      }

      results.push({ item, providers: providerMap })
    }

    return results
  })

  function recomputeSingleSkillStatus(projectId: string, projectPath: string, itemId: string): ProjectSkillStatus {
    const providers = getEnabledProviders(projectId)
    const resolvedProject = path.resolve(projectPath)

    const rawItem = db.prepare('SELECT * FROM ai_config_items WHERE id = ?').get(itemId) as AiConfigItem | undefined
    const item = rawItem ? withDerivedSkillValidation(rawItem) : undefined
    if (!item) throw new Error('Item not found')

    const selections = (db.prepare(`
      SELECT * FROM ai_config_project_selections WHERE project_id = ? AND item_id = ?
    `).all(projectId, itemId) as AiConfigProjectSelection[]).filter(s => isConfigurableCliProvider(s.provider))

    const providerMap: ProjectSkillStatus['providers'] = {}
    for (const provider of providers) {
      const sel = selections.find(s => s.provider === provider)
      if (sel) {
        const effectiveTargetPath = getCanonicalSelectionTargetPath(provider, item.type, item.slug, sel.target_path)
        const expectedContent = getSyncedItemContent(provider, item.type, item.slug, effectiveTargetPath, item.content, item.metadata_json)
        const filePath = path.isAbsolute(effectiveTargetPath)
          ? effectiveTargetPath
          : path.join(resolvedProject, effectiveTargetPath)
        const syncState = computeLinkedSyncState(filePath, expectedContent)
        providerMap[provider] = {
          path: effectiveTargetPath,
          syncHealth: syncState.syncHealth,
          syncReason: syncState.syncReason,
          ...(syncState.syncHealth === 'stale' && syncState.diskContent !== null
            ? { diskContent: syncState.diskContent }
            : {})
        }
      } else {
        const defaultPath = getSkillPath(provider, item.slug) ?? ''
        if (!defaultPath) {
          providerMap[provider] = { path: '', syncHealth: 'not_synced', syncReason: 'provider_disabled' }
          continue
        }
        const filePath = path.join(resolvedProject, defaultPath)
        const unlinkedState = computeUnlinkedSyncState(filePath)
        providerMap[provider] = {
          path: defaultPath,
          syncHealth: unlinkedState.syncHealth,
          syncReason: unlinkedState.syncReason
        }
      }
    }

    return { item, providers: providerMap }
  }

  ipcMain.handle('ai-config:read-provider-skill', (_event, projectPath: string, provider: CliProvider, itemId: string): ProviderFileContent => {
    const item = db.prepare('SELECT * FROM ai_config_items WHERE id = ?').get(itemId) as AiConfigItem | undefined
    if (!item) return { provider, content: '', exists: false }

    const skillPath = getSkillPath(provider, item.slug)
    if (!skillPath) return { provider, content: '', exists: false }

    const filePath = path.join(path.resolve(projectPath), skillPath)
    if (!isPathAllowed(filePath, projectPath)) return { provider, content: '', exists: false }
    if (!fs.existsSync(filePath)) return { provider, content: '', exists: false }
    return { provider, content: fs.readFileSync(filePath, 'utf-8'), exists: true }
  })

  ipcMain.handle('ai-config:get-expected-skill-content', (_event, _projectPath: string, provider: CliProvider, itemId: string): string => {
    const item = db.prepare('SELECT * FROM ai_config_items WHERE id = ?').get(itemId) as AiConfigItem | undefined
    if (!item) throw new Error('Item not found')

    const skillPath = getSkillPath(provider, item.slug)
    if (!skillPath) return item.content

    return getSyncedItemContent(provider, item.type, item.slug, skillPath, item.content, item.metadata_json)
  })

  ipcMain.handle('ai-config:pull-provider-skill', (_event, projectId: string, projectPath: string, provider: CliProvider, itemId: string): ProjectSkillStatus => {
    const item = db.prepare('SELECT * FROM ai_config_items WHERE id = ?').get(itemId) as AiConfigItem | undefined
    if (!item) throw new Error('Item not found')

    const skillPath = getSkillPath(provider, item.slug)
    if (!skillPath) throw new Error(`No skill path for ${provider}`)

    const filePath = path.join(path.resolve(projectPath), skillPath)
    if (!isPathAllowed(filePath, projectPath)) throw new Error('Path not allowed')
    if (!fs.existsSync(filePath)) throw new Error('Skill file does not exist')

    const diskContent = fs.readFileSync(filePath, 'utf-8')
    const normalized = normalizeSkillForPersistence(
      item.slug,
      diskContent,
      item.metadata_json,
      item.slug
    )

    db.prepare("UPDATE ai_config_items SET content = ?, metadata_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(normalized.content, normalized.metadataJson, itemId)

    // Update baseline only for the pulled provider.
    // Other providers keep their baseline hashes so a subsequent sync-all can overwrite them
    // without false external-edit conflicts.
    const pulledSelection = db.prepare(
      'SELECT id, target_path FROM ai_config_project_selections WHERE project_id = ? AND item_id = ? AND provider = ?'
    ).get(projectId, itemId, provider) as { id: string; target_path: string } | undefined
    if (pulledSelection) {
      const effectiveTargetPath = getCanonicalSelectionTargetPath(provider, item.type, item.slug, pulledSelection.target_path)
      db.prepare(`
        UPDATE ai_config_project_selections
        SET target_path = ?, content_hash = ?, selected_at = datetime('now')
        WHERE id = ?
      `).run(effectiveTargetPath, contentHash(diskContent), pulledSelection.id)
    }

    return recomputeSingleSkillStatus(projectId, projectPath, itemId)
  })

  // --- Provider management ---

  ipcMain.handle('ai-config:list-providers', () => {
    const providers = db.prepare('SELECT * FROM ai_config_sources ORDER BY name').all() as CliProviderInfo[]
    return providers
      .filter((provider) => isConfigurableCliProvider(provider.kind))
      .map((provider) => ({
        ...provider,
        name: PROVIDER_LABELS[provider.kind as CliProvider] ?? provider.name
      }))
  })

  ipcMain.handle('ai-config:toggle-provider', (_event, id: string, enabled: boolean) => {
    const row = db.prepare('SELECT kind FROM ai_config_sources WHERE id = ?').get(id) as { kind: string } | undefined
    if (!row || !isConfigurableCliProvider(row.kind)) return
    db.prepare('UPDATE ai_config_sources SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(enabled ? 1 : 0, id)
  })

  // ---------------------------------------------------------------------------
  // Reconcile: auto-create DB records for on-disk skill files
  // ---------------------------------------------------------------------------
  ipcMain.handle('ai-config:reconcile-project-skills', (_event, projectId: string, projectPath: string) => {
    const resolvedProject = path.resolve(projectPath)
    const enabledProviders = new Set(getEnabledProviders(projectId))
    let created = 0

    // 1. Scan skill directories for enabled providers only
    type DiskSkill = { slug: string; filePath: string; relDir: string; provider: CliProvider }
    const discovered: DiskSkill[] = []
    const seenSlugs = new Map<string, DiskSkill>() // slug → first occurrence
    const scannedDirs = new Set<string>()

    for (const [providerKey, mapping] of Object.entries(PROVIDER_PATHS)) {
      if (!isConfigurableCliProvider(providerKey)) continue
      if (!enabledProviders.has(providerKey as CliProvider)) continue
      if (!mapping.skillsDir) continue
      const dir = path.join(resolvedProject, mapping.skillsDir)
      if (scannedDirs.has(dir)) continue // avoid re-scanning shared dirs (codex+gemini → .agents/skills/)
      scannedDirs.add(dir)
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue
      for (const filePath of collectMarkdownFilesRecursive(dir)) {
        const relFile = path.relative(dir, filePath).split(path.sep).join('/')
        const relPath = `${mapping.skillsDir}/${relFile}`
        const slug = skillSlugFromContextPath(relPath)
        if (!slug) continue
        const normalized = normalizeSlug(slug)
        if (!normalized) continue
        const entry: DiskSkill = { slug: normalized, filePath, relDir: mapping.skillsDir, provider: providerKey as CliProvider }
        discovered.push(entry)
        if (!seenSlugs.has(normalized)) seenSlugs.set(normalized, entry)
      }
    }

    if (discovered.length === 0) return 0

    // 2. Query existing items (project-scoped + library) to avoid duplicates
    const existingItems = db.prepare(`
      SELECT id, slug, scope, project_id FROM ai_config_items
      WHERE type = 'skill' AND (
        (scope = 'project' AND project_id = ?) OR scope = 'library'
      )
    `).all(projectId) as Array<{ id: string; slug: string; scope: string; project_id: string | null }>
    const slugToItem = new Map(existingItems.map(i => [i.slug, i]))

    // 3. Query existing selections for this project
    const existingSelections = db.prepare(`
      SELECT item_id, provider FROM ai_config_project_selections WHERE project_id = ?
    `).all(projectId) as Array<{ item_id: string; provider: string }>
    const selectionKeys = new Set(existingSelections.map(s => `${s.item_id}:${s.provider}`))

    // 4. For each unique slug, ensure DB item + selection exists
    for (const entry of discovered) {
      let item = slugToItem.get(entry.slug)

      // Create item if not in DB
      if (!item) {
        const id = crypto.randomUUID()
        const rawContent = fs.readFileSync(entry.filePath, 'utf-8')
        const normalized = normalizeSkillForPersistence(entry.slug, rawContent, '{}')
        const content = normalized ? normalized.content : rawContent
        const metadataJson = normalized ? normalized.metadataJson : '{}'

        db.prepare(`
          INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
          VALUES (?, 'skill', 'project', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(id, projectId, entry.slug, entry.slug, content, metadataJson)

        item = { id, slug: entry.slug, scope: 'project', project_id: projectId }
        slugToItem.set(entry.slug, item)
        created++
      }

      // Create selection if missing for this provider
      const selKey = `${item.id}:${entry.provider}`
      if (!selectionKeys.has(selKey)) {
        const targetPath = getSkillPath(entry.provider, entry.slug) ?? `${entry.relDir}/${entry.slug}/SKILL.md`
        const selId = crypto.randomUUID()
        try {
          db.prepare(`
            INSERT INTO ai_config_project_selections (id, project_id, item_id, provider, target_path, selected_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(project_id, item_id, provider) DO NOTHING
          `).run(selId, projectId, item.id, entry.provider, targetPath)
        } catch { /* ignore constraint errors */ }
        selectionKeys.add(selKey)
      }
    }

    return created
  })

  ipcMain.handle('ai-config:get-project-providers', (_event, projectId: string) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?')
      .get(`ai_providers:${projectId}`) as { value: string } | undefined
    if (row) {
      const parsed = parseConfiguredProviders(row.value)
      if (parsed) return parsed
    }
    // Fallback: all globally enabled active providers
    const providers = db.prepare('SELECT kind FROM ai_config_sources WHERE enabled = 1 AND status = ?')
      .all('active') as Array<{ kind: string }>
    return filterConfigurableCliProviders(providers.map(p => p.kind))
  })

  ipcMain.handle('ai-config:set-project-providers', (_event, projectId: string, providers: CliProvider[]) => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`ai_providers:${projectId}`, JSON.stringify(filterConfigurableCliProviders(providers)))
  })

  ipcMain.handle('ai-config:needs-sync', (_event, projectId: string, projectPath: string): boolean => {
    const providers = getEnabledProviders(projectId)
    if (providers.length === 0) return false
    const enabledSet = new Set(providers)
    const resolvedProject = path.resolve(projectPath)

    // Check root instructions
    const rootItem = db.prepare(
      "SELECT content FROM ai_config_items WHERE type = 'root_instructions' AND scope = 'project' AND project_id = ?"
    ).get(projectId) as { content: string } | undefined
    if (rootItem) {
      const hash = contentHash(rootItem.content)
      for (const provider of providers) {
        const rootPath = PROVIDER_PATHS[provider]?.rootInstructions
        if (!rootPath) continue
        const filePath = path.join(resolvedProject, rootPath)
        if (!fs.existsSync(filePath)) return true
        if (contentHash(fs.readFileSync(filePath, 'utf-8')) !== hash) return true
      }
    }

    // Check skills
    const selections = queryProjectSkillSelections(db, projectId)

    for (const sel of selections) {
      if (!isConfigurableCliProvider(sel.provider)) continue
      if (!enabledSet.has(sel.provider as CliProvider)) continue
      const provider = sel.provider as CliProvider
      const effectiveTargetPath = getCanonicalSelectionTargetPath(provider, sel.item_type, sel.item_slug, sel.target_path)
      const expectedContent = getSyncedItemContent(provider, sel.item_type, sel.item_slug, effectiveTargetPath, sel.item_content, sel.item_metadata)
      const filePath = path.isAbsolute(effectiveTargetPath)
        ? effectiveTargetPath
        : path.join(resolvedProject, effectiveTargetPath)
      if (!fs.existsSync(filePath)) return true
      const diskHash = contentHash(fs.readFileSync(filePath, 'utf-8'))
      const itemHash = contentHash(expectedContent)
      if (diskHash !== itemHash) return true
    }

    return false
  })

  ipcMain.handle('ai-config:get-project-stale-skill-count', (_event, projectId: string, projectPath: string): number => {
    const providers = getEnabledProviders(projectId)
    if (providers.length === 0) return 0
    const enabledSet = new Set(providers)
    const resolvedProject = path.resolve(projectPath)

    const selections = queryProjectSkillSelections(db, projectId)

    let stale = 0
    for (const sel of selections) {
      if (!isConfigurableCliProvider(sel.provider)) continue
      if (!enabledSet.has(sel.provider as CliProvider)) continue
      const provider = sel.provider as CliProvider
      const effectiveTargetPath = getCanonicalSelectionTargetPath(provider, sel.item_type, sel.item_slug, sel.target_path)
      const expectedContent = getSyncedItemContent(provider, sel.item_type, sel.item_slug, effectiveTargetPath, sel.item_content, sel.item_metadata)
      const filePath = path.isAbsolute(effectiveTargetPath)
        ? effectiveTargetPath
        : path.join(resolvedProject, effectiveTargetPath)
      const state = computeLinkedSyncState(filePath, expectedContent)
      if (state.syncHealth === 'stale') stale += 1
    }
    return stale
  })

  ipcMain.handle('ai-config:sync-all', (_event, input: SyncAllInput) => {
    const resolvedProject = path.resolve(input.projectPath)
    const singleItemId = input.itemId ?? null

    // Get enabled providers for this project
    let providers = input.providers
    if (!providers) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?')
        .get(`ai_providers:${input.projectId}`) as { value: string } | undefined
      if (row) {
        const parsed = parseConfiguredProviders(row.value)
        if (parsed) {
          providers = parsed
        }
      }
      if (!providers) {
        const active = db.prepare('SELECT kind FROM ai_config_sources WHERE enabled = 1 AND status = ?')
          .all('active') as Array<{ kind: string }>
        providers = filterConfigurableCliProviders(active.map(p => p.kind))
      }
    }
    providers = filterConfigurableCliProviders(providers)

    const result: SyncResult = { written: [], deleted: [], conflicts: [] }

    // Get all selections for this project with item content
    const selections = (db.prepare(`
      SELECT ps.*, i.content as item_content, i.type as item_type, i.slug as item_slug, i.metadata_json as item_metadata
      FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ?
    `).all(input.projectId) as Array<AiConfigProjectSelection & { item_content: string; item_type: string; item_slug: string; item_metadata: string }>)
      .filter((sel) => isConfigurableCliProvider(sel.provider))
      .filter((sel) => singleItemId ? sel.item_id === singleItemId : true)

    const enabledSet = new Set(providers)
    const keepPathsByProvider = new Map<CliProvider, Set<string>>()
    for (const provider of Object.keys(PROVIDER_PATHS)) {
      if (!isConfigurableCliProvider(provider)) continue
      keepPathsByProvider.set(provider, new Set<string>())
    }

    const updateSelection = db.prepare(`
      UPDATE ai_config_project_selections
      SET target_path = ?, content_hash = ?, selected_at = datetime('now')
      WHERE id = ?
    `)

    // Sync only existing provider links for each item.
    for (const sel of selections) {
      const provider = sel.provider as CliProvider
      if (!enabledSet.has(provider)) continue
      if (sel.item_type === 'skill') {
        ensureSkillValidationForSync(sel.item_slug, sel.item_content, sel.item_metadata)
      }

      const effectiveTargetPath = getCanonicalSelectionTargetPath(provider, sel.item_type, sel.item_slug, sel.target_path)
      const syncedContent = getSyncedItemContent(provider, sel.item_type, sel.item_slug, effectiveTargetPath, sel.item_content, sel.item_metadata)
      const hash = contentHash(syncedContent)
      const filePath = path.isAbsolute(effectiveTargetPath)
        ? effectiveTargetPath
        : path.join(resolvedProject, effectiveTargetPath)
      if (!isPathAllowed(filePath, input.projectPath)) continue

      if (sel.item_type === 'skill') {
        keepPathsByProvider.get(provider)?.add(path.resolve(filePath))
      }

      // Check for external edits via content hash.
      // Skipped for single-item sync: the user explicitly chose to overwrite disk after seeing the diff in the edit panel.
      if (!singleItemId && fs.existsSync(filePath) && sel.content_hash) {
        const diskHash = contentHash(fs.readFileSync(filePath, 'utf-8'))
        if (diskHash !== sel.content_hash && diskHash !== hash) {
          result.conflicts.push({ path: effectiveTargetPath, provider: sel.provider as CliProvider, itemId: sel.item_id, reason: 'external_edit' })
          continue
        }
      }

      // Write file
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(filePath, syncedContent, 'utf-8')
      updateSelection.run(effectiveTargetPath, hash, sel.id)
      removeLegacySkillFileIfPresent(
        provider,
        sel.item_type,
        sel.item_slug,
        effectiveTargetPath,
        resolvedProject,
        input.projectPath
      )

      if (effectiveTargetPath !== sel.target_path) {
        const oldFilePath = path.isAbsolute(sel.target_path)
          ? sel.target_path
          : path.join(resolvedProject, sel.target_path)
        if (oldFilePath !== filePath && fs.existsSync(oldFilePath) && isPathAllowed(oldFilePath, input.projectPath)) {
          fs.unlinkSync(oldFilePath)
        }
      }

      result.written.push({ path: effectiveTargetPath, provider })
    }

    // Sync project-local items to all enabled provider paths that support the item type.
    const localItems = (db.prepare(`
      SELECT id, slug, content, type, metadata_json
      FROM ai_config_items
      WHERE scope = 'project' AND project_id = ? AND type = 'skill'
    `).all(input.projectId) as Array<{ id: string; slug: string; content: string; type: 'skill'; metadata_json: string }>)
      .filter((item) => singleItemId ? item.id === singleItemId : true)

    for (const item of localItems) {
      ensureSkillValidationForSync(item.slug, item.content, item.metadata_json)
      for (const provider of providers) {
        const relativePath = getSkillPath(provider, item.slug)
        if (!relativePath) continue

        const filePath = path.join(resolvedProject, relativePath)
        if (!isPathAllowed(filePath, input.projectPath)) continue

        keepPathsByProvider.get(provider)?.add(path.resolve(filePath))

        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        const syncedContent = getSyncedItemContent(provider, item.type, item.slug, relativePath, item.content, item.metadata_json)
        fs.writeFileSync(filePath, syncedContent, 'utf-8')
        removeLegacySkillFileIfPresent(provider, item.type, item.slug, relativePath, resolvedProject, input.projectPath)
        result.written.push({ path: relativePath, provider })
      }
    }

    if (input.pruneUnmanaged && !singleItemId) {
      // Prune unmanaged root instruction files:
      // keep only enabled-provider root files when a project root_instructions item exists.
      const rootItem = db.prepare(
        "SELECT id FROM ai_config_items WHERE type = 'root_instructions' AND scope = 'project' AND project_id = ?"
      ).get(input.projectId) as { id: string } | undefined
      const managedInstructionPaths = new Set<string>()
      if (rootItem) {
        for (const provider of providers) {
          const rootPath = PROVIDER_PATHS[provider]?.rootInstructions
          if (!rootPath) continue
          managedInstructionPaths.add(path.resolve(path.join(resolvedProject, rootPath)))
        }
      }
      for (const provider of Object.keys(PROVIDER_PATHS)) {
        if (!isConfigurableCliProvider(provider)) continue
        const rootPath = PROVIDER_PATHS[provider]?.rootInstructions
        if (!rootPath) continue
        const filePath = path.join(resolvedProject, rootPath)
        const resolvedFile = path.resolve(filePath)
        if (!fs.existsSync(resolvedFile)) continue
        if (!isPathAllowed(resolvedFile, input.projectPath)) continue
        if (managedInstructionPaths.has(resolvedFile)) continue
        fs.unlinkSync(resolvedFile)
        result.deleted.push({
          path: toProjectRelativePath(resolvedProject, resolvedFile),
          provider: provider as CliProvider,
          kind: 'instruction'
        })
      }

      // Prune unmanaged skill markdown files from known provider directories.
      for (const provider of keepPathsByProvider.keys()) {
        const mapping = PROVIDER_PATHS[provider]
        const keep = enabledSet.has(provider) ? (keepPathsByProvider.get(provider) ?? new Set<string>()) : new Set<string>()

        const skillsDir = mapping.skillsDir
        if (skillsDir) {
          const dirPath = path.join(resolvedProject, skillsDir)
          for (const markdownFile of collectMarkdownFilesRecursive(dirPath)) {
            const resolvedFile = path.resolve(markdownFile)
            if (keep.has(resolvedFile)) continue
            if (!isPathAllowed(resolvedFile, input.projectPath)) continue
            fs.unlinkSync(resolvedFile)
            result.deleted.push({
              path: toProjectRelativePath(resolvedProject, resolvedFile),
              provider,
              kind: 'skill'
            })
          }
        }
      }

      // Prune unmanaged MCP config files:
      // - remove provider MCP configs for disabled providers
      // - remove empty MCP configs for enabled providers
      for (const [target, spec] of Object.entries(PROJECT_MCP_SPECS) as Array<[McpTarget, McpConfigSpec | undefined]>) {
        if (!spec) continue
        if (!isConfigurableCliProvider(target)) continue

        const provider = target as CliProvider
        const filePath = path.join(resolvedProject, spec.relativePath)
        if (!fs.existsSync(filePath)) continue
        if (!isPathAllowed(filePath, input.projectPath)) continue

        // Keep MCP files only for enabled providers.
        if (!enabledSet.has(provider)) {
          fs.unlinkSync(filePath)
          result.deleted.push({
            path: toProjectRelativePath(resolvedProject, filePath),
            provider,
            kind: 'mcp'
          })
          continue
        }

        // For enabled providers, prune empty config files.
        try {
          const parsed = spec.read(fs.readFileSync(filePath, 'utf-8'))
          if (Object.keys(parsed).length === 0) {
            fs.unlinkSync(filePath)
            result.deleted.push({
              path: toProjectRelativePath(resolvedProject, filePath),
              provider,
              kind: 'mcp'
            })
          }
        } catch {
          // Keep malformed files untouched; user can fix them manually.
        }
      }
    }

    return result
  })

  ipcMain.handle('ai-config:check-sync-status', (_event, projectId: string, projectPath: string) => {
    const resolvedProject = path.resolve(projectPath)
    const conflicts: SyncConflict[] = []

    const selections = db.prepare(`
      SELECT ps.*, i.content as item_content, i.type as item_type, i.slug as item_slug, i.metadata_json as item_metadata
      FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ?
    `).all(projectId) as Array<AiConfigProjectSelection & { item_content: string; item_type: string; item_slug: string; item_metadata: string }>

    for (const sel of selections) {
      if (!isConfigurableCliProvider(sel.provider)) continue
      const provider = sel.provider as CliProvider
      const effectiveTargetPath = getCanonicalSelectionTargetPath(provider, sel.item_type, sel.item_slug, sel.target_path)
      const expectedContent = getSyncedItemContent(provider, sel.item_type, sel.item_slug, effectiveTargetPath, sel.item_content, sel.item_metadata)
      const filePath = path.isAbsolute(effectiveTargetPath)
        ? effectiveTargetPath
        : path.join(resolvedProject, effectiveTargetPath)

      if (!fs.existsSync(filePath)) continue
      const diskHash = contentHash(fs.readFileSync(filePath, 'utf-8'))
      const expectedHash = contentHash(expectedContent)
      if (sel.content_hash && diskHash !== sel.content_hash && diskHash !== expectedHash) {
        conflicts.push({
          path: effectiveTargetPath,
          provider,
          itemId: sel.item_id,
          reason: 'external_edit'
        })
      }
    }

    return conflicts
  })

  // MCP config discovery + management
  // Specs are imported from provider-registry (PROJECT_MCP_SPECS, COMPUTER_MCP_SPECS)

  function discoverMcpConfigsFromSpecs(
    baseDir: string,
    specs: Partial<Record<McpTarget, McpConfigSpec>>,
  ): McpConfigFileResult[] {
    const results: McpConfigFileResult[] = []
    for (const provider of getConfigurableMcpTargets()) {
      const spec = specs[provider]
      if (!spec) continue
      const filePath = path.join(baseDir, spec.relativePath)
      const exists = fs.existsSync(filePath)
      let servers: Record<string, McpServerConfig> = {}
      if (exists) {
        try { servers = spec.read(fs.readFileSync(filePath, 'utf-8')) } catch { /* ignore */ }
      }
      results.push({ provider, exists, writable: spec.writable, servers })
    }
    return results
  }

  function writeMcpServerToSpecs(
    baseDir: string,
    specs: Partial<Record<McpTarget, McpConfigSpec>>,
    provider: McpTarget,
    serverKey: string,
    config: McpServerConfig,
  ): void {
    if (!isConfigurableMcpTarget(provider)) throw new Error(`MCP config for ${provider} is disabled`)
    const spec = specs[provider]
    if (!spec) throw new Error(`MCP config for ${provider} is not supported`)
    if (!spec.writable) throw new Error(`MCP config for ${provider} is read-only`)
    const filePath = path.join(baseDir, spec.relativePath)
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null
    const servers = existing ? (() => { try { return spec.read(existing) } catch { return {} } })() : {}
    servers[serverKey] = { ...config }
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, spec.write(existing, servers), 'utf-8')
  }

  function removeMcpServerFromSpecs(
    baseDir: string,
    specs: Partial<Record<McpTarget, McpConfigSpec>>,
    provider: McpTarget,
    serverKey: string,
  ): void {
    if (!isConfigurableMcpTarget(provider)) throw new Error(`MCP config for ${provider} is disabled`)
    const spec = specs[provider]
    if (!spec) throw new Error(`MCP config for ${provider} is not supported`)
    if (!spec.writable) throw new Error(`MCP config for ${provider} is read-only`)
    const filePath = path.join(baseDir, spec.relativePath)
    if (!fs.existsSync(filePath)) return
    let servers: Record<string, McpServerConfig>
    try { servers = spec.read(fs.readFileSync(filePath, 'utf-8')) } catch { return }
    delete servers[serverKey]
    fs.writeFileSync(filePath, spec.write(fs.readFileSync(filePath, 'utf-8'), servers), 'utf-8')
  }

  // Project-level MCP handlers
  ipcMain.handle('ai-config:discover-mcp-configs', (_event, projectPath: string): McpConfigFileResult[] => {
    return discoverMcpConfigsFromSpecs(path.resolve(projectPath), PROJECT_MCP_SPECS)
  })

  ipcMain.handle('ai-config:write-mcp-server', (_event, input: WriteMcpServerInput) => {
    writeMcpServerToSpecs(path.resolve(input.projectPath), PROJECT_MCP_SPECS, input.provider, input.serverKey, input.config)
  })

  ipcMain.handle('ai-config:remove-mcp-server', (_event, input: RemoveMcpServerInput) => {
    removeMcpServerFromSpecs(path.resolve(input.projectPath), PROJECT_MCP_SPECS, input.provider, input.serverKey)
  })

  // Computer-level MCP handlers
  const homeDir = app.getPath('home')

  ipcMain.handle('ai-config:discover-computer-mcp-configs', (): McpConfigFileResult[] => {
    return discoverMcpConfigsFromSpecs(homeDir, COMPUTER_MCP_SPECS)
  })

  ipcMain.handle('ai-config:write-computer-mcp-server', (_event, input: WriteComputerMcpServerInput) => {
    writeMcpServerToSpecs(homeDir, COMPUTER_MCP_SPECS, input.provider, input.serverKey, input.config)
  })

  ipcMain.handle('ai-config:remove-computer-mcp-server', (_event, input: RemoveComputerMcpServerInput) => {
    removeMcpServerFromSpecs(homeDir, COMPUTER_MCP_SPECS, input.provider, input.serverKey)
  })

  ipcMain.handle('ai-config:check-slay-configured', (_event, projectPath: string): boolean => {
    const keywordPattern = new RegExp(`\\b${SLAY_NUDGE_KEYWORD}\\b`, 'i')
    const resolvedProject = path.resolve(projectPath)

    for (const mapping of Object.values(PROVIDER_PATHS)) {
      if (mapping.rootInstructions) {
        const filePath = path.join(resolvedProject, mapping.rootInstructions)
        if (fs.existsSync(filePath) && keywordPattern.test(fs.readFileSync(filePath, 'utf-8'))) {
          return true
        }
      }
    }

    for (const spec of Object.values(COMPUTER_PROVIDER_PATHS)) {
      if (spec.instructions) {
        const filePath = path.join(homeDir, spec.baseDir, spec.instructions)
        if (fs.existsSync(filePath) && keywordPattern.test(fs.readFileSync(filePath, 'utf-8'))) {
          return true
        }
      }
    }

    return false
  })

  ipcMain.handle('ai-config:setup-slay', (_event, projectPath: string, command: 'instructions' | 'skills'): { ok: boolean; error?: string } => {
    try {
      const cwd = path.resolve(projectPath)
      const shell = process.env.SHELL || userInfo().shell || '/bin/zsh'
      const isFish = shell.endsWith('/fish')
      const shellArgs = isFish ? ['-i', '-l'] : ['-l']
      const cmd = command === 'instructions'
        ? 'slay init instructions >> CLAUDE.md'
        : 'slay init skills'
      execFileSync(shell, [...shellArgs, '-c', cmd], { cwd, timeout: 10000 })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // Marketplace handlers
  registerMarketplaceHandlers(ipcMain, db)
}
