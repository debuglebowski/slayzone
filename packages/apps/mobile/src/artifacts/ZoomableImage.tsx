/**
 * An image artifact, as desktop's media view shows it: fitted to the screen at first,
 * pinch to zoom and pan, a double tap to zoom in to 2x (and back to fit), and Fit / 1:1
 * to jump back to fitted or to actual size (one image pixel per point). Zooming is iOS's
 * own (`ScrollView`'s zoom scale). An image iOS can't read says so.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Image,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { useTheme } from '../theme'
import { HeaderButton } from './ScreenHeader'

interface Size {
  width: number
  height: number
}

/** The image's size fitted inside the box (scaled up or down, aspect kept). */
export function fitInside(image: Size, box: Size): Size {
  const scale = Math.min(box.width / image.width, box.height / image.height)
  return { width: image.width * scale, height: image.height * scale }
}

/** Two taps at most this far apart (ms) are a double tap. */
const DOUBLE_TAP_MS = 300

export function ZoomableImage({ uri, testID }: { uri: string; testID?: string }) {
  const theme = useTheme()
  const [box, setBox] = useState<Size | null>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  // The uri whose size couldn't be read (a new uri starts unfailed).
  const [failedUri, setFailedUri] = useState<string | null>(null)
  const failed = failedUri === uri
  // `n` remounts the scroll view, so the chosen scale applies even when it is unchanged.
  const [zoom, setZoom] = useState({ scale: 1, n: 0 })
  // The scale on screen (pinching changes it without telling `zoom`), and the last tap.
  const shownScale = useRef(1)
  const lastTap = useRef(0)

  useEffect(() => {
    let live = true
    Image.getSize(uri)
      .then(({ width, height }) => {
        if (live) setNatural({ width, height })
      })
      .catch(() => {
        if (!live) return
        setNatural(null)
        setFailedUri(uri)
      })
    return () => {
      live = false
    }
  }, [uri])

  const zoomTo = (scale: number) => {
    shownScale.current = scale
    setZoom((z) => ({ scale, n: z.n + 1 }))
  }
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    shownScale.current = e.nativeEvent.zoomScale ?? shownScale.current
  }
  const onTap = () => {
    const now = Date.now()
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0
      zoomTo(shownScale.current > 1.01 ? 1 : 2)
    } else {
      lastTap.current = now
    }
  }

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout
    setBox({ width, height })
  }

  const fitted = natural && box ? fitInside(natural, box) : null
  const actualScale = natural && fitted ? natural.width / fitted.width : 1

  return (
    <View style={styles.root} onLayout={onLayout} testID={testID}>
      {failed ? (
        <View style={styles.failed}>
          <Text style={{ color: theme.mutedForeground, textAlign: 'center' }}>
            This image couldn't be shown.
          </Text>
        </View>
      ) : fitted && box ? (
        <ScrollView
          key={zoom.n}
          testID={testID ? `${testID}-scroll` : undefined}
          style={styles.root}
          contentContainerStyle={{ width: box.width, height: box.height, ...styles.center }}
          minimumZoomScale={1}
          maximumZoomScale={Math.max(8, actualScale * 2)}
          zoomScale={zoom.scale}
          centerContent
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={64}
        >
          <Pressable
            onPress={onTap}
            testID={testID ? `${testID}-picture` : undefined}
            accessibilityHint="Double-tap to zoom"
          >
            <Image
              source={{ uri }}
              style={fitted}
              accessibilityIgnoresInvertColors
              onError={() => setFailedUri(uri)}
            />
          </Pressable>
        </ScrollView>
      ) : null}
      <View style={[styles.toolbar, { backgroundColor: theme.card }]}>
        <HeaderButton label="Fit" onPress={() => zoomTo(1)} />
        <HeaderButton label="1:1" disabled={!fitted} onPress={() => zoomTo(actualScale)} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  failed: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  toolbar: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    flexDirection: 'row',
    gap: 6,
    padding: 4,
    borderRadius: 8
  }
})
