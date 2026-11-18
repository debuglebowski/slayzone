/**
 * Hiding the app's tab bar (`app/(tabs)/_layout.tsx`) from a screen pushed in a tab —
 * the phone's task page, whose conversation takes the whole screen (iOS's
 * `hidesBottomBarWhenPushed`). A screen hides it while it is focused
 * (`useHideTabBar`); it shows again once no focused screen holds it, so the sheet over
 * the page (its own screen) holds it too and nothing flickers between them.
 */
import { useFocusEffect } from 'expo-router'
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'

export interface TabBarHidingValue {
  /** Whether a focused screen hides the tab bar. */
  hidden: boolean
  /** Hides the tab bar until the returned release is called. */
  hold: () => () => void
}

const TabBarContext = createContext<TabBarHidingValue | null>(null)

/** The tabs' layout: whether to hide the bar, and the value its screens hold it through. */
export function useTabBarHiding(): TabBarHidingValue {
  const [holds, setHolds] = useState(0)
  const hold = useCallback(() => {
    setHolds((n) => n + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      setHolds((n) => n - 1)
    }
  }, [])
  return useMemo(() => ({ hidden: holds > 0, hold }), [holds, hold])
}

export function TabBarHiding({
  value,
  children
}: {
  value: TabBarHidingValue
  children: ReactNode
}) {
  return <TabBarContext.Provider value={value}>{children}</TabBarContext.Provider>
}

/** Hides the app's tab bar while this screen is focused (`hidden`); outside the tabs, nothing. */
export function useHideTabBar(hidden: boolean): void {
  const hold = useContext(TabBarContext)?.hold
  useFocusEffect(
    useCallback(() => {
      if (!hidden || !hold) return undefined
      return hold()
    }, [hidden, hold])
  )
}
