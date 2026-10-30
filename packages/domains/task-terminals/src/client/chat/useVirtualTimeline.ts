import { useEffect, useState } from 'react'
import { createVirtualTimelineController, type VirtualTimelineController } from './virtual-timeline'
import type { FollowBottomApi } from './useFollowBottom'

/**
 * The timeline's virtualizer, created once per panel: its methods keep their
 * identity, so handing them down (reveal, refs) re-renders nothing. Only
 * `VirtualTimelineRows` subscribes to it — scrolling never re-renders the panel.
 */
export function useVirtualTimeline(
  follow: Pick<FollowBottomApi, 'scrollRef' | 'isStuck' | 'unstick'>
): VirtualTimelineController {
  const [controller] = useState(() => createVirtualTimelineController(follow))
  useEffect(() => () => controller.dispose(), [controller])
  return controller
}
