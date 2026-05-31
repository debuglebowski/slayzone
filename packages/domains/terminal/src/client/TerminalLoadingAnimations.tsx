import { useEffect, useRef, useState } from 'react'
import { PulseGrid, useVisibleInterval } from '@slayzone/ui'

// 1. Typing Cursor — blinking block cursor with text typed out
function TypingCursor() {
  const text = 'Initializing terminal...'
  const [displayed, setDisplayed] = useState('')
  const [showCursor, setShowCursor] = useState(true)
  const [typing, setTyping] = useState(true)
  const indexRef = useRef(0)

  useVisibleInterval(
    () => {
      if (indexRef.current < text.length) {
        setDisplayed(text.slice(0, indexRef.current + 1))
        indexRef.current++
      } else {
        setTyping(false)
      }
    },
    60,
    { enabled: typing }
  )

  useVisibleInterval(() => setShowCursor((v) => !v), 530)

  return (
    <div className="flex items-center justify-center h-full">
      <div className="font-mono text-sm text-muted-foreground">
        <span className="text-green-500">$</span> {displayed}
        <span
          className={`inline-block w-[8px] h-[14px] bg-muted-foreground align-middle ml-[1px] translate-y-[1px] ${showCursor ? 'opacity-100' : 'opacity-0'}`}
        />
      </div>
    </div>
  )
}

// 2. Matrix Cascade — random characters falling and fading
function MatrixCascade() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resize = () => {
      canvas.width = canvas.offsetWidth * window.devicePixelRatio
      canvas.height = canvas.offsetHeight * window.devicePixelRatio
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
    }
    resize()

    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%^&*(){}[]|;:,.<>?/~`'
    const fontSize = 13
    const cols = Math.floor(canvas.offsetWidth / (fontSize * 0.6))
    const drops: number[] = Array.from({ length: cols }, () => Math.random() * -20)

    let animId: number
    const draw = () => {
      ctx.fillStyle = 'rgba(10, 10, 10, 0.08)'
      ctx.fillRect(0, 0, canvas.offsetWidth, canvas.offsetHeight)
      ctx.font = `${fontSize}px monospace`

      for (let i = 0; i < drops.length; i++) {
        const char = chars[Math.floor(Math.random() * chars.length)]
        const x = i * fontSize * 0.6
        const y = drops[i] * fontSize

        // Head of stream is bright, rest fades
        ctx.fillStyle = `rgba(34, 197, 94, ${Math.random() * 0.3 + 0.1})`
        ctx.fillText(char, x, y)

        if (y > 0) {
          ctx.fillStyle = 'rgba(34, 197, 94, 0.8)'
          ctx.fillText(chars[Math.floor(Math.random() * chars.length)], x, y)
        }

        drops[i] += 0.3 + Math.random() * 0.3
        if (drops[i] * fontSize > canvas.offsetHeight && Math.random() > 0.98) {
          drops[i] = 0
        }
      }
      animId = requestAnimationFrame(draw)
    }
    draw()

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    return () => {
      cancelAnimationFrame(animId)
      observer.disconnect()
    }
  }, [])

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-green-500/60 text-sm font-mono tracking-widest">LOADING</span>
      </div>
    </div>
  )
}

// 4. ASCII Art — animated spinning characters
function AsciiArt() {
  const frames = [
    ['   ╭───╮   ', '   │ ◜ │   ', '   ╰───╯   '],
    ['   ╭───╮   ', '   │ ◝ │   ', '   ╰───╯   '],
    ['   ╭───╮   ', '   │ ◞ │   ', '   ╰───╯   '],
    ['   ╭───╮   ', '   │ ◟ │   ', '   ╰───╯   ']
  ]

  const [frame, setFrame] = useState(0)
  const [dots, setDots] = useState('')

  useVisibleInterval(() => setFrame((f) => (f + 1) % frames.length), 150)
  useVisibleInterval(() => setDots((d) => (d.length >= 3 ? '' : d + '.')), 400)

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <pre className="text-muted-foreground text-xs leading-tight font-mono select-none">
        {frames[frame].join('\n')}
      </pre>
      <span className="text-muted-foreground text-xs font-mono w-20 text-center">
        loading{dots}
      </span>
    </div>
  )
}

// 5. Scanline — horizontal line sweeping down like a boot sequence
function Scanline() {
  const [lines, setLines] = useState<string[]>([])
  const [booting, setBooting] = useState(true)
  const indexRef = useRef(0)
  const bootMessages = [
    '[  OK  ] Loading kernel modules...',
    '[  OK  ] Mounting filesystems...',
    '[  OK  ] Starting network manager...',
    '[  OK  ] Initializing PTY subsystem...',
    '[  OK  ] Connecting to process...',
    '[  ..  ] Waiting for terminal output...'
  ]

  useVisibleInterval(
    () => {
      if (indexRef.current < bootMessages.length) {
        const msg = bootMessages[indexRef.current]
        indexRef.current++
        setLines((prev) => [...prev, msg])
      } else {
        setBooting(false)
      }
    },
    350,
    { enabled: booting }
  )

  return (
    <div className="flex flex-col justify-end h-full p-4 overflow-hidden">
      <div className="font-mono text-xs space-y-1">
        {lines.map((line, i) => (
          <div key={i} className="flex gap-2" style={{ animation: 'fade-in 0.3s ease-out' }}>
            <span className={`${line.includes('..') ? 'text-yellow-500' : 'text-green-500'}`}>
              {line.slice(0, 8)}
            </span>
            <span className="text-muted-foreground">{line.slice(8)}</span>
          </div>
        ))}
        <div className="h-[14px] w-[8px] bg-muted-foreground animate-pulse" />
      </div>
      <style>{`
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}

// Showcase all animations stacked
export function TerminalLoadingShowcase() {
  const animations = [
    { name: 'Typing Cursor', component: TypingCursor },
    { name: 'Matrix Cascade', component: MatrixCascade },
    { name: 'Pulse Grid', component: PulseGrid },
    { name: 'ASCII Spinner', component: AsciiArt },
    { name: 'Boot Sequence', component: Scanline }
  ]

  return (
    <div className="flex flex-col gap-2 h-full p-2 overflow-auto">
      {animations.map(({ name, component: Component }) => (
        <div
          key={name}
          className="flex-1 min-h-[120px] rounded-lg border border-border overflow-hidden relative"
        >
          <div className="absolute top-2 left-3 z-10 text-[10px] text-muted-foreground font-mono">
            {name}
          </div>
          <div className="h-full w-full bg-surface-0">
            <Component />
          </div>
        </div>
      ))}
    </div>
  )
}

// Export individual animations for final selection
export { TypingCursor, MatrixCascade, PulseGrid, AsciiArt, Scanline }
