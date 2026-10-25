import { useState } from 'react'
import { useVisibleInterval } from '@slayzone/ui'

const LOADING_TEXTS = [
  'Warming up the browser...',
  'Polishing the pixels...',
  'Herding the web workers...',
  'Asking the server nicely...',
  'Untangling the DOM...',
  'Hydrating the divs...',
  'Counting the cookies...',
  'Compiling the vibes...',
  'Negotiating with CORS...',
  'Befriending the CDN...',
  'Flattening the z-index...',
  'Debugging with console.log...',
  'Centering the div...',
  'Clearing the cache... again...',
  'Reticulating stylesheets...'
]

const SIZE = 18

/**
 * The pulse runs entirely on the compositor — no main-thread style work per frame.
 * The old per-dot CSS animation cost ~180ms/s of style recalc (measured, Electron):
 *  - its keyframes scaled opacity by `calc(… * var(--edge-fade))`, which can't be
 *    composited, so every frame restyled the dots;
 *  - and with 324 distinct `animation-delay`s, a CSS animation's iteration
 *    boundaries (`animationiteration` dispatch) landed on the main thread ~130×/s
 *    even once composited.
 * So: the edge fade is a STATIC opacity on a wrapper (opacity multiplies through
 * nesting — wrapper `edgeFade` × dot `0.12…0.6` is exactly the old
 * `0.12…0.6 × edgeFade`), and each dot pulses via a Web Animation (no iteration
 * events) of opacity/transform only. Same keyframes, timing, easing and stagger;
 * before its delay elapses a dot rests at its inline opacity, as before.
 */
const PULSE_KEYFRAMES: Keyframe[] = [
  { opacity: 0.12, transform: 'scale(0.85)', easing: 'ease-in-out' },
  { opacity: 0.6, transform: 'scale(1.15)', easing: 'ease-in-out' },
  { opacity: 0.12, transform: 'scale(0.85)' }
]
const PULSE_MS = 2500

/** Callback ref (module-level → stable): starts every dot's pulse, cancels on unmount. */
function startPulse(grid: HTMLDivElement | null): (() => void) | undefined {
  if (!grid || typeof grid.animate !== 'function') return undefined
  const animations: Animation[] = []
  for (const dot of grid.querySelectorAll<HTMLElement>('[data-pulse-delay]')) {
    animations.push(
      dot.animate(PULSE_KEYFRAMES, {
        duration: PULSE_MS,
        delay: Number(dot.dataset.pulseDelay) * 1000,
        iterations: Infinity
      })
    )
  }
  return () => {
    for (const a of animations) a.cancel()
  }
}

export function BrowserLoadingAnimation() {
  const [textIndex, setTextIndex] = useState(() => Math.floor(Math.random() * LOADING_TEXTS.length))
  const [fade, setFade] = useState(true)

  useVisibleInterval(() => {
    setFade(false)
    setTimeout(() => {
      setTextIndex((i) => (i + 1) % LOADING_TEXTS.length)
      setFade(true)
    }, 300)
  }, 3000)

  return (
    <div className="flex items-center justify-center h-full">
      <div className="relative">
        <div
          ref={startPulse}
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${SIZE}, 6px)` }}
        >
          {Array.from({ length: SIZE * SIZE }, (_, i) => {
            const row = Math.floor(i / SIZE)
            const col = i % SIZE
            const cx = (SIZE - 1) / 2
            const cy = (SIZE - 1) / 2
            const dist = Math.sqrt((col - cx) ** 2 + (row - cy) ** 2)
            const maxDist = Math.sqrt(cx ** 2 + cy ** 2)
            const edgeFade = 1 - dist / maxDist
            const delay = dist * 0.12

            return (
              <div key={i} className="w-[6px] h-[6px]" style={{ opacity: edgeFade }}>
                <div
                  className="size-full rounded-full bg-blue-500 opacity-[0.12]"
                  data-pulse-delay={delay}
                />
              </div>
            )
          })}
        </div>
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span
            className="text-xs font-mono text-muted-foreground transition-opacity duration-300 whitespace-nowrap backdrop-blur-sm rounded-full px-3 py-1"
            style={{ opacity: fade ? 1 : 0 }}
          >
            {LOADING_TEXTS[textIndex]}
          </span>
        </div>
      </div>
    </div>
  )
}
