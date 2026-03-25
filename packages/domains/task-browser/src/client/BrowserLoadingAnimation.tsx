import { useEffect, useState } from 'react'

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
  'Reticulating stylesheets...',
]

const SIZE = 18

export function BrowserLoadingAnimation() {
  const [textIndex, setTextIndex] = useState(() => Math.floor(Math.random() * LOADING_TEXTS.length))
  const [fade, setFade] = useState(true)

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>
    const interval = setInterval(() => {
      setFade(false)
      timeoutId = setTimeout(() => {
        setTextIndex(i => (i + 1) % LOADING_TEXTS.length)
        setFade(true)
      }, 300)
    }, 3000)
    return () => { clearInterval(interval); clearTimeout(timeoutId) }
  }, [])

  return (
    <div className="flex items-center justify-center h-full">
      <div className="relative">
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${SIZE}, 6px)` }}>
          {Array.from({ length: SIZE * SIZE }, (_, i) => {
            const row = Math.floor(i / SIZE)
            const col = i % SIZE
            const cx = (SIZE - 1) / 2
            const cy = (SIZE - 1) / 2
            const dist = Math.sqrt((col - cx) ** 2 + (row - cy) ** 2)
            const maxDist = Math.sqrt(cx ** 2 + cy ** 2)
            const edgeFade = 1 - (dist / maxDist)
            const delay = dist * 0.12

            return (
              <div
                key={i}
                className="w-[6px] h-[6px] rounded-full bg-blue-500"
                style={{
                  opacity: edgeFade * 0.12,
                  animation: `browser-pulse-grid 2.5s ease-in-out ${delay}s infinite`,
                  ['--edge-fade' as string]: edgeFade,
                }}
              />
            )
          })}
        </div>
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span
            className="text-xs font-mono text-neutral-400 transition-opacity duration-300 whitespace-nowrap backdrop-blur-sm rounded-full px-3 py-1"
            style={{ opacity: fade ? 1 : 0 }}
          >
            {LOADING_TEXTS[textIndex]}
          </span>
        </div>
      </div>
      <style>{`
        @keyframes browser-pulse-grid {
          0%, 100% { opacity: calc(0.12 * var(--edge-fade)); transform: scale(0.85); }
          50% { opacity: calc(0.6 * var(--edge-fade)); transform: scale(1.15); }
        }
      `}</style>
    </div>
  )
}
