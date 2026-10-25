import { useState } from 'react'
import { useVisibleInterval } from './use-document-visibility'

const LOADING_TEXTS = [
  'Reticulating splines...',
  'Warming up the hamsters...',
  'Convincing electrons to cooperate...',
  'Bribing the CPU...',
  'Downloading more RAM...',
  'Asking ChatGPT for help... jk',
  'Untangling the spaghetti code...',
  'Feeding the neural network...',
  'Compiling excuses...',
  'Reversing the polarity...',
  'Spinning up the flux capacitor...',
  'Negotiating with the kernel...',
  'Teaching bits to be bytes...',
  'Consulting the magic 8-ball...',
  'Adjusting the vibes...'
]

/**
 * The dot field is a tiled background rather than one element per dot, so its
 * cost is two elements and one disc of pixels no matter how large the pane is.
 * What kills the old square outline is that the field's edge is now the mask,
 * not the last row of dots: a fixed-radius circle fading to nothing, landing on
 * dots that keep going underneath it. The layer is sized to that circle so no
 * dot is painted only to be masked away; the second mask layer takes over in
 * panes too small to hold it, fading to the box instead of being clipped.
 *
 * Its CSS (the `.pulse-grid-*` rules, the `--pulse-grid-wave` @property and its
 * @keyframes) lives in @slayzone/theme-css, not in a <style> rendered here: every
 * hidden terminal shows this loader while it boots, and inserting or removing a
 * stylesheet that registers a property / declares keyframes restyles the WHOLE
 * document — once per loader mount and once per unmount.
 */
export function PulseGrid() {
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
    <div className="relative h-full w-full overflow-hidden text-muted-foreground">
      <div className="pulse-grid-field">
        <div className="pulse-grid-dots absolute inset-0 opacity-15" />
        <div className="pulse-grid-dots pulse-grid-dots--wave absolute inset-0 opacity-80" />
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
  )
}
