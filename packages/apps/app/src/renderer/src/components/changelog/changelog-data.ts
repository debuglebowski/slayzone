import data from './changelog-data.json'

export type ChangeCategory = 'feature' | 'improvement' | 'fix'

export interface ChangeItem {
  category: ChangeCategory
  title: string
  description?: string
}

export interface ChangelogEntry {
  version: string
  date: string
  tagline: string
  items: ChangeItem[]
}

export const CHANGELOG: ChangelogEntry[] = data as ChangelogEntry[]
