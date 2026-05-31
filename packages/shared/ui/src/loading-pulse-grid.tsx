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

export function PulseGrid() {
  const size = 20
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
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${size}, 6px)` }}>
          {Array.from({ length: size * size }, (_, i) => {
            const row = Math.floor(i / size)
            const col = i % size
            const cx = (size - 1) / 2
            const cy = (size - 1) / 2
            const dist = Math.sqrt((col - cx) ** 2 + (row - cy) ** 2)
            const maxDist = Math.sqrt(cx ** 2 + cy ** 2)
            const edgeFade = 1 - dist / maxDist
            const delay = dist * 0.12

            return (
              <div
                key={i}
                className="w-[6px] h-[6px] rounded-full bg-muted-foreground"
                style={{
                  opacity: edgeFade * 0.15,
                  animation: `pulse-grid 2s ease-in-out ${delay}s infinite`,
                  ['--edge-fade' as string]: edgeFade
                }}
              />
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
      <style>{`
        @keyframes pulse-grid {
          0%, 100% { opacity: calc(0.15 * var(--edge-fade)); transform: scale(0.8); }
          50% { opacity: calc(0.8 * var(--edge-fade)); transform: scale(1.2); }
        }
      `}</style>
    </div>
  )
}
