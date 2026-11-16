import { createHash } from 'node:crypto'

export function chatStorageDigest(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((key) => [key, v[key]])
            )
          : v
      )
    )
    .digest('hex')
}
