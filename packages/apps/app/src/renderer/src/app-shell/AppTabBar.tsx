import { memo, type ComponentProps } from 'react'
import { TabBar } from '@slayzone/tabs'
import { useVisibleActiveIndex } from '@/hooks/useVisibleTabs'

type AppTabBarProps = Omit<ComponentProps<typeof TabBar>, 'activeIndex'> & {
  /** Full tab index → position among the visible tabs (-1 when filtered out). */
  toVisibleIndex: (fullIndex: number) => number
}

/**
 * The tab bar, subscribed to the active tab itself so a switch re-renders it alone,
 * not App. Memoized: on any other App render it re-renders only when its own props
 * change.
 */
export const AppTabBar = memo(function AppTabBar({
  toVisibleIndex,
  ...props
}: AppTabBarProps): React.JSX.Element {
  const activeIndex = useVisibleActiveIndex(toVisibleIndex)
  return <TabBar {...props} activeIndex={activeIndex} />
})
