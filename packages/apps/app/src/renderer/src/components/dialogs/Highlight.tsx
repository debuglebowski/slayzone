import type { ReactNode } from 'react'

export function Highlight({ text, positions }: { text: string; positions: Set<number> }) {
  if (positions.size === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let run = ''
  let inMatch = false
  for (let i = 0; i < text.length; i++) {
    const matched = positions.has(i)
    if (matched !== inMatch && run) {
      parts.push(
        inMatch ? (
          <mark key={i} className="bg-transparent text-foreground font-semibold">
            {run}
          </mark>
        ) : (
          run
        )
      )
      run = ''
    }
    inMatch = matched
    run += text[i]
  }
  if (run) {
    parts.push(
      inMatch ? (
        <mark key={text.length} className="bg-transparent text-foreground font-semibold">
          {run}
        </mark>
      ) : (
        run
      )
    )
  }
  return <>{parts}</>
}
