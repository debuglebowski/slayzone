import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { CORE_SCHEMA, load, timestampTag } from 'js-yaml'

export type Verdict = 'yes' | 'partial' | 'no' | 'unknown'
export type Confidence = 'high' | 'medium' | 'low'

export interface ComparisonAxis {
  verdict: Verdict
  confidence: Confidence
  note: string
  last_checked: string
}

export interface CompetitorAsset {
  path: string
  caption: string
  proves: string
  source_url: string
  captured_on: string
}

export interface CompetitorEditorial {
  eyebrow: string
  title: string
  summary: string
  verdict: string
  verdict_tag: string
  about_heading: string
  about_kicker: string
  what: string
  strengths: string[]
  weaknesses: string[]
  pick_slayzone: string[]
  pick_competitor: string[]
  scorecard_axes: string[]
  slayzone_weaknesses: string[]
}

export interface CompetitorCanon {
  name: string
  slug: string
  last_checked: string
  primary_category: string
  platforms: string[]
  workflow_shape: string
  license: {
    type: string
    name: string
  }
  pricing: {
    model: string
    summary: string
  }
  relevance: {
    tier: string
    rationale: string
  }
  comparison_axes: Record<string, ComparisonAxis>
  assets?: CompetitorAsset[]
  editorial?: CompetitorEditorial
}

const frontmatterPattern = /^---\n([\s\S]*?)\n---\n/

function assertCanon(value: unknown, slug: string): asserts value is CompetitorCanon {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid competitor canon for "${slug}".`)
  }
}

// js-yaml 5's loader schema leaves timestamps as strings; keep loading them as Dates
// so normalizeDates trims full datetimes to YYYY-MM-DD exactly as before.
const CANON_SCHEMA = CORE_SCHEMA.withTags(timestampTag)

function normalizeDates<T>(value: T): T {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10) as T
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeDates(item)) as T
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeDates(item)])
    ) as T
  }

  return value
}

export async function getCompetitorCanon(slug: string): Promise<CompetitorCanon> {
  const filePath = path.resolve(process.cwd(), '..', 'comparison', slug, 'index.md')
  const raw = await readFile(filePath, 'utf8')
  const match = raw.match(frontmatterPattern)

  if (!match) {
    throw new Error(`Missing frontmatter in competitor canon: ${slug}`)
  }

  const parsed = load(match[1], { schema: CANON_SCHEMA })
  assertCanon(parsed, slug)
  return normalizeDates(parsed)
}

// Returns slugs for every competitor folder in `comparison/` that has an
// `index.md`. Skips legacy/template/research/asset folders (those start with `_`).
export async function listCompetitorSlugs(): Promise<string[]> {
  const root = path.resolve(process.cwd(), '..', 'comparison')
  const entries = await readdir(root, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && e.name !== 'assets')
    .map((e) => e.name)
}

// Returns canons for every competitor that has an `editorial` block —
// i.e. is ready to render a head-to-head page.
export async function listEditorialCompetitors(): Promise<CompetitorCanon[]> {
  const slugs = await listCompetitorSlugs()
  const canons = await Promise.all(slugs.map(getCompetitorCanon))
  return canons.filter((c) => c.editorial)
}
