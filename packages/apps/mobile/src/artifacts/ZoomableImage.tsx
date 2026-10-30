/**
 * An image artifact, as desktop's media view shows it: fitted to the screen at first,
 * pinch to zoom and pan, and Fit / 1:1 to jump back to fitted or to actual size (one
 * image pixel per point). Zooming is iOS's own (`ScrollView`'s zoom scale).
 */
import { useEffect, useState } from 'react'
import { Image, type LayoutChangeEvent, ScrollView, StyleSheet, View } from 'react-native'
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

export function ZoomableImage({ uri, testID }: { uri: string; testID?: string }) {
  const theme = useTheme()
  const [box, setBox] = useState<Size | null>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  // `n` remounts the scroll view, so the chosen scale applies even when it is unchanged.
  const [zoom, setZoom] = useState({ scale: 1, n: 0 })

  useEffect(() => {
    let live = true
    Image.getSize(uri)
      .then(({ width, height }) => {
        if (live) setNatural({ width, height })
      })
      .catch(() => {
        if (live) setNatural(null)
      })
    return () => {
      live = false
    }
  }, [uri])

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout
    setBox({ width, height })
  }

  const fitted = natural && box ? fitInside(natural, box) : null
  const actualScale = natural && fitted ? natural.width / fitted.width : 1

  return (
    <View style={styles.root} onLayout={onLayout} testID={testID}>
      {fitted && box ? (
        <ScrollView
          key={zoom.n}
          style={styles.root}
          contentContainerStyle={{ width: box.width, height: box.height, ...styles.center }}
          minimumZoomScale={1}
          maximumZoomScale={Math.max(8, actualScale * 2)}
          zoomScale={zoom.scale}
          centerContent
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Image source={{ uri }} style={fitted} accessibilityIgnoresInvertColors />
        </ScrollView>
      ) : null}
      <View style={[styles.toolbar, { backgroundColor: theme.card }]}>
        <HeaderButton label="Fit" onPress={() => setZoom((z) => ({ scale: 1, n: z.n + 1 }))} />
        <HeaderButton
          label="1:1"
          disabled={!fitted}
          onPress={() => setZoom((z) => ({ scale: actualScale, n: z.n + 1 }))}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
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
