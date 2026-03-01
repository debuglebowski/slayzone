import { motion } from 'framer-motion'
import { useEffect, useState, useRef } from 'react'
import logo from '@/assets/logo-solid.svg'

const FIRST = 'Breath...'
const SECOND = 'then slay'
const TYPE_MS = 60
const ERASE_MS = 40
const PAUSE_BEFORE_START = 300
const PAUSE_AFTER_FIRST = 400
const PAUSE_AFTER_ERASE = 200
const HOLD_AFTER_DONE = 600

export function LoadingScreen({ onDone }: { onDone?: () => void }): React.JSX.Element {
  const [version, setVersion] = useState('')
  const [text, setText] = useState('')
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    window.api.app.getVersion().then(setVersion).catch(() => {})
  }, [])

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    let cancelled = false
    const sleep = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const id = setTimeout(() => (cancelled ? reject() : resolve()), ms)
        timers.push(id)
      })

    async function run() {
      await sleep(PAUSE_BEFORE_START)
      for (let i = 1; i <= FIRST.length; i++) {
        setText(FIRST.slice(0, i))
        await sleep(TYPE_MS)
      }
      await sleep(PAUSE_AFTER_FIRST)
      for (let i = FIRST.length - 1; i >= 0; i--) {
        setText(FIRST.slice(0, i))
        await sleep(ERASE_MS)
      }
      await sleep(PAUSE_AFTER_ERASE)
      for (let i = 1; i <= SECOND.length; i++) {
        setText(SECOND.slice(0, i))
        await sleep(TYPE_MS)
      }
      await sleep(HOLD_AFTER_DONE)
      onDoneRef.current?.()
    }

    run().catch(() => {}) // swallow cancellation
    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [])

  const containerVariants = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0, transition: { duration: 0.3, ease: 'easeOut' as const } }
  }

  const logoVariants = {
    initial: { opacity: 0, scale: 0.8 },
    animate: {
      opacity: 1,
      scale: 1,
      transition: { duration: 0.15, ease: 'easeOut' as const }
    }
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background"
      variants={containerVariants}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <div className="flex flex-col items-center justify-center gap-6">
        <motion.div variants={logoVariants} initial="initial" animate="animate">
          <img
            src={logo}
            alt="SlayZone"
            className="h-48 w-48 rounded-[2rem] shadow-[0_0_80px_rgba(59,130,246,0.5),0_0_160px_rgba(59,130,246,0.25)]"
          />
        </motion.div>
        <div className="flex h-[1.5em] items-center text-2xl font-semibold text-foreground">
          <span className="whitespace-pre">{text}</span>
          <span className="ml-1 inline-block h-[1.1em] w-0.5 animate-blink bg-foreground" />
        </div>
        {version && (
          <motion.div
            className="absolute bottom-6 text-xs text-muted-foreground/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15, delay: 0.3 }}
          >
            v{version}
          </motion.div>
        )}
      </div>
    </motion.div>
  )
}
