import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import type {
  ProjectFeatureSyncAggregateResult,
  ProjectFeatureSyncResult,
  RepoFeatureSyncConfig,
  TaskFeatureDetails,
  FeatureAcceptanceItem,
  UpdateTaskFeatureInput
} from '@slayzone/projects/shared'

interface FeatureProjectRow {
  id: string
  path: string | null
  feature_repo_integration_enabled: number
  feature_repo_features_path: string | null
}

interface FeatureLinkRow {
  id: string
  project_id: string
  task_id: string
  feature_id: string | null
  feature_file_path: string
  content_hash: string | null
  existing_task_id: string | null
}

interface ParsedFeature {
  id: string | null
  title: string
  description: string | null
  acceptance: FeatureAcceptanceItem[]
}

interface ScannedFeature {
  relPath: string
  parsed: ParsedFeature
  contentHash: string
}

interface LinkedTaskFileRow {
  link_id: string
  project_id: string
  project_path: string | null
  feature_id: string | null
  feature_file_path: string
  task_title: string
  task_description: string | null
}

interface LinkedFeaturePathRow {
  link_id: string
  feature_file_path: string
  project_path: string | null
}

interface CreateFeatureForTaskRow {
  task_id: string
  project_id: string
  task_title: string
  task_description: string | null
  project_path: string | null
  feature_repo_integration_enabled: number
  feature_repo_features_path: string | null
  existing_link_id: string | null
}

const DEFAULT_FEATURES_PATH = 'docs/features'
const DEFAULT_FEATURE_SYNC_POLL_INTERVAL_SECONDS = 30
const MIN_FEATURE_SYNC_POLL_INTERVAL_SECONDS = 5
const MAX_FEATURE_SYNC_POLL_INTERVAL_SECONDS = 3600

const SETTINGS = {
  defaultFeaturesPath: 'repo_features_default_features_path',
  pollIntervalSeconds: 'repo_features_poll_interval_seconds'
} as const

const FEATURE_DOC_FILENAME = 'FEATURE.md'
const LEGACY_FEATURE_DOC_FILENAME = 'feature.yaml'

function listFeatureSpecFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return []
  const files: string[] = []
  const stack = [rootDir]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(abs)
        continue
      }
      if (!entry.isFile()) continue
      const normalizedName = entry.name.toLowerCase()
      if (normalizedName === FEATURE_DOC_FILENAME.toLowerCase()) {
        files.push(abs)
      }
    }
  }

  return files
}

function stripOptionalQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function parseFeatureYaml(content: string): ParsedFeature | null {
  const lines = content.split(/\r?\n/)
  let featureId: string | null = null
  let featureTitle: string | null = null
  let featureDescription: string | null = null
  let acceptance: FeatureAcceptanceItem[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    if (/^\s+/.test(line)) continue

    const idMatch = line.match(/^id:\s*(.+)\s*$/)
    if (idMatch) {
      featureId = stripOptionalQuotes(idMatch[1])
      continue
    }

    const titleMatch = line.match(/^title:\s*(.+)\s*$/)
    if (titleMatch) {
      featureTitle = stripOptionalQuotes(titleMatch[1])
      continue
    }

    const descBlockMatch = line.match(/^description:\s*\|\s*$/)
    if (descBlockMatch) {
      const blockLines: string[] = []
      let minIndent = Number.POSITIVE_INFINITY

      for (let j = i + 1; j < lines.length; j++) {
        const blockLine = lines[j]
        if (blockLine.trim().length === 0) {
          blockLines.push('')
          continue
        }
        if (!/^\s+/.test(blockLine)) {
          i = j - 1
          break
        }
        const indent = blockLine.length - blockLine.trimStart().length
        minIndent = Math.min(minIndent, indent)
        blockLines.push(blockLine)
        if (j === lines.length - 1) i = j
      }

      if (blockLines.length > 0) {
        const normalized = blockLines
          .map((value) => {
            if (value.length === 0) return ''
            if (!Number.isFinite(minIndent) || minIndent <= 0) return value.trimEnd()
            return value.slice(Math.min(minIndent, value.length)).trimEnd()
          })
          .join('\n')
          .trim()
        featureDescription = normalized || null
      }
      continue
    }

    const descInlineMatch = line.match(/^description:\s*(.+)\s*$/)
    if (descInlineMatch) {
      featureDescription = stripOptionalQuotes(descInlineMatch[1]) || null
      continue
    }

    const acceptanceMatch = line.match(/^acceptance:\s*$/)
    if (acceptanceMatch) {
      acceptance = parseAcceptanceBlock(lines, i)
      while (i + 1 < lines.length && (lines[i + 1].trim().length === 0 || /^\s+/.test(lines[i + 1]))) {
        i += 1
      }
    }
  }

  if (!featureId && !featureTitle) return null
  return {
    id: featureId,
    title: featureTitle || featureId || 'Untitled feature',
    description: featureDescription,
    acceptance
  }
}

function extractMarkdownFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const normalized = content.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: null, body: normalized }
  }
  const closingIndex = normalized.indexOf('\n---\n', 4)
  if (closingIndex === -1) {
    return { frontmatter: null, body: normalized }
  }
  const frontmatter = normalized.slice(4, closingIndex)
  const body = normalized.slice(closingIndex + 5)
  return { frontmatter, body }
}

function parseMarkdownFallbackMeta(body: string): {
  title: string | null
  description: string | null
} {
  const lines = body.split('\n')
  let title: string | null = null
  let description: string | null = null

  for (const line of lines) {
    const heading = line.match(/^#\s+(.+)\s*$/)
    if (heading) {
      title = heading[1].trim()
      break
    }
  }

  const paragraphs = body
    .split(/\n\s*\n/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .filter((chunk) => !chunk.startsWith('#'))
  if (paragraphs.length > 0) {
    description = paragraphs[0]
  }

  return { title, description }
}

function parseFeatureMarkdown(content: string): ParsedFeature | null {
  const { frontmatter, body } = extractMarkdownFrontmatter(content)
  const parsedFrontmatter = frontmatter ? parseFeatureYaml(frontmatter) : null
  const fallback = parseMarkdownFallbackMeta(body)
  const featureId = parsedFrontmatter?.id ?? null
  const featureTitle = parsedFrontmatter?.title?.trim() || fallback.title || featureId || null
  // Keep task descriptions stable: only sync description when explicitly defined in metadata.
  const featureDescription = parsedFrontmatter?.description ?? null
  if (!featureId && !featureTitle) return null
  return {
    id: featureId,
    title: featureTitle || 'Untitled feature',
    description: featureDescription,
    acceptance: parsedFrontmatter?.acceptance ?? []
  }
}

function parseKeyValue(line: string): { key: string; value: string } | null {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
  if (!match) return null
  return { key: match[1], value: stripOptionalQuotes(match[2] ?? '') }
}

function parseAcceptanceBlock(lines: string[], startIndex: number): FeatureAcceptanceItem[] {
  const entries: FeatureAcceptanceItem[] = []
  let current: FeatureAcceptanceItem | null = null

  for (let i = startIndex + 1; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim().length === 0) continue
    if (!/^\s/.test(raw)) break
    if (!raw.startsWith('  ')) break

    const trimmed = raw.trim()
    if (trimmed.startsWith('- ')) {
      if (current) entries.push(current)
      current = { id: '', scenario: '', file: null, resolvedFilePath: null }
      const inline = trimmed.slice(2).trim()
      if (inline.length > 0) {
        const parsed = parseKeyValue(inline)
        if (parsed) {
          if (parsed.key === 'id') current.id = parsed.value
          else if (parsed.key === 'scenario') current.scenario = parsed.value
          else if (parsed.key === 'file') current.file = parsed.value || null
        }
      }
      continue
    }

    if (!current) continue
    const parsed = parseKeyValue(trimmed)
    if (!parsed) continue
    if (parsed.key === 'id') current.id = parsed.value
    else if (parsed.key === 'scenario') current.scenario = parsed.value
    else if (parsed.key === 'file') current.file = parsed.value || null
  }

  if (current) entries.push(current)

  return entries
    .filter((entry) => entry.id.trim().length > 0 || entry.scenario.trim().length > 0 || !!entry.file)
    .map((entry) => ({
      id: entry.id.trim(),
      scenario: entry.scenario.trim() || entry.id.trim() || 'Unnamed scenario',
      file: entry.file?.trim() || null,
      resolvedFilePath: null
    }))
}

function getSetting(db: Database, key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  const value = row?.value?.trim()
  return value && value.length > 0 ? value : fallback
}

function normalizePollIntervalSeconds(value: number | string | null | undefined): number {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_FEATURE_SYNC_POLL_INTERVAL_SECONDS
  const rounded = Math.round(parsed)
  if (rounded < MIN_FEATURE_SYNC_POLL_INTERVAL_SECONDS) return MIN_FEATURE_SYNC_POLL_INTERVAL_SECONDS
  if (rounded > MAX_FEATURE_SYNC_POLL_INTERVAL_SECONDS) return MAX_FEATURE_SYNC_POLL_INTERVAL_SECONDS
  return rounded
}

function normalizeFeaturesFolderPath(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? '').trim()
  const candidate = raw.length > 0 ? raw : fallback
  const normalized = candidate
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')

  if (normalized.length === 0 || normalized === '.') return '.'
  if (path.posix.isAbsolute(normalized)) throw new Error('Features folder must be relative to the repository path')

  const collapsed = path.posix.normalize(normalized)
  if (collapsed === '..' || collapsed.startsWith('../')) {
    throw new Error('Features folder must stay inside the repository path')
  }
  return collapsed
}

function resolveFeatureRoot(projectPath: string, configuredPath: string): string {
  const repoRoot = path.resolve(projectPath)
  const featureRoot = path.resolve(projectPath, configuredPath)
  if (featureRoot !== repoRoot && !featureRoot.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error('Features folder must stay inside the repository path')
  }
  return featureRoot
}

function assertInsidePath(basePath: string, candidatePath: string): void {
  const base = path.resolve(basePath)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(base, candidate)
  if (relative === '') return
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path must stay inside configured Features folder')
  }
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'feature'
}

function buildProviderDefaults(db: Database): {
  terminalMode: string
  providerConfig: string
  claudeFlags: string
  codexFlags: string
  cursorFlags: string
  geminiFlags: string
  opencodeFlags: string
} {
  const terminalMode = getSetting(db, 'default_terminal_mode', 'claude-code')
  const claudeFlags = getSetting(db, 'default_claude_flags', '--allow-dangerously-skip-permissions')
  const codexFlags = getSetting(db, 'default_codex_flags', '--full-auto --search')
  const cursorFlags = getSetting(db, 'default_cursor_flags', '--force')
  const geminiFlags = getSetting(db, 'default_gemini_flags', '--yolo')
  const opencodeFlags = getSetting(db, 'default_opencode_flags', '')
  const providerConfig = JSON.stringify({
    'claude-code': { flags: claudeFlags },
    codex: { flags: codexFlags },
    'cursor-agent': { flags: cursorFlags },
    gemini: { flags: geminiFlags },
    opencode: { flags: opencodeFlags }
  })

  return {
    terminalMode,
    providerConfig,
    claudeFlags,
    codexFlags,
    cursorFlags,
    geminiFlags,
    opencodeFlags
  }
}

function getNextTaskOrder(db: Database, projectId: string): number {
  const row = db.prepare('SELECT COALESCE(MAX("order"), -1) + 1 AS next_order FROM tasks WHERE project_id = ?').get(projectId) as { next_order: number }
  return row.next_order
}

function createTaskForFeature(
  db: Database,
  projectId: string,
  title: string,
  description: string | null
): string {
  const id = crypto.randomUUID()
  const nextOrder = getNextTaskOrder(db, projectId)
  const defaults = buildProviderDefaults(db)
  db.prepare(`
    INSERT INTO tasks (
      id, project_id, title, description, status, priority, "order", terminal_mode,
      provider_config, claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'inbox', 3, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    projectId,
    title,
    description,
    nextOrder,
    defaults.terminalMode,
    defaults.providerConfig,
    defaults.claudeFlags,
    defaults.codexFlags,
    defaults.cursorFlags,
    defaults.geminiFlags,
    defaults.opencodeFlags
  )
  return id
}

function buildTaskTitle(parsed: ParsedFeature, relPath: string): string {
  const normalizedTitle = parsed.title.trim()
  const fallbackTitle =
    path.basename(path.dirname(relPath))
    || path.basename(relPath, path.extname(relPath))
  const base = normalizedTitle || fallbackTitle
  return parsed.id ? `${parsed.id} ${base}` : base
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/')
}

function resolvePathInsideRepo(repoPath: string, candidatePath: string): string | null {
  const repoRoot = path.resolve(repoPath)
  const absPath = path.resolve(candidatePath)
  const relative = path.relative(repoRoot, absPath)
  if (relative === '') return '.'
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return normalizeRelPath(relative)
}

function resolveAcceptanceFilePath(
  repoPath: string,
  featureDirPath: string,
  filePath: string | null
): string | null {
  if (!filePath) return null
  const normalized = filePath.replace(/\\/g, '/').trim()
  if (!normalized) return null
  const candidateAbs = path.isAbsolute(normalized)
    ? normalized
    : normalized.startsWith('./') || normalized.startsWith('../')
      ? path.resolve(repoPath, featureDirPath, normalized)
      : path.resolve(repoPath, normalized)
  return resolvePathInsideRepo(repoPath, candidateAbs)
}

function toScenarioFromFileName(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath))
  const words = base
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  return words.join(' ') || 'Acceptance scenario'
}

function discoverAcceptancePythonFiles(repoPath: string, featureDirPath: string): FeatureAcceptanceItem[] {
  const acceptanceRoot = path.resolve(repoPath, featureDirPath, 'acceptance')
  if (!fs.existsSync(acceptanceRoot)) return []

  const files: string[] = []
  const stack = [acceptanceRoot]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(abs)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.toLowerCase().endsWith('.py')) files.push(abs)
    }
  }

  files.sort((a, b) => a.localeCompare(b))
  return files
    .map((absPath, index): FeatureAcceptanceItem | null => {
      const rel = resolvePathInsideRepo(repoPath, absPath)
      if (!rel) return null
      return {
        id: `SC-PY-${index + 1}`,
        scenario: toScenarioFromFileName(rel),
        file: rel,
        resolvedFilePath: rel
      }
    })
    .filter((item): item is FeatureAcceptanceItem => item !== null)
}

function parseFeatureSpecContent(
  content: string,
  relPath: string,
  projectPath: string
): ParsedFeature | null {
  const lowerRelPath = relPath.toLowerCase()
  const parsed = lowerRelPath.endsWith('.md')
    ? parseFeatureMarkdown(content)
    : parseFeatureYaml(content)
  if (!parsed) return null

  if (lowerRelPath.endsWith('.md')) {
    const featureDirPath = normalizeRelPath(path.dirname(relPath))
    return {
      ...parsed,
      acceptance: discoverAcceptancePythonFiles(projectPath, featureDirPath)
    }
  }
  return parsed
}

function htmlToPlainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}

function normalizeDescriptionForYaml(value: string | null): string | null {
  if (!value) return null
  const maybeHtml = value.includes('<') && value.includes('>')
  const plain = maybeHtml ? htmlToPlainText(value) : value
  const normalized = plain.replace(/\r\n/g, '\n').trim()
  return normalized.length > 0 ? normalized : null
}

function splitTaskTitle(taskTitle: string, linkedFeatureId: string | null): { featureId: string | null; featureTitle: string } {
  const title = taskTitle.trim()
  if (title.length === 0) return { featureId: linkedFeatureId, featureTitle: 'Untitled feature' }
  if (linkedFeatureId && title.startsWith(`${linkedFeatureId} `)) {
    return { featureId: linkedFeatureId, featureTitle: title.slice(linkedFeatureId.length + 1).trim() || title }
  }
  const tokenMatch = title.match(/^([A-Za-z][A-Za-z0-9_-]*-\d+)\s+(.+)$/)
  if (tokenMatch) {
    return {
      featureId: tokenMatch[1],
      featureTitle: tokenMatch[2].trim()
    }
  }
  return { featureId: linkedFeatureId, featureTitle: title }
}

function quoteYaml(value: string): string {
  return JSON.stringify(value)
}

function findTopLevelKeyRange(lines: string[], key: string): { start: number; end: number } | null {
  const keyPattern = new RegExp(`^${key}:`)
  const start = lines.findIndex((line) => keyPattern.test(line))
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim().length === 0) {
      end += 1
      continue
    }
    if (/^\s/.test(line)) {
      end += 1
      continue
    }
    break
  }
  return { start, end }
}

function renderDescriptionYaml(description: string | null): string[] {
  if (!description) return ['description: ""']
  return ['description: |', ...description.split('\n').map((line) => `  ${line}`)]
}

function renderAcceptanceYaml(acceptance: FeatureAcceptanceItem[]): string[] {
  if (acceptance.length === 0) return ['acceptance: []']
  const lines: string[] = ['acceptance:']
  for (const item of acceptance) {
    lines.push(`  - id: ${quoteYaml(item.id)}`)
    lines.push(`    scenario: ${quoteYaml(item.scenario)}`)
    lines.push(`    file: ${quoteYaml(item.file ?? '')}`)
  }
  return lines
}

function renderFeatureFrontmatterLines(
  featureId: string | null,
  featureTitle: string,
  description: string | null,
  acceptance?: FeatureAcceptanceItem[]
): string[] {
  const lines: string[] = []
  if (featureId) lines.push(`id: ${quoteYaml(featureId)}`)
  lines.push(`title: ${quoteYaml(featureTitle)}`)
  lines.push(...renderDescriptionYaml(description))
  if (acceptance) lines.push(...renderAcceptanceYaml(acceptance))
  return lines
}

function upsertFeatureFrontMatter(
  content: string,
  featureId: string | null,
  featureTitle: string,
  description: string | null,
  acceptance?: FeatureAcceptanceItem[]
): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const headerKeys = ['id', 'title', 'description', ...(acceptance ? ['acceptance'] : [])]
  const ranges = headerKeys
    .map((key) => findTopLevelKeyRange(lines, key))
    .filter((range): range is { start: number; end: number } => range != null)
    .sort((a, b) => b.start - a.start)

  for (const range of ranges) {
    lines.splice(range.start, range.end - range.start)
  }

  let insertAt = 0
  while (
    insertAt < lines.length &&
    (lines[insertAt].trim().length === 0 || lines[insertAt].trimStart().startsWith('#'))
  ) {
    insertAt += 1
  }

  const header: string[] = []
  if (featureId) header.push(`id: ${quoteYaml(featureId)}`)
  header.push(`title: ${quoteYaml(featureTitle)}`)
  header.push(...renderDescriptionYaml(description))
  if (acceptance) header.push(...renderAcceptanceYaml(acceptance))
  header.push('')

  lines.splice(insertAt, 0, ...header)
  const updated = lines.join('\n').replace(/\n+$/, '\n')
  return updated
}

function upsertFeatureMarkdownFrontMatter(
  content: string,
  featureId: string | null,
  featureTitle: string,
  description: string | null,
  acceptance?: FeatureAcceptanceItem[]
): string {
  const normalized = content.replace(/\r\n/g, '\n')
  const { body } = extractMarkdownFrontmatter(normalized)
  const frontmatterLines = renderFeatureFrontmatterLines(featureId, featureTitle, description, acceptance)
  const canonicalBody = body.trim().length > 0 ? body.trimStart() : `# ${featureTitle}\n`
  return `---\n${frontmatterLines.join('\n')}\n---\n\n${canonicalBody.replace(/\n+$/, '\n')}`
}

function buildInitialFeatureMarkdownContent(featureTitle: string, description: string | null): string {
  const title = featureTitle.trim() || 'Untitled feature'
  const desc = (description ?? '').trim()
  if (desc.length === 0) {
    return `# ${title}\n`
  }
  return `# ${title}\n\n${desc}\n`
}

function resolveLinkedFeatureFilePath(
  db: Database,
  input: {
    linkId: string
    projectPath: string
    featureFilePath: string
  }
): { featureFilePath: string; featureFileAbs: string } | null {
  const normalizedRelPath = normalizeRelPath(input.featureFilePath)
  const normalizedLower = normalizedRelPath.toLowerCase()
  const featureFileAbs = path.resolve(input.projectPath, normalizedRelPath)

  if (fs.existsSync(featureFileAbs)) {
    // Canonicalize legacy feature.yaml links to FEATURE.md even when both exist.
    if (normalizedLower.endsWith(`/${LEGACY_FEATURE_DOC_FILENAME}`) || normalizedLower === LEGACY_FEATURE_DOC_FILENAME) {
      const nextRelPath = normalizeRelPath(
        path.join(path.dirname(normalizedRelPath), FEATURE_DOC_FILENAME)
      )
      const nextAbsPath = path.resolve(input.projectPath, nextRelPath)

      if (!fs.existsSync(nextAbsPath)) {
        const legacyParsed = parseFeatureYaml(fs.readFileSync(featureFileAbs, 'utf8'))
        const migratedContent = upsertFeatureMarkdownFrontMatter(
          '\n',
          legacyParsed?.id ?? null,
          legacyParsed?.title ?? 'Untitled feature',
          legacyParsed?.description ?? null,
          legacyParsed?.acceptance ?? []
        )
        fs.writeFileSync(nextAbsPath, migratedContent, 'utf8')
      }

      db.prepare(`
        UPDATE project_feature_task_links
        SET feature_file_path = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(nextRelPath, input.linkId)

      return {
        featureFilePath: nextRelPath,
        featureFileAbs: nextAbsPath
      }
    }

    return {
      featureFilePath: normalizedRelPath,
      featureFileAbs
    }
  }

  if (normalizedLower.endsWith(`/${LEGACY_FEATURE_DOC_FILENAME}`) || normalizedLower === LEGACY_FEATURE_DOC_FILENAME) {
    const nextRelPath = normalizeRelPath(
      path.join(path.dirname(normalizedRelPath), FEATURE_DOC_FILENAME)
    )
    const nextAbsPath = path.resolve(input.projectPath, nextRelPath)
    if (fs.existsSync(nextAbsPath)) {
      db.prepare(`
        UPDATE project_feature_task_links
        SET feature_file_path = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(nextRelPath, input.linkId)
      return {
        featureFilePath: nextRelPath,
        featureFileAbs: nextAbsPath
      }
    }
  }

  return null
}

function unlinkFeatureTaskLink(db: Database, linkId: string): void {
  db.prepare('DELETE FROM project_feature_task_links WHERE id = ?').run(linkId)
}

function buildContentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function taskToFeatureFileContent(existingContent: string, taskRow: LinkedTaskFileRow, acceptance?: FeatureAcceptanceItem[]): { content: string; featureId: string | null; featureTitle: string } {
  const titleParts = splitTaskTitle(taskRow.task_title, taskRow.feature_id)
  const featureTitle = titleParts.featureTitle
  const description = normalizeDescriptionForYaml(taskRow.task_description)
  const lowerRelPath = taskRow.feature_file_path.toLowerCase()
  const content = lowerRelPath.endsWith('.md')
    ? upsertFeatureMarkdownFrontMatter(existingContent, titleParts.featureId, featureTitle, description, acceptance)
    : upsertFeatureFrontMatter(existingContent, titleParts.featureId, featureTitle, description, acceptance)
  return { content, featureId: titleParts.featureId, featureTitle }
}

function normalizeEditableAcceptance(input: UpdateTaskFeatureInput['acceptance']): FeatureAcceptanceItem[] {
  const entries: Array<FeatureAcceptanceItem | null> = input.map((item, index) => {
      const rawId = (item.id ?? '').trim()
      const rawScenario = (item.scenario ?? '').trim()
      const rawFile = (item.file ?? '').trim().replace(/\\/g, '/')
      if (!rawId && !rawScenario && !rawFile) return null
      const id = rawId || `SC-${index + 1}`
      const scenario = rawScenario || id
      return {
        id,
        scenario,
        file: rawFile.length > 0 ? rawFile : null,
        resolvedFilePath: null
      }
    })
  return entries.filter((item): item is FeatureAcceptanceItem => item !== null)
}

function buildTaskTitleFromFeature(featureId: string | null, featureTitle: string): string {
  return featureId ? `${featureId} ${featureTitle}` : featureTitle
}

export function syncProjectFeatureTasks(db: Database, projectId: string): ProjectFeatureSyncResult {
  const result: ProjectFeatureSyncResult = {
    scanned: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: []
  }

  const project = db.prepare(`
    SELECT id, path, feature_repo_integration_enabled, feature_repo_features_path
    FROM projects
    WHERE id = ?
  `).get(projectId) as FeatureProjectRow | undefined

  if (!project) {
    result.errors.push('Project not found')
    return result
  }
  if (project.feature_repo_integration_enabled !== 1) return result
  if (!project.path) {
    result.errors.push('Repository path is required for FEATURE.md integration')
    return result
  }

  const featureRoot = normalizeFeaturesFolderPath(
    project.feature_repo_features_path,
    getSetting(db, SETTINGS.defaultFeaturesPath, DEFAULT_FEATURES_PATH)
  )
  const featureRootAbs = resolveFeatureRoot(project.path, featureRoot)
  const featureFiles = listFeatureSpecFiles(featureRootAbs)

  const scannedFeatures: ScannedFeature[] = []
  for (const file of featureFiles) {
    result.scanned += 1
    try {
      const content = fs.readFileSync(file, 'utf8')
      const relPath = normalizeRelPath(path.relative(project.path, file))
      const parsed = parseFeatureSpecContent(content, relPath, project.path)
      if (!parsed) {
        result.skipped += 1
        result.errors.push(`Skipping ${relPath}: missing id/title`)
        continue
      }
      scannedFeatures.push({
        relPath,
        parsed,
        contentHash: crypto.createHash('sha256').update(content).digest('hex')
      })
    } catch (err) {
      result.skipped += 1
      result.errors.push(
        `Failed reading ${normalizeRelPath(path.relative(project.path, file))}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  const existingRowsRaw = db.prepare(`
    SELECT l.id, l.project_id, l.task_id, l.feature_id, l.feature_file_path, l.content_hash, t.id AS existing_task_id
    FROM project_feature_task_links l
    LEFT JOIN tasks t ON t.id = l.task_id
    WHERE l.project_id = ?
  `).all(projectId) as FeatureLinkRow[]
  const existingRows: FeatureLinkRow[] = []
  const staleLinkIds: string[] = []
  for (const row of existingRowsRaw) {
    const resolved = resolveLinkedFeatureFilePath(db, {
      linkId: row.id,
      projectPath: project.path,
      featureFilePath: row.feature_file_path
    })
    if (!resolved) {
      staleLinkIds.push(row.id)
      continue
    }
    row.feature_file_path = resolved.featureFilePath
    existingRows.push(row)
  }
  const existingByPath = new Map(existingRows.map((row) => [row.feature_file_path, row]))
  const existingByFeatureId = new Map(existingRows.filter((row) => row.feature_id).map((row) => [row.feature_id as string, row]))

  db.transaction(() => {
    const deleteLinkStmt = db.prepare('DELETE FROM project_feature_task_links WHERE id = ?')
    const updateTaskStmt = db.prepare(`
      UPDATE tasks
      SET project_id = ?, title = ?, updated_at = datetime('now')
      WHERE id = ?
    `)
    const updateLinkStmt = db.prepare(`
      UPDATE project_feature_task_links
      SET task_id = ?, feature_id = ?, feature_title = ?, feature_file_path = ?, content_hash = ?, last_sync_source = 'repo', last_sync_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `)
    const insertLinkStmt = db.prepare(`
      INSERT INTO project_feature_task_links (
        id, project_id, task_id, feature_id, feature_title, feature_file_path, content_hash, last_sync_source, last_sync_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'repo', datetime('now'), datetime('now'), datetime('now'))
    `)

    for (const linkId of staleLinkIds) {
      deleteLinkStmt.run(linkId)
      result.updated += 1
    }

    for (const feature of scannedFeatures) {
      const taskTitle = buildTaskTitle(feature.parsed, feature.relPath)
      const taskDescription = null
      const existing = existingByPath.get(feature.relPath)
        ?? (feature.parsed.id ? existingByFeatureId.get(feature.parsed.id) : undefined)

      if (!existing) {
        const taskId = createTaskForFeature(db, projectId, taskTitle, taskDescription)
        insertLinkStmt.run(
          crypto.randomUUID(),
          projectId,
          taskId,
          feature.parsed.id,
          feature.parsed.title,
          feature.relPath,
          feature.contentHash
        )
        result.created += 1
        continue
      }

      if (!existing.existing_task_id) {
        const taskId = createTaskForFeature(db, projectId, taskTitle, taskDescription)
        updateLinkStmt.run(taskId, feature.parsed.id, feature.parsed.title, feature.relPath, feature.contentHash, existing.id)
        result.created += 1
        continue
      }

      if (
        existing.content_hash === feature.contentHash &&
        existing.feature_file_path === feature.relPath &&
        existing.feature_id === feature.parsed.id
      ) {
        result.skipped += 1
        continue
      }

      updateTaskStmt.run(projectId, taskTitle, existing.existing_task_id)
      updateLinkStmt.run(existing.existing_task_id, feature.parsed.id, feature.parsed.title, feature.relPath, feature.contentHash, existing.id)
      result.updated += 1
    }
  })()

  return result
}

export function syncAllProjectFeatureTasks(db: Database): ProjectFeatureSyncAggregateResult {
  const result: ProjectFeatureSyncAggregateResult = {
    projects: 0,
    scanned: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: []
  }

  const projectRows = db.prepare(`
    SELECT id
    FROM projects
    WHERE feature_repo_integration_enabled = 1
      AND path IS NOT NULL
      AND path != ''
  `).all() as Array<{ id: string }>

  for (const project of projectRows) {
    const projectResult = syncProjectFeatureTasks(db, project.id)
    result.projects += 1
    result.scanned += projectResult.scanned
    result.created += projectResult.created
    result.updated += projectResult.updated
    result.skipped += projectResult.skipped
    result.errors.push(...projectResult.errors.map((err) => `${project.id}: ${err}`))
  }

  return result
}

export function syncTaskToFeatureFile(db: Database, taskId: string): { updated: boolean } {
  const row = db.prepare(`
    SELECT
      l.id AS link_id,
      l.project_id,
      l.feature_id,
      l.feature_file_path,
      p.path AS project_path,
      t.title AS task_title,
      t.description AS task_description
    FROM project_feature_task_links l
    JOIN projects p ON p.id = l.project_id
    JOIN tasks t ON t.id = l.task_id
    WHERE l.task_id = ?
  `).get(taskId) as LinkedTaskFileRow | undefined

  if (!row) return { updated: false }
  if (!row.project_path) return { updated: false }

  const resolved = resolveLinkedFeatureFilePath(db, {
    linkId: row.link_id,
    projectPath: row.project_path,
    featureFilePath: row.feature_file_path
  })
  if (!resolved) return { updated: false }

  row.feature_file_path = resolved.featureFilePath

  const existingContent = fs.readFileSync(resolved.featureFileAbs, 'utf8')
  const acceptance = row.feature_file_path.toLowerCase().endsWith('.md')
    ? discoverAcceptancePythonFiles(row.project_path, normalizeRelPath(path.dirname(row.feature_file_path)))
    : undefined
  const next = taskToFeatureFileContent(existingContent, row, acceptance)
  if (next.content === existingContent) return { updated: false }

  fs.writeFileSync(resolved.featureFileAbs, next.content, 'utf8')
  const contentHash = buildContentHash(next.content)
  db.prepare(`
    UPDATE project_feature_task_links
    SET feature_id = ?, feature_title = ?, content_hash = ?, last_sync_source = 'task', last_sync_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(next.featureId, next.featureTitle, contentHash, row.link_id)

  return { updated: true }
}

export function getTaskFeatureDetails(db: Database, taskId: string): TaskFeatureDetails | null {
  const row = db.prepare(`
    SELECT
      l.id AS link_id,
      l.project_id,
      l.task_id,
      l.feature_id,
      l.feature_title,
      l.feature_file_path,
      l.last_sync_source,
      l.last_sync_at,
      p.path AS project_path,
      COALESCE(t.worktree_path, p.path) AS base_path
    FROM project_feature_task_links l
    JOIN projects p ON p.id = l.project_id
    JOIN tasks t ON t.id = l.task_id
    WHERE l.task_id = ?
    LIMIT 1
  `).get(taskId) as {
    link_id: string
    project_id: string
    task_id: string
    feature_id: string | null
    feature_title: string | null
    feature_file_path: string
    last_sync_source: 'repo' | 'task' | null
    last_sync_at: string | null
    project_path: string | null
    base_path: string | null
  } | undefined

  if (!row) return null

  const resolved = row.project_path
    ? resolveLinkedFeatureFilePath(db, {
        linkId: row.link_id,
        projectPath: row.project_path,
        featureFilePath: row.feature_file_path
      })
    : null
  if (row.project_path && !resolved) {
    unlinkFeatureTaskLink(db, row.link_id)
    return null
  }

  const featureFilePath = normalizeRelPath(resolved?.featureFilePath ?? row.feature_file_path)
  const fileSegments = featureFilePath.split('/').filter(Boolean)
  const featureDirPath = fileSegments.length > 1 ? fileSegments.slice(0, -1).join('/') : '.'
  const featureDirAbsolutePath = row.base_path ? path.resolve(row.base_path, featureDirPath) : null

  let parsed: ParsedFeature | null = null
  if (row.project_path) {
    const featureFileAbs = resolved?.featureFileAbs ?? path.resolve(row.project_path, featureFilePath)
    if (fs.existsSync(featureFileAbs)) {
      try {
        parsed = parseFeatureSpecContent(
          fs.readFileSync(featureFileAbs, 'utf8'),
          featureFilePath,
          row.project_path
        )
      } catch {
        parsed = null
      }
    }
  }

  const acceptance = (parsed?.acceptance ?? []).map((item) => ({
    ...item,
    resolvedFilePath: row.project_path ? resolveAcceptanceFilePath(row.project_path, featureDirPath, item.file) : null
  }))

  return {
    projectId: row.project_id,
    taskId: row.task_id,
    featureId: parsed?.id ?? row.feature_id ?? null,
    title: parsed?.title ?? row.feature_title ?? row.feature_id ?? 'Untitled feature',
    description: parsed?.description ?? null,
    featureFilePath,
    featureDirPath,
    featureDirAbsolutePath,
    acceptance,
    lastSyncAt: row.last_sync_at ?? '',
    lastSyncSource: row.last_sync_source === 'task' ? 'task' : 'repo'
  }
}

export function updateTaskFeatureFile(
  db: Database,
  taskId: string,
  input: UpdateTaskFeatureInput
): { updated: boolean } {
  const row = db.prepare(`
    SELECT
      l.id AS link_id,
      l.project_id,
      l.feature_id,
      l.feature_file_path,
      p.path AS project_path,
      t.title AS task_title,
      t.description AS task_description
    FROM project_feature_task_links l
    JOIN projects p ON p.id = l.project_id
    JOIN tasks t ON t.id = l.task_id
    WHERE l.task_id = ?
  `).get(taskId) as LinkedTaskFileRow | undefined

  if (!row) throw new Error('Task is not linked to a feature')
  if (!row.project_path) throw new Error('Repository path is required for linked feature edits')

  const featureTitle = input.title.trim()
  if (featureTitle.length === 0) throw new Error('Feature title is required')

  const featureId = (input.featureId ?? '').trim() || null
  const description = normalizeDescriptionForYaml(input.description ?? null)
  const acceptanceFromInput = normalizeEditableAcceptance(input.acceptance ?? [])
  const nextTaskTitle = buildTaskTitleFromFeature(featureId, featureTitle)

  const resolved = resolveLinkedFeatureFilePath(db, {
    linkId: row.link_id,
    projectPath: row.project_path,
    featureFilePath: row.feature_file_path
  })
  if (!resolved) throw new Error('Linked feature file does not exist')

  row.feature_file_path = resolved.featureFilePath
  const existingContent = fs.readFileSync(resolved.featureFileAbs, 'utf8')
  const featureDirPath = normalizeRelPath(path.dirname(row.feature_file_path))
  const isMarkdown = row.feature_file_path.toLowerCase().endsWith('.md')
  const acceptance = isMarkdown
    ? discoverAcceptancePythonFiles(row.project_path, featureDirPath)
    : acceptanceFromInput
  const nextContent = isMarkdown
    ? upsertFeatureMarkdownFrontMatter(
        existingContent,
        featureId,
        featureTitle,
        description,
        acceptance
      )
    : upsertFeatureFrontMatter(
        existingContent,
        featureId,
        featureTitle,
        description,
        acceptance
      )

  const fileChanged = nextContent !== existingContent
  if (fileChanged) fs.writeFileSync(resolved.featureFileAbs, nextContent, 'utf8')
  const contentHash = buildContentHash(nextContent)

  const taskChanged = row.task_title !== nextTaskTitle
  if (taskChanged) {
    db.prepare(`
      UPDATE tasks
      SET title = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(nextTaskTitle, taskId)
  }

  db.prepare(`
    UPDATE project_feature_task_links
    SET feature_id = ?, feature_title = ?, content_hash = ?, last_sync_source = 'task', last_sync_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(featureId, featureTitle, contentHash, row.link_id)

  return {
    updated: fileChanged || taskChanged || row.feature_id !== featureId
  }
}

export function createFeatureForTask(
  db: Database,
  taskId: string,
  input: {
    featureId?: string | null
    folderName?: string | null
    title?: string | null
    description?: string | null
  } = {}
): { created: boolean; featureFilePath: string } {
  const row = db.prepare(`
    SELECT
      t.id AS task_id,
      t.project_id,
      t.title AS task_title,
      t.description AS task_description,
      p.path AS project_path,
      p.feature_repo_integration_enabled,
      p.feature_repo_features_path,
      l.id AS existing_link_id
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN project_feature_task_links l ON l.task_id = t.id
    WHERE t.id = ?
    LIMIT 1
  `).get(taskId) as CreateFeatureForTaskRow | undefined

  if (!row) throw new Error('Task not found')
  if (row.existing_link_id) throw new Error('Task is already linked to a feature')
  if (row.feature_repo_integration_enabled !== 1) {
    throw new Error('Enable FEATURE.md integration in Settings first')
  }
  if (!row.project_path) {
    throw new Error('Repository path is required to create feature files')
  }

  const defaultFeaturesPath = getSetting(db, SETTINGS.defaultFeaturesPath, DEFAULT_FEATURES_PATH)
  const configuredFeaturesPath = normalizeFeaturesFolderPath(row.feature_repo_features_path, defaultFeaturesPath)
  const featuresRootAbs = resolveFeatureRoot(row.project_path, configuredFeaturesPath)

  const normalizedFeatureId = (input.featureId ?? '').trim() || null
  const split = splitTaskTitle(row.task_title, normalizedFeatureId)
  const featureTitle = (input.title ?? '').trim() || split.featureTitle || row.task_title.trim() || 'Untitled feature'
  const defaultFolder = normalizedFeatureId ? normalizedFeatureId.toLowerCase() : slugify(featureTitle)
  const folderRel = normalizeFeaturesFolderPath(input.folderName ?? undefined, defaultFolder)
  const folderAbs = path.resolve(featuresRootAbs, folderRel)
  assertInsidePath(featuresRootAbs, folderAbs)

  const featureFileAbs = path.join(folderAbs, FEATURE_DOC_FILENAME)
  const featureFileRel = resolvePathInsideRepo(row.project_path, featureFileAbs)
  if (!featureFileRel) {
    throw new Error('Generated feature path is outside repository path')
  }

  const existingLinkForPath = db.prepare(`
    SELECT task_id
    FROM project_feature_task_links
    WHERE project_id = ? AND feature_file_path = ?
    LIMIT 1
  `).get(row.project_id, featureFileRel) as { task_id: string } | undefined
  if (existingLinkForPath && existingLinkForPath.task_id !== row.task_id) {
    throw new Error('A task is already linked to this feature file path')
  }

  fs.mkdirSync(folderAbs, { recursive: true })
  fs.mkdirSync(path.join(folderAbs, 'acceptance'), { recursive: true })
  const existingContent = fs.existsSync(featureFileAbs) ? fs.readFileSync(featureFileAbs, 'utf8') : null
  const normalizedDescription = normalizeDescriptionForYaml(input.description ?? row.task_description)
  const nextContent = existingContent ?? buildInitialFeatureMarkdownContent(featureTitle, normalizedDescription)
  if (existingContent === null) {
    fs.writeFileSync(featureFileAbs, nextContent, 'utf8')
  }

  const nextTaskTitle = buildTaskTitleFromFeature(normalizedFeatureId, featureTitle)
  if (nextTaskTitle !== row.task_title) {
    db.prepare(`
      UPDATE tasks
      SET title = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(nextTaskTitle, row.task_id)
  }

  const contentHash = buildContentHash(nextContent)
  db.prepare(`
    INSERT INTO project_feature_task_links (
      id, project_id, task_id, feature_id, feature_title, feature_file_path, content_hash,
      last_sync_source, last_sync_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'task', datetime('now'), datetime('now'), datetime('now'))
  `).run(
    crypto.randomUUID(),
    row.project_id,
    row.task_id,
    normalizedFeatureId,
    featureTitle,
    featureFileRel,
    contentHash
  )

  return { created: true, featureFilePath: featureFileRel }
}

export function deleteFeatureForTask(
  db: Database,
  taskId: string
): { deleted: boolean } {
  const row = db.prepare(`
    SELECT
      l.id AS link_id,
      l.feature_file_path,
      p.path AS project_path
    FROM project_feature_task_links l
    JOIN projects p ON p.id = l.project_id
    WHERE l.task_id = ?
    LIMIT 1
  `).get(taskId) as LinkedFeaturePathRow | undefined

  if (!row) return { deleted: false }

  if (row.project_path) {
    const repoRoot = path.resolve(row.project_path)
    const featureFileAbs = path.resolve(row.project_path, row.feature_file_path)
    const featureDirAbs = path.dirname(featureFileAbs)
    const relativeToRepo = path.relative(repoRoot, featureDirAbs)
    if (
      relativeToRepo === ''
      || relativeToRepo.startsWith('..')
      || path.isAbsolute(relativeToRepo)
    ) {
      throw new Error('Refusing to delete feature directory outside repository path')
    }
    fs.rmSync(featureDirAbs, { recursive: true, force: true })
  }

  db.prepare('DELETE FROM project_feature_task_links WHERE id = ?').run(row.link_id)
  return { deleted: true }
}

export function getRepoFeatureSyncConfig(db: Database): RepoFeatureSyncConfig {
  return {
    defaultFeaturesPath: getSetting(db, SETTINGS.defaultFeaturesPath, DEFAULT_FEATURES_PATH),
    pollIntervalSeconds: normalizePollIntervalSeconds(
      getSetting(
        db,
        SETTINGS.pollIntervalSeconds,
        String(DEFAULT_FEATURE_SYNC_POLL_INTERVAL_SECONDS)
      )
    )
  }
}
