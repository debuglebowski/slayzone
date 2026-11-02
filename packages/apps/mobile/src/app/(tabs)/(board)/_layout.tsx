import { TabStack } from '../../../TabStack'

/** The Board tab's stack. It starts at `index` (the board), also under a deep link into the tab. */
export const unstable_settings = { anchor: 'index' }

export default function BoardTabLayout() {
  return <TabStack tab="board" />
}
