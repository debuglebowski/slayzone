import { readFile, stat } from 'node:fs/promises'
import { ARTIFACT_TEXT_MAX_BYTES, type ArtifactTextRead } from '../shared/text-read'

/** Bytes checked for a NUL. Text the editor can round-trip never contains one. */
const NUL_SNIFF_BYTES = 8192

/**
 * `bytes` as text, or null when they are not UTF-8 text: a NUL in the head, or any
 * invalid UTF-8 sequence. Decoding is exact (a BOM is kept, nothing is replaced),
 * so the text saves back to the same bytes; a lossy decode would rewrite the file
 * on the first autosave.
 */
export function decodeArtifactText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, NUL_SNIFF_BYTES).includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

/** The file at `filePath` for the text editor: its text, or why it is not text. */
export async function readArtifactTextFile(
  filePath: string,
  maxBytes: number = ARTIFACT_TEXT_MAX_BYTES
): Promise<ArtifactTextRead> {
  const { size } = await stat(filePath)
  if (size > maxBytes) return { kind: 'too-large', size }
  const bytes = await readFile(filePath)
  // Grown past the cap between the stat and the read.
  if (bytes.length > maxBytes) return { kind: 'too-large', size: bytes.length }
  const content = decodeArtifactText(bytes)
  return content == null
    ? { kind: 'binary', size: bytes.length }
    : { kind: 'text', content, size: bytes.length }
}
