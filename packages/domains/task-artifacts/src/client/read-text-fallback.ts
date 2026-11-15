import type { ArtifactTextRead } from '../shared/text-read'

/** The hub has no `artifacts.readText`: it is older than this app (or a stale dev sidecar). */
export function isMissingReadTextProcedure(e: unknown): boolean {
  return e instanceof Error && /No procedure found on path "[^"]*readText"/.test(e.message)
}

/**
 * `read()`, or on a hub without that procedure the old whole-file string read,
 * reported as text. Without it every text artifact would show an error against
 * such a hub; with it that hub keeps the old behavior, and its size still routes
 * a large markdown file to the source view.
 */
export async function readTextWithFallback(
  read: () => Promise<ArtifactTextRead | null>,
  readLegacy: () => Promise<string | null>
): Promise<ArtifactTextRead | null> {
  try {
    return await read()
  } catch (e) {
    if (!isMissingReadTextProcedure(e)) throw e
    const content = await readLegacy()
    return content == null
      ? null
      : { kind: 'text', content, size: new TextEncoder().encode(content).length }
  }
}
