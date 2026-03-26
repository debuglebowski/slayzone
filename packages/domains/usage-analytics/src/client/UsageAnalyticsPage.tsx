import { BarChart3 } from 'lucide-react'
import { useUsageAnalytics } from './useUsageAnalytics'
import { DateRangeSelector } from './DateRangeSelector'
import { ProviderFilter } from './ProviderFilter'
import { SummaryCards } from './SummaryCards'
import { DailyChart } from './DailyChart'
import { TokenBreakdown } from './TokenBreakdown'
import { ModelBreakdown } from './ModelBreakdown'
import { TopTasksTable } from './TopTasksTable'
import { PROVIDER_USAGE_SUPPORT } from '../shared/types'

const SUPPORTED_PROVIDER_LABELS = Object.values(PROVIDER_USAGE_SUPPORT)
  .filter((p) => p.supported)
  .map((p) => p.label)

function formatSupportedProviders(): string {
  if (SUPPORTED_PROVIDER_LABELS.length === 0) return 'no providers'
  if (SUPPORTED_PROVIDER_LABELS.length === 1) return SUPPORTED_PROVIDER_LABELS[0]
  return `${SUPPORTED_PROVIDER_LABELS.slice(0, -1).join(', ')}, and ${SUPPORTED_PROVIDER_LABELS[SUPPORTED_PROVIDER_LABELS.length - 1]}`
}

interface Props {
  onTaskClick?: (taskId: string) => void
}

export function UsageAnalyticsPage({ onTaskClick }: Props) {
  const {
    data, range, setRange, loading, refresh,
    selectedProvider, setSelectedProvider, providerSupported,
    providerOptions
  } = useUsageAnalytics()

  const providerLabel = providerOptions.find((o) => o.id === selectedProvider)?.label
    ?? PROVIDER_USAGE_SUPPORT[selectedProvider]?.label
    ?? selectedProvider

  return (
    <div className="flex h-full flex-col overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-5xl space-y-4 p-6 flex flex-col min-h-0 flex-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="size-5 text-muted-foreground" />
              <h1 className="text-lg font-semibold">Usage</h1>
            </div>
            <ProviderFilter
              selected={selectedProvider}
              onChange={setSelectedProvider}
              options={providerOptions}
            />
          </div>
          <DateRangeSelector
            range={range}
            onRangeChange={setRange}
            onRefresh={refresh}
            loading={loading}
          />
        </div>

        {!providerSupported ? (
          <div className="rounded-lg border bg-card p-8 text-center">
            <p className="text-sm text-muted-foreground">
              {providerLabel} does not store usage data locally. Usage tracking is only available for {formatSupportedProviders()}.
            </p>
          </div>
        ) : (
          <>
            <SummaryCards data={data} />
            <DailyChart data={data.byDay} range={range} />

            <div className="grid gap-3 md:grid-cols-2">
              <TokenBreakdown data={data} />
              <ModelBreakdown data={data.byModel} />
            </div>

            <div className="flex-1 min-h-0">
              <TopTasksTable data={data.byTask} onTaskClick={onTaskClick} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
