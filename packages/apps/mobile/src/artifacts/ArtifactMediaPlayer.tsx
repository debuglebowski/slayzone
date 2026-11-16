/**
 * An audio or video artifact in the system player (expo-video: AVPlayer on iOS),
 * from the file the viewer downloaded. Imported only through `media-player.ts`,
 * which keeps a build without expo-video's native module from loading it.
 */
import { useVideoPlayer, VideoView } from 'expo-video'
import { StyleSheet } from 'react-native'

export function ArtifactMediaPlayer({ uri, testID }: { uri: string; testID?: string }) {
  // The player is created for this source and released on unmount.
  const player = useVideoPlayer(uri)
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
