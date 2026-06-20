import { motion, AnimatePresence } from 'framer-motion'
import { useState, useEffect, useMemo } from 'react'

export interface CursorWaypoint {
  /** CSS percentage, e.g. '30%' */
  x: string
  /** CSS percentage, e.g. '45%' */
  y: string
  /** Seconds from scene start when cursor arrives here */
  delay: number
  /** Show click ripple (default true) */
  click?: boolean
}

interface Props {
  waypoints: CursorWaypoint[]
  /** Total cycle duration in seconds (default 6) */
  cycleDuration?: number
}

function CursorSvg(): React.JSX.Element {
  return (
    <svg width="14" height="18" viewBox="0 0 16 20" className="drop-shadow-md">
      <path
        d="M0,0 L0,16 L4,12 L8,20 L10,19 L6,11 L12,11 Z"
        fill="white"
        stroke="black"
        strokeWidth="1.2"
      />
    </svg>
  )
}

export function AnimatedCursor({ waypoints, cycleDuration = 6 }: Props): React.JSX.Element | null {
  const [activeClick, setActiveClick] = useState<number | null>(null)

  // Build keyframe arrays from waypoints
  const { xKeys, yKeys, opacityKeys, times } = useMemo(() => {
    if (waypoints.length === 0) return { xKeys: [], yKeys: [], opacityKeys: [], times: [] }

    const x: string[] = []
    const y: string[] = []
    const opacity: number[] = []
    const t: number[] = []

    // Start hidden at first waypoint position
    x.push(waypoints[0].x)
    y.push(waypoints[0].y)
    opacity.push(0)
    t.push(0)

    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i]
      const arriveTime = wp.delay / cycleDuration
      const holdTime = Math.min(arriveTime + 0.05, 1)

      if (i === 0) {
        x.push(wp.x)
        y.push(wp.y)
        opacity.push(1)
        t.push(Math.max(arriveTime - 0.02, 0.01))
      } else {
        x.push(wp.x)
        y.push(wp.y)
        opacity.push(1)
        t.push(arriveTime)
      }

      x.push(wp.x)
      y.push(wp.y)
      opacity.push(1)
      t.push(holdTime)
    }

    const lastWp = waypoints[waypoints.length - 1]
    const fadeOutTime = Math.min((lastWp.delay + 0.8) / cycleDuration, 0.95)
    x.push(lastWp.x)
    y.push(lastWp.y)
    opacity.push(0)
    t.push(fadeOutTime)

    x.push(lastWp.x)
    y.push(lastWp.y)
    opacity.push(0)
    t.push(1)

    return { xKeys: x, yKeys: y, opacityKeys: opacity, times: t }
  }, [waypoints, cycleDuration])

  // Trigger click ripples on schedule
  useEffect(() => {
    const timeouts: ReturnType<typeof setTimeout>[] = []
    waypoints.forEach((wp, i) => {
      if (wp.click === false) return
      const id = setTimeout(() => setActiveClick(i), wp.delay * 1000)
      timeouts.push(id)
    })
    const lastDelay = waypoints[waypoints.length - 1]?.delay ?? 0
    const clearId = setTimeout(() => setActiveClick(null), (lastDelay + 0.5) * 1000)
    timeouts.push(clearId)

    return () => timeouts.forEach(clearTimeout)
  }, [waypoints])

  if (waypoints.length === 0) return null

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 50 }}>
      <motion.div
        className="absolute"
        style={{ left: 0, top: 0 }}
        animate={{
          left: xKeys,
          top: yKeys,
          opacity: opacityKeys
        }}
        transition={{
          duration: cycleDuration,
          times,
          ease: 'easeInOut'
        }}
      >
        <CursorSvg />

        <AnimatePresence>
          {activeClick !== null && (
            <motion.div
              key={activeClick}
              className="absolute -left-2 -top-2 w-5 h-5 rounded-full bg-white/40"
              initial={{ scale: 0, opacity: 0.6 }}
              animate={{ scale: 2, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
