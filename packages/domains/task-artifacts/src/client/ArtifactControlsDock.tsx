import { useEffect, useRef } from 'react'
import { useStableCallback } from '@slayzone/ui'
import {
  ARTIFACT_CONTROLS_THEME_TOKENS,
  parseArtifactControlsSize,
  withArtifactPreviewMode,
  type ArtifactControlsPosition,
  type ArtifactControlsReadyMessage
} from '@slayzone/platform/artifact-controls'
import {
  HTML_PROTOTYPE_READY,
  parseHtmlPrototypeAction,
  type HtmlPrototypeActionMessage
} from '@slayzone/platform/html-prototype-actions'

export type ArtifactControlsSize = { width: number; height: number }

/** The app's theme, for the plain form controls an artifact puts in a dock. */
function appTheme(element: Element): ArtifactControlsReadyMessage['theme'] {
  const style = getComputedStyle(element)
  const theme: NonNullable<ArtifactControlsReadyMessage['theme']> = {
    colorScheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  }
  for (const token of ARTIFACT_CONTROLS_THEME_TOKENS) {
    const value = style.getPropertyValue(`--${token}`).trim()
    if (value) theme[token] = value
  }
  return theme
}

/**
 * One dock: the artifact's own document, loaded in controls mode for one
 * position (see `@slayzone/platform/artifact-controls`). Relays its actions and
 * its size; tells it when the screens can take actions.
 */
export function ArtifactControlsDock({
  src,
  position,
  ready,
  onAction,
  onResize
}: {
  src: string
  position: ArtifactControlsPosition
  ready: boolean
  onAction: (message: HtmlPrototypeActionMessage) => void
  onResize: (position: ArtifactControlsPosition, size: ArtifactControlsSize) => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)

  const notifyReady = useStableCallback(() => {
    const frame = frameRef.current
    if (!frame?.contentWindow) return
    const message: ArtifactControlsReadyMessage = {
      type: HTML_PROTOTYPE_READY,
      ready,
      theme: appTheme(frame)
    }
    frame.contentWindow.postMessage(message, '*')
  })
  const onMessage = useStableCallback((event: MessageEvent) => {
    if (!frameRef.current?.contentWindow || event.source !== frameRef.current.contentWindow) return
    const action = parseHtmlPrototypeAction(event.data)
    if (action) {
      onAction(action)
      return
    }
    const size = parseArtifactControlsSize(event.data)
    if (size) onResize(position, size)
  })
  useEffect(() => {
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onMessage])
  useEffect(() => {
    notifyReady()
  }, [ready, notifyReady])

  return (
    <iframe
      ref={frameRef}
      title={`Artifact controls — ${position}`}
      src={withArtifactPreviewMode(src, { kind: 'controls', position })}
      sandbox="allow-scripts"
      className="block size-full border-0"
      onLoad={notifyReady}
    />
  )
}
