import { Info } from 'lucide-react'
import { IconButton, Popover, PopoverTrigger, PopoverContent } from '@slayzone/ui'

// --- Graph info popover ---

export function GraphInfoPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          aria-label="Graph info"
          variant="ghost"
          className="h-7 w-7"
          title="Graph legend"
        >
          <Info className="h-3.5 w-3.5" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-xs space-y-3" side="bottom" align="end">
        <p className="font-medium text-[11px]">Graph legend</p>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0">
            <line x1="14" y1="0" x2="14" y2="11" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" />
            <circle cx="14" cy="14" r="3" fill="#e2e2e2" />
            <line x1="14" y1="17" x2="14" y2="28" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" />
          </svg>
          <div>
            <span className="font-medium">Commit</span>
            <p className="text-muted-foreground mt-0.5">A regular commit on a branch.</p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0">
            <line x1="14" y1="0" x2="14" y2="9" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" />
            <circle cx="14" cy="14" r="5" fill="none" stroke="#e2e2e2" strokeWidth="2" />
            <line x1="14" y1="19" x2="14" y2="28" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" />
          </svg>
          <div>
            <span className="font-medium">Merge commit</span>
            <p className="text-muted-foreground mt-0.5">
              A commit where two branches were joined together.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0">
            <line x1="14" y1="0" x2="14" y2="28" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" />
          </svg>
          <div>
            <span className="font-medium">Solid line</span>
            <p className="text-muted-foreground mt-0.5">
              Commits that have been pushed to the remote.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0">
            <line
              x1="14"
              y1="0"
              x2="14"
              y2="28"
              stroke="#e2e2e2"
              strokeWidth="2"
              opacity="0.35"
              strokeDasharray="4 3"
            />
          </svg>
          <div>
            <span className="font-medium">Dashed line</span>
            <p className="text-muted-foreground mt-0.5">
              Local commits not yet pushed. The dashed section ends at the{' '}
              <code className="text-[10px] bg-muted px-0.5 rounded">origin/</code> ref.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0">
            <line x1="10" y1="0" x2="10" y2="28" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" />
            <circle cx="10" cy="10" r="3" fill="#e2e2e2" />
            <path
              d={`M20,20 C10,20 13,10 10,10`}
              stroke="#a78bfa"
              strokeWidth="2"
              fill="none"
              opacity="0.35"
            />
            <circle cx="20" cy="20" r="3" fill="#a78bfa" />
          </svg>
          <div>
            <span className="font-medium">Merged branch</span>
            <p className="text-muted-foreground mt-0.5">
              A branch that was merged and deleted. The colored dot shows which branch it came from.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0">
            <line x1="10" y1="0" x2="10" y2="28" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" />
            <circle cx="10" cy="18" r="3" fill="#e2e2e2" />
            <path
              d={`M20,8 C10,8 13,18 10,18`}
              stroke="#10b981"
              strokeWidth="2"
              fill="none"
              opacity="0.35"
            />
            <circle cx="20" cy="8" r="3" fill="#10b981" />
          </svg>
          <div>
            <span className="font-medium">Empty branch</span>
            <p className="text-muted-foreground mt-0.5">
              A branch with no unique commits — its tip is already on main.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0">
            <line x1="14" y1="0" x2="14" y2="10" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" />
            <line
              x1="10"
              y1="13"
              x2="18"
              y2="13"
              stroke="#e2e2e2"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity="0.25"
            />
            <line
              x1="10"
              y1="16"
              x2="18"
              y2="16"
              stroke="#e2e2e2"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity="0.25"
            />
            <line x1="14" y1="19" x2="14" y2="28" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" />
          </svg>
          <div>
            <span className="font-medium">Collapsed commits</span>
            <p className="text-muted-foreground mt-0.5">
              Multiple commits hidden in collapsed view. Hover to see the count.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <div className="shrink-0 w-[28px] flex items-center justify-center h-[28px]">
            <span
              className="px-1.5 py-0 rounded text-[9px] font-medium"
              style={{ backgroundColor: '#a78bfa20', color: '#a78bfa' }}
            >
              main
            </span>
          </div>
          <div>
            <span className="font-medium">Branch label</span>
            <p className="text-muted-foreground mt-0.5">A branch ref pointing at this commit.</p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
