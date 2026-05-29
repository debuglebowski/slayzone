import { Skeleton } from '@slayzone/ui'

export function PanelLoadingSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 border-b border-border h-10 shrink-0">
        <Skeleton className="h-4 w-24" />
        <div className="flex-1" />
        <Skeleton className="h-6 w-6 rounded" />
        <Skeleton className="h-6 w-6 rounded" />
      </div>
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  )
}
