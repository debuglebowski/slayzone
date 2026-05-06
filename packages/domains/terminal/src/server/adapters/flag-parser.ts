export function parseShellArgs(input: string | null | undefined): string[] {
  if (!input) return []

  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]

    if (ch === '\\' && quote !== "'") {
      const next = input[i + 1]
      if (next !== undefined) {
        current += next
        i += 1
      } else {
        current += ch
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      if (quote === null) {
        quote = ch
        continue
      }
      if (quote === ch) {
        quote = null
        continue
      }
      current += ch
      continue
    }

    if (/\s/.test(ch) && quote === null) {
      if (current.length > 0) {
        args.push(current)
        current = ''
      }
      continue
    }

    current += ch
  }

  if (quote !== null) {
    throw new Error(`Unterminated ${quote} quote in flags`)
  }
  if (current.length > 0) {
    args.push(current)
  }

  return args
}
