/**
 * The native media player, loaded on first use rather than at import: expo-video
 * needs its native module the moment it is imported, and a dev client or build made
 * before it was added has none. There the viewer offers Share instead of crashing.
 * Same approach as `direct-rtc.ts`.
 *
 * @module mobile/artifacts/media-player
 */
type PlayerModule = typeof import('./ArtifactMediaPlayer')

let loaded: PlayerModule | null | undefined

/** The player module, or null in a build without expo-video's native module. */
export function mediaPlayer(): PlayerModule | null {
  if (loaded === undefined) {
    try {
      loaded = require('./ArtifactMediaPlayer') as PlayerModule
    } catch {
      loaded = null
    }
  }
  return loaded
}
