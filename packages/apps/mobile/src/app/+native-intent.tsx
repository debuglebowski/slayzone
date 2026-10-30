import { tabPathOfLink } from '../deep-links'

/**
 * Every link that opens the app (`slayzone://…`, at launch or while it runs) passes
 * here first: a detail screen opens in its own tab (`deep-links.ts`). Never throws (a
 * throw here crashes the app): the mapping is plain string work.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return tabPathOfLink(path)
}
