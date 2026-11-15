import type { SlayzoneDb } from '@slayzone/platform'
import type { ArtifactReadSpec, ArtifactVersion } from '../shared'
import { createArtifactStore, type ArtifactStore } from './artifact-store'

// Composition installs the owner-aware service. The local factory remains pure
// for computers, tests and the general-artifact implementation.
const services = new Map<string, ArtifactStore>()
export function setArtifactStorage(dataRoot: string, store: ArtifactStore): void {
  services.set(dataRoot, store)
}
export function getArtifactStorage(dataRoot: string): ArtifactStore {
  return services.get(dataRoot) ?? createArtifactStore(dataRoot)
}

/** An artifact's bytes, range by range (a computer-held artifact read in bounded ranges). */
export interface ArtifactRangeReader {
  /** The whole source's size (known from its first range). */
  size: number
  /** The version these bytes are, for a version / blob-backed read. */
  version?: ArtifactVersion
  /** `content` of no artifact (the whole read answers null). */
  missing: boolean
  chunks: AsyncGenerator<Uint8Array, void, void>
}

/**
 * `openArtifactReader(db, artifactId, spec)`: a store that can read an artifact in
 * ranges (the hub's, for a computer that answers bounded reads) answers a reader;
 * null = read it whole (the hub's own artifact, or an older computer).
 */
export type OpenArtifactReader = (
  db: SlayzoneDb,
  artifactId: string,
  spec: ArtifactReadSpec
) => Promise<ArtifactRangeReader | null>

/** `store`'s ranged reader, or null when it has none (a plain local store). */
export function openArtifactReaderOf(store: ArtifactStore): OpenArtifactReader | null {
  const open = (store as ArtifactStore & { openArtifactReader?: OpenArtifactReader })
    .openArtifactReader
  return typeof open === 'function' ? open : null
}
