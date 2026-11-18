/**
 * A message's text out of the app: its whole markdown, or only its code blocks (each
 * block's code, blank-line separated), copied to the clipboard or handed to the system
 * share sheet.
 */
import * as Clipboard from 'expo-clipboard'
import { lexer, type Tokens } from 'marked'
import { Share } from 'react-native'

/** The fenced / indented code blocks of `markdown`, at any depth (lists, quotes). */
export function codeBlocksOf(markdown: string): string[] {
  const out: string[] = []
  const walk = (tokens: readonly unknown[]): void => {
    for (const token of tokens as Array<{ type: string; tokens?: unknown[]; items?: unknown[] }>) {
      if (token.type === 'code') out.push((token as unknown as Tokens.Code).text)
      if (Array.isArray(token.tokens)) walk(token.tokens)
      if (Array.isArray(token.items)) walk(token.items)
    }
  }
  walk(lexer(markdown))
  return out
}

/** The share sheet with `text`. */
export function shareText(text: string): void {
  void Share.share({ message: text }).catch(() => undefined)
}

/** `text` on the clipboard. */
export function copyText(text: string): void {
  void Clipboard.setStringAsync(text).catch(() => undefined)
}
