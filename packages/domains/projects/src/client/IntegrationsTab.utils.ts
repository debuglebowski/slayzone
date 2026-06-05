import type { ImportGithubRepositoryIssuesResult } from '@slayzone/integrations/shared'
import type { ImportIssueSort, ProjectSyncSummary, TaskSyncRow } from './IntegrationsTab.types'

export function summarizeSyncRows(rows: TaskSyncRow[]): ProjectSyncSummary {
  const summary: ProjectSyncSummary = {
    total: rows.length,
    in_sync: 0,
    local_ahead: 0,
    remote_ahead: 0,
    conflict: 0,
    unknown: 0,
    unlinked: 0,
    errors: rows.filter((row) => Boolean(row.error)).length,
    checkedAt: new Date().toISOString()
  }
  for (const row of rows) {
    if (!row.link) {
      summary.unlinked += 1
    } else if (row.status) {
      summary[row.status.state] += 1
    }
  }
  return summary
}

export function formatGithubImportMessage(result: ImportGithubRepositoryIssuesResult): string {
  const parts = [
    `Imported ${result.imported} issues`,
    `${result.created} new`,
    `${result.updated} refreshed`
  ]
  if (result.skippedAlreadyLinked > 0) {
    parts.push(`${result.skippedAlreadyLinked} skipped (linked to another project)`)
  }
  return parts.join(' • ')
}

export function sortByMode<T extends { title: string; updatedAt: string }>(
  rows: T[],
  sort: ImportIssueSort
): T[] {
  const next = [...rows]
  next.sort((a, b) => {
    if (sort === 'updated_desc') {
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    }
    if (sort === 'updated_asc') {
      return Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
    }
    if (sort === 'title_desc') {
      return b.title.localeCompare(a.title)
    }
    return a.title.localeCompare(b.title)
  })
  return next
}
