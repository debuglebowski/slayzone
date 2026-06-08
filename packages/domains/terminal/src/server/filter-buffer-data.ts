import { stripUnderlineCodes } from '@slayzone/terminal/shared'

/**
 * Filter out terminal escape sequences that cause rendering issues.
 * Strips OSC title/clipboard sequences and SGR 4 (underline) codes.
 */
export function filterBufferData(data: string): string {
  return stripUnderlineCodes(
    data
      // Strip title-setting (0,1,2) and clipboard (52) OSC sequences
      .replace(/\x1b\](?:[012]|52)[;][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  )
}
