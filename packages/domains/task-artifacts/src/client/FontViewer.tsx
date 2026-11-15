import { useEffect, useState } from 'react'
import { Input } from '@slayzone/ui'
import { useTRPCClient } from './trpc'

const SIZES = [12, 16, 24, 32, 48, 72]
const CHARACTER_SETS = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  '!?&@#%$€£*()[]{}<>/\\|.,:;\'"-–—_+=~^`'
]

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; family: string }
  | { kind: 'error'; message: string }

/**
 * A font artifact as a type specimen. The font is loaded from its bytes
 * (`artifacts.readBase64` → `FontFace`): a font fetch is CORS-mode, which the
 * `slz-file:` scheme does not serve. The face is registered under a family name
 * unique to this artifact and version, and removed again on unmount.
 */
export function FontViewer({
  artifactId,
  contentVersion
}: {
  artifactId: string
  contentVersion: number
}) {
  const trpcClient = useTRPCClient()
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [sample, setSample] = useState('The quick brown fox jumps over the lazy dog')

  useEffect(() => {
    let cancelled = false
    let face: FontFace | null = null
    const family = `slz-artifact-font-${artifactId}-${contentVersion}`
    trpcClient.artifacts.readBase64
      .query({ id: artifactId })
      .then(async (base64) => {
        if (base64 == null) throw new Error('the artifact no longer exists')
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
        const loaded = await new FontFace(family, bytes).load()
        if (cancelled) return
        face = loaded
        document.fonts.add(loaded)
        setState({ kind: 'ok', family })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        const reason = e instanceof Error ? e.message : String(e)
        setState({ kind: 'error', message: `This font can't be loaded: ${reason}` })
      })
    return () => {
      cancelled = true
      if (face) document.fonts.delete(face)
    }
  }, [trpcClient, artifactId, contentVersion])

  if (state.kind === 'loading')
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
        Loading...
      </div>
    )
  if (state.kind === 'error')
    return (
      <div
        data-testid="artifact-font-error"
        className="flex-1 flex items-center justify-center px-6 text-center text-xs text-muted-foreground"
      >
        {state.message}
      </div>
    )

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="shrink-0 px-4 py-2 border-b border-border">
        <Input
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          placeholder="Type to preview"
          className="h-7 text-xs"
          aria-label="Sample text"
        />
      </div>
      <div
        data-testid="artifact-font"
        className="flex-1 min-h-0 overflow-auto px-6 py-4 text-foreground"
        style={{ fontFamily: `"${state.family}", system-ui` }}
      >
        {SIZES.map((size) => (
          <div key={size} className="flex items-baseline gap-4 py-1">
            <span className="w-8 shrink-0 text-right font-sans text-[10px] text-muted-foreground tabular-nums">
              {size}
            </span>
            <span className="truncate" style={{ fontSize: size, lineHeight: 1.25 }}>
              {sample || ' '}
            </span>
          </div>
        ))}
        <div className="mt-6 space-y-2 text-2xl break-all">
          {CHARACTER_SETS.map((set) => (
            <div key={set}>{set}</div>
          ))}
        </div>
      </div>
    </div>
  )
}
