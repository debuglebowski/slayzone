import { createHash } from 'node:crypto'
import { parseSkillFrontmatter } from '../shared/skill-frontmatter'

const GITHUB_API = 'https://api.github.com'
const MAX_CONCURRENT = 5

interface GitTreeEntry {
  path: string
  type: 'blob' | 'tree'
  sha: string
}

interface RegistryManifest {
  name?: string
  skills?: Array<{
    slug: string
    category?: string
    author?: string
  }>
}

export interface FetchedSkillEntry {
  slug: string
  name: string
  description: string
  content: string
  version: string
  category: string | null
  author: string | null
  content_hash: string
}

export interface FetchRegistryResult {
  entries: FetchedSkillEntry[]
  etag: string | null
}

function githubHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'SlayZone-SkillMarketplace'
  }
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Fetch all SKILL.md files from a GitHub repo's skills directory.
 * Returns null if 304 (not modified since etag).
 */
export async function fetchGitHubRegistry(opts: {
  owner: string
  repo: string
  branch: string
  path: string
  etag?: string | null
  token?: string
}): Promise<FetchRegistryResult | null> {
  const { owner, repo, branch, path: skillsPath, etag, token } = opts
  const headers = githubHeaders(token)

  // 1. Fetch repo tree
  if (etag) headers['If-None-Match'] = etag

  const treeUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
  const treeRes = await fetch(treeUrl, { headers })

  if (treeRes.status === 304) return null
  if (!treeRes.ok) {
    const text = await treeRes.text()
    throw new Error(`GitHub tree API error ${treeRes.status}: ${text}`)
  }

  const newEtag = treeRes.headers.get('etag')
  const treeData = (await treeRes.json()) as { tree: GitTreeEntry[]; truncated: boolean }

  // Find SKILL.md files under the configured path
  const prefix = skillsPath ? `${skillsPath}/` : ''
  const skillFiles = treeData.tree.filter(
    (e) => e.type === 'blob' && e.path.startsWith(prefix) && e.path.endsWith('/SKILL.md')
  )

  if (skillFiles.length === 0) {
    return { entries: [], etag: newEtag }
  }

  // 2. Try to fetch registry.json manifest for metadata enrichment
  const manifestEntry = treeData.tree.find(
    (e) => e.type === 'blob' && e.path === `${prefix}registry.json`
  )
  let manifest: RegistryManifest | null = null
  if (manifestEntry) {
    try {
      manifest = await fetchFileJson<RegistryManifest>(owner, repo, `${prefix}registry.json`, branch)
    } catch {
      // manifest is optional, ignore errors
    }
  }

  const manifestBySlug = new Map<string, RegistryManifest['skills']>()
  if (manifest?.skills) {
    for (const s of manifest.skills) {
      manifestBySlug.set(s.slug, [s])
    }
  }

  // 3. Fetch SKILL.md contents in batches
  const entries: FetchedSkillEntry[] = []

  for (let i = 0; i < skillFiles.length; i += MAX_CONCURRENT) {
    const batch = skillFiles.slice(i, i + MAX_CONCURRENT)
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const content = await fetchFileContent(owner, repo, file.path, branch, token)
        if (!content) return null

        // Derive slug from path: skills/my-skill/SKILL.md → my-skill
        const parts = file.path.split('/')
        const slug = parts[parts.length - 2]
        if (!slug) return null

        // Parse frontmatter for name/description
        const parsed = parseSkillFrontmatter(content)

        const frontmatterName = parsed?.frontmatter?.['name'] ?? slug
        const frontmatterDesc = parsed?.frontmatter?.['description'] ?? ''

        // Enrich with manifest data
        const manifestData = manifestBySlug.get(slug)?.[0]

        return {
          slug,
          name: frontmatterName,
          description: frontmatterDesc,
          content,
          version: file.sha,
          category: manifestData?.category ?? null,
          author: manifestData?.author ?? null,
          content_hash: contentHash(content)
        } satisfies FetchedSkillEntry
      })
    )

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        entries.push(r.value)
      }
    }
  }

  return { entries, etag: newEtag }
}

async function fetchFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  _token?: string
): Promise<string | null> {
  // Use raw.githubusercontent.com — CDN-served, no API rate limit
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
  const res = await fetch(url)
  if (!res.ok) return null
  return res.text()
}

async function fetchFileJson<T>(
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<T | null> {
  const content = await fetchFileContent(owner, repo, path, ref)
  if (!content) return null
  return JSON.parse(content) as T
}

/**
 * Parse a GitHub URL or shorthand into owner/repo.
 * Accepts: "owner/repo", "https://github.com/owner/repo", "github.com/owner/repo"
 */
export function parseGitHubUrl(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\/+$/, '')

  // owner/repo shorthand
  const shorthand = trimmed.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/)
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2] }

  // Full URL
  const urlMatch = trimmed.match(/(?:https?:\/\/)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/)
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] }

  return null
}
