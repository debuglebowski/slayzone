/**
 * Shown over a terminal whose computer is unreachable: its scrollback and live
 * output live there. The process may well still be running; everything it printed
 * meanwhile appears when the computer reconnects.
 */
export function TerminalComputerOffline() {
  return (
    <div
      data-testid="terminal-computer-offline"
      className="absolute inset-0 flex flex-col items-center justify-center bg-background/90 dark:bg-surface-0/90 z-10 p-6 gap-2 text-center"
    >
      <p className="text-sm font-medium text-foreground">Computer offline</p>
      <p className="text-sm text-muted-foreground max-w-md">
        This terminal runs on a computer that isn't connected right now. Its output will appear when
        it reconnects.
      </p>
    </div>
  )
}
