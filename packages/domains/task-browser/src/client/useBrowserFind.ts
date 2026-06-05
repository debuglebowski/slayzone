import { useCallback, useEffect, useRef, useState } from 'react'
import { useShortcutAction } from '@slayzone/ui'

interface UseBrowserFindParams {
  activeViewId: string | null
  multiDeviceMode: boolean
  extensionsManagerOpen: boolean
  activeTabId: string | null
  containerRef: React.RefObject<HTMLDivElement | null>
}

export function useBrowserFind({
  activeViewId,
  multiDeviceMode,
  extensionsManagerOpen,
  activeTabId,
  containerRef
}: UseBrowserFindParams) {
  const [findMode, setFindMode] = useState(false)
  const [findText, setFindText] = useState('')
  const [findResult, setFindResult] = useState<{ active: number; total: number } | null>(null)
  const findInputRef = useRef<HTMLInputElement>(null)

  const focusFindInput = useCallback(
    (select = false) => {
      const focusLocalTarget = () => {
        containerRef.current?.focus({ preventScroll: true })
        const input = findInputRef.current
        input?.focus({ preventScroll: true })
        if (select) input?.select()
      }

      focusLocalTarget()
      void window.api.app.focusRenderer().finally(() => {
        requestAnimationFrame(focusLocalTarget)
      })
    },
    [containerRef]
  )

  const closeFindMode = useCallback(() => {
    setFindMode(false)
    setFindText('')
    setFindResult(null)
    if (activeViewId) {
      void window.api.browser.stopFindInPage(activeViewId, 'clearSelection')
    }
  }, [activeViewId])

  const openFindMode = useCallback(() => {
    if (multiDeviceMode || extensionsManagerOpen) return
    setFindMode(true)
    setFindText('')
    setFindResult(null)
  }, [multiDeviceMode, extensionsManagerOpen])

  useEffect(() => {
    if (findMode) focusFindInput()
  }, [findMode, focusFindInput])

  const findNext = useCallback(
    (forward: boolean) => {
      if (!activeViewId || !findText) return
      void window.api.browser.findInPage(activeViewId, findText, { forward, findNext: true })
    },
    [activeViewId, findText]
  )

  const handleFindTextChange = useCallback(
    (text: string) => {
      setFindText(text)
      if (!activeViewId) return
      if (text) {
        void window.api.browser.findInPage(activeViewId, text, { forward: true })
      } else {
        void window.api.browser.stopFindInPage(activeViewId, 'clearSelection')
        setFindResult(null)
      }
    },
    [activeViewId]
  )

  // Subscribe to found-in-page results
  useEffect(() => {
    if (!findMode) return
    return window.api.browser.onEvent((event) => {
      if (event.type !== 'found-in-page') return
      if (event.viewId !== activeViewId) return
      if (event.finalUpdate) {
        setFindResult({
          active: event.activeMatchOrdinal as number,
          total: event.matches as number
        })
      }
    })
  }, [findMode, activeViewId])

  // Close find when switching tabs
  useEffect(() => {
    if (findMode) closeFindMode()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId])

  // Find shortcuts via scope-aware registry. Routes from both DOM focus
  // ([data-browser-panel] focusin) and WCV focus (browser-view:shortcut IPC).
  useShortcutAction('browser-find', () => {
    if (findMode) {
      focusFindInput(true)
    } else {
      openFindMode()
    }
  })
  useShortcutAction('browser-find-next', () => findNext(true), { enabled: findMode })
  useShortcutAction('browser-find-prev', () => findNext(false), { enabled: findMode })
  useShortcutAction('browser-escape', closeFindMode, { enabled: findMode })

  return {
    findMode,
    findText,
    findResult,
    findInputRef,
    focusFindInput,
    closeFindMode,
    openFindMode,
    findNext,
    handleFindTextChange
  }
}
