/**
 * The phone task page's floating chrome, as the page's content sees it: the glass top
 * bar (back, title, status island) floats over the content's top; the tab bar (Agent ·
 * Details · Artifacts) over its bottom, a chat's composer on it as its accessory.
 * Content scrolls under the top bar (its scroll starts below it) and stops above the
 * bottom chrome. Outside the phone's task page (iPad, tests of a part alone) there is
 * none: `useTaskChrome()` is null and content lays out as it always did.
 */
import { createContext, type ReactNode, useContext } from 'react'
import { View } from 'react-native'

export interface TaskChrome {
  /** How far the top bar reaches into the content (pt): scroll content starts below it. */
  top: number
  /** How far the bottom chrome (the tab bar) reaches into the content (pt); 0 with the keyboard up. */
  bottom: number
  /**
   * Where a chat's composer sits (keyboard down): its bottom edge above the content's
   * bottom, and its start edge (past the tab bar's one icon while the bars are compact).
   */
  composer: { bottom: number; start: number; end: number }
  /** The keyboard is up (the tab bar hides; a composer sits on the keyboard). */
  keyboardUp: boolean
  /**
   * The chat's timeline scrolled: how far from its newest message (pt). Scrolling back
   * into the history makes the bars compact; back at the newest, they come back.
   */
  onTimelineScroll: (fromNewest: number) => void
}

const TaskChromeContext = createContext<TaskChrome | null>(null)

export function TaskChromeProvider({
  value,
  children
}: {
  value: TaskChrome | null
  children: ReactNode
}) {
  return <TaskChromeContext.Provider value={value}>{children}</TaskChromeContext.Provider>
}

/** The page's chrome, or null outside the phone's task page. */
export function useTaskChrome(): TaskChrome | null {
  return useContext(TaskChromeContext)
}

/**
 * Keeps content that cannot scroll under the chrome (the terminal: its own key bar and
 * field must stay reachable) clear of it — below the top bar, above the tab bar.
 * The wrapper stays mounted when the available width changes.
 */
export function ChromeInsets({ children }: { children: ReactNode }) {
  const chrome = useTaskChrome()
  return (
    <View style={{ flex: 1, paddingTop: chrome?.top ?? 0, paddingBottom: chrome?.bottom ?? 0 }}>
      {children}
    </View>
  )
}
