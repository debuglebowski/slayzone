export function TerminalBanner(): React.JSX.Element {
  return (
    <div className="flex-1 p-4 font-mono flex flex-col gap-0">
      <div className="mb-2">
        <div className="flex items-start gap-3">
          <pre className="text-[12px] leading-[14px] text-[#e4845b] shrink-0 select-none">
            {' ▐▛███▜▌\n▝▜█████▛▘\n  ▘▘ ▝▝'}
          </pre>
          <div className="flex flex-col pt-[2px]">
            <span className="text-[16px] text-white font-bold">
              Claude Code <span className="text-neutral-500 font-normal">v2.1.56</span>
            </span>
            <span className="text-[14px] text-neutral-500">Opus 4.6 · Claude Team</span>
            <span className="text-[14px] text-neutral-500">~/dev/projects/slayzone</span>
          </div>
        </div>
      </div>
      <div className="h-[2px] bg-neutral-700 my-2" />
      <div className="flex items-center">
        <span className="text-[18px] text-neutral-500 mr-2">❯</span>
        <span className="text-[16px] text-neutral-600 italic">
          Try &quot;edit TaskDetailPage.tsx to...&quot;
        </span>
      </div>
      <div className="h-[2px] bg-neutral-700 my-2" />
      <span className="text-[14px] text-neutral-600"> ? for shortcuts</span>
    </div>
  )
}
