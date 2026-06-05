// eslint-disable-next-line no-control-regex
const ANSI_RX = /\x1b\[[0-9;]*m/g
const URL_RX =
  /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\d+\.\d+\.\d+\.\d+)(?::\d+)?(?:\/[^\s"')]*)?)/i

export function extractUrlFromLine(line: string): string | null {
  const m = line.replace(ANSI_RX, '').match(URL_RX)
  return m ? m[1] : null
}
