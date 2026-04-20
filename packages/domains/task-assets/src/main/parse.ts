import { z } from 'zod'
import type { AssetVersion, AssetId, VersionId, ContentHash } from '../shared/types'

const RowSchema = z.object({
  id: z.string(),
  asset_id: z.string(),
  version_num: z.number().int().nonnegative(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/, 'expected SHA-256 hex'),
  size: z.number().int().nonnegative(),
  name: z.string().nullable(),
  author_type: z.union([z.literal('user'), z.literal('agent'), z.null()]),
  author_id: z.string().nullable(),
  created_at: z.string(),
  parent_id: z.string().nullable().optional(),
})

export function parseRow(row: unknown): AssetVersion | null {
  if (row == null) return null
  const parsed = RowSchema.parse(row)
  return {
    id: parsed.id as VersionId,
    asset_id: parsed.asset_id as AssetId,
    version_num: parsed.version_num,
    content_hash: parsed.content_hash as ContentHash,
    size: parsed.size,
    name: parsed.name,
    author_type: parsed.author_type,
    author_id: parsed.author_id,
    created_at: parsed.created_at,
    parent_id: (parsed.parent_id ?? null) as VersionId | null,
  }
}

export function parseRows(rows: unknown[]): AssetVersion[] {
  const out: AssetVersion[] = []
  for (const r of rows) {
    const parsed = parseRow(r)
    if (parsed) out.push(parsed)
  }
  return out
}
