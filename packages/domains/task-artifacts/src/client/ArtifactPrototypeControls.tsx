import { useEffect, useRef } from 'react'
import { useStableCallback } from '@slayzone/ui'
import {
  HTML_PROTOTYPE_READY,
  parseHtmlPrototypeAction,
  type HtmlPrototypeActionMessage
} from '@slayzone/platform/html-prototype-actions'

export function ArtifactPrototypeControls({
  src,
  ready,
  onAction
}: {
  src: string
  ready: boolean
  onAction: (message: HtmlPrototypeActionMessage) => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const url = new URL(src)
  url.searchParams.set('slayzone-preview', 'controls')

  const notifyReady = useStableCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: HTML_PROTOTYPE_READY, ready }, '*')
  })
  const onMessage = useStableCallback((event: MessageEvent) => {
    if (!frameRef.current?.contentWindow || event.source !== frameRef.current.contentWindow) return
    const action = parseHtmlPrototypeAction(event.data)
    if (action) onAction(action)
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
      title="Prototype controls"
      src={url.href}
      sandbox="allow-scripts"
      className="block size-full border-0"
      onLoad={notifyReady}
    />
  )
}
