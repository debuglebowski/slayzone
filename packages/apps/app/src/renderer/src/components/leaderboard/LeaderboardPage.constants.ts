export type Period = 'daily' | 'weekly' | 'monthly' | 'all-time'

export const PERIODS: { value: Period; label: string }[] = [
  { value: 'daily', label: 'Today' },
  { value: 'weekly', label: 'Week' },
  { value: 'monthly', label: 'Month' },
  { value: 'all-time', label: 'All time' }
]
