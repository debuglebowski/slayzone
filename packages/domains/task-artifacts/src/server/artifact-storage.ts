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
