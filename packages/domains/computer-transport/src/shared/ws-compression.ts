/** Negotiate per-frame compression with peers that support it. Keep short
 * control frames cheap and cap compression CPU and memory on each endpoint. */
export const wsCompression = {
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  threshold: 4_096,
  concurrencyLimit: 4,
  zlibDeflateOptions: { level: 3, memLevel: 6 }
}
