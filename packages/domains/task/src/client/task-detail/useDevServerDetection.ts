import React, { useState, useEffect, useRef } from 'react'
import type { Task } from '@slayzone/task/shared'
import { DEV_SERVER_URL_PATTERN } from '@slayzone/terminal/shared'

export interface UseDevServerDetectionParams {
  task: Task | null
  /** Whether the browser panel is currently visible. */
  browserVisible: boolean
  settingsRevision: number
  subscribeDevServer: (sessionId: string, cb: (url: string) => void) => () => void
  getMainSessionId: (id: string) => string
}

export interface UseDevServerDetectionResult {
  detectedDevUrl: string | null
  setDetectedDevUrl: React.Dispatch<React.SetStateAction<string | null>>
  /** Mirrors browser-panel visibility; read by openDevServerInBrowser to decide tab append vs replace. */
  browserOpenRef: React.RefObject<boolean>
  /** Set by the parent to the openDevServerInBrowser callback used for auto-open. */
  devServerAutoOpenCallbackRef: React.RefObject<((url: string) => void) | null>
  /** Per-task toast dismissal flag; parent flips it to true when the toast is dismissed. */
  devUrlToastDismissedRef: React.RefObject<boolean>
}

/**
 * Detects dev-server URLs from the main terminal session and surfaces them via a toast
 * (or auto-opens the browser panel, per settings). Owns the dismissal/auto-open refs that
 * the parent reads/writes.
 */
export function useDevServerDetection({
  task,
  browserVisible,
  settingsRevision,
  subscribeDevServer,
  getMainSessionId
}: UseDevServerDetectionParams): UseDevServerDetectionResult {
  const [detectedDevUrl, setDetectedDevUrl] = useState<string | null>(null)
  const devUrlDismissedRef = useRef<Set<string>>(new Set())
  const devServerToastEnabledRef = useRef(true)
  const devServerAutoOpenRef = useRef(false)
  const devServerAutoOpenCallbackRef = useRef<((url: string) => void) | null>(null)
  const devUrlToastDismissedRef = useRef<boolean>(!!task?.dev_url_toast_dismissed)
  useEffect(() => {
    devUrlToastDismissedRef.current = !!task?.dev_url_toast_dismissed
  }, [task?.dev_url_toast_dismissed])
  const browserOpenRef = useRef(browserVisible)
  useEffect(() => {
    browserOpenRef.current = browserVisible
  }, [browserVisible])

  // Load dev server settings (re-read on settingsRevision change)
  useEffect(() => {
    Promise.all([
      window.api.settings.get('dev_server_toast_enabled'),
      window.api.settings.get('dev_server_auto_open_browser')
    ]).then(([toast, autoOpen]) => {
      devServerToastEnabledRef.current = toast !== '0'
      devServerAutoOpenRef.current = autoOpen === '1'
    })
  }, [settingsRevision])

  useEffect(() => {
    if (!task) return
    const sid = getMainSessionId(task.id)

    const handleUrl = (url: string) => {
      if (browserOpenRef.current || devUrlDismissedRef.current.has(url)) return
      if (devUrlToastDismissedRef.current) return
      devUrlDismissedRef.current.add(url)
      if (devServerAutoOpenRef.current) {
        devServerAutoOpenCallbackRef.current?.(url)
      } else if (devServerToastEnabledRef.current) {
        setDetectedDevUrl(url)
      }
    }

    // Subscribe first, then check buffer (avoids race where URL emits between read and subscribe)
    const unsub = subscribeDevServer(sid, handleUrl)

    window.api.pty.getBuffer(sid).then((buf) => {
      if (!buf || browserOpenRef.current) return
      DEV_SERVER_URL_PATTERN.lastIndex = 0
      const match = buf.match(DEV_SERVER_URL_PATTERN)
      if (match) {
        const url = match[match.length - 1].replace('0.0.0.0', 'localhost')
        handleUrl(url)
      }
    })

    return unsub
  }, [task?.id, subscribeDevServer, getMainSessionId])

  useEffect(() => {
    if (browserVisible) setDetectedDevUrl(null)
  }, [browserVisible])

  return {
    detectedDevUrl,
    setDetectedDevUrl,
    browserOpenRef,
    devServerAutoOpenCallbackRef,
    devUrlToastDismissedRef
  }
}
