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
 */
const DOT_PITCH = 12 // px between dot centres
const WAVE_LENGTH = 300 // px between successive ripple crests
/** Radius at which the field has faded to nothing. Clamped to the pane in boxes too small to hold it. */
const FIELD_RADIUS = 300
const WAVE_DURATION = '2s'

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
      <style>{`
        @property --pulse-grid-wave {
          syntax: '<length>';
          inherits: false;
          initial-value: 0px;
        }
        .pulse-grid-field {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          width: min(${FIELD_RADIUS * 2}px, 100%);
          height: min(${FIELD_RADIUS * 2}px, 100%);
          mask-image:
            radial-gradient(circle ${FIELD_RADIUS}px at center, #000 0%, transparent 100%),
            radial-gradient(ellipse farthest-side at center, #000 0%, #000 40%, transparent 100%);
          mask-composite: intersect;
        }
        .pulse-grid-dots {
          background-image: radial-gradient(
            circle at center,
            currentColor 0 1.9px,
            transparent 2.4px
          );
          background-size: ${DOT_PITCH}px ${DOT_PITCH}px;
          background-position: center;
        }
        .pulse-grid-dots--wave {
          background-image: radial-gradient(
            circle at center,
            currentColor 0 2.4px,
            transparent 2.9px
          );
          mask-image: repeating-radial-gradient(
            circle at center,
            transparent calc(var(--pulse-grid-wave) + 0px),
            #000 calc(var(--pulse-grid-wave) + ${WAVE_LENGTH / 2}px),
            transparent calc(var(--pulse-grid-wave) + ${WAVE_LENGTH}px)
          );
          animation: pulse-grid-wave ${WAVE_DURATION} linear infinite;
        }
        @keyframes pulse-grid-wave {
          from { --pulse-grid-wave: 0px; }
          to { --pulse-grid-wave: ${WAVE_LENGTH}px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .pulse-grid-dots--wave { animation: none; }
        }
      `}</style>
    </div>
  )
}
