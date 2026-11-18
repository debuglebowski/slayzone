/**
 * An audio or video artifact in the system player (expo-video: AVPlayer on iOS),
 * from the file the viewer downloaded. Imported only through `media-player.ts`,
 * which keeps a build without expo-video's native module from loading it.
 *
 * A file the player can't open (a codec iOS lacks, a broken file) reports an error
 * status instead of playing: `onUnplayable` then lets the viewer say so and offer Share,
 * rather than leave a black box.
 */
import { useVideoPlayer, VideoView } from 'expo-video'
import { useEffect } from 'react'
import { StyleSheet } from 'react-native'
import { useStableCallback } from '../chat/useStableCallback'

export function ArtifactMediaPlayer({
  uri,
  testID,
  onUnplayable
}: {
  uri: string
  testID?: string
  onUnplayable?: () => void
}) {
  // The player is created for this source and released on unmount.
  const player = useVideoPlayer(uri)
  const unplayable = useStableCallback(() => onUnplayable?.())
  useEffect(() => {
    if (player.status === 'error') {
      unplayable()
      return
    }
    const subscription = player.addListener('statusChange', ({ status }) => {
      if (status === 'error') unplayable()
    })
    return () => subscription.remove()
  }, [player, unplayable])
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      style={styles.player}
      testID={testID}
    />
  )
}

const styles = StyleSheet.create({ player: { flex: 1 } })
