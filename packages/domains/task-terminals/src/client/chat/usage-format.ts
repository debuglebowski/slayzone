/** Compact token count: `950`, `6.4k`, `50k`, `1M`, `1.3M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k < 10 ? trim(k.toFixed(1)) : Math.round(k)}k`
  }
  return `${trim((n / 1_000_000).toFixed(1))}M`
}

/** Dollar cost: cents, or four decimals below one cent so small sessions don't read as $0.00. */
export function formatCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

function trim(fixed: string): string {
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}
