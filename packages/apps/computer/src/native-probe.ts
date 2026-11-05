import { spawnNodePty } from './node-pty'

/** Exercise the native terminal's input, output and exit paths before promotion. */
export async function probeNativeTerminal(
  trace: (stage: string) => void = () => undefined
): Promise<void> {
  const ready = 'slayzone-native-probe-ready'
  await new Promise<void>((resolve, reject) => {
    // ConPTY attaches its data pipe asynchronously. An immediately exiting,
    // silent child can finish before the exit listener is attached to that pipe.
    // Keep it alive until data delivery proves the pipe is connected.
    trace('spawning terminal')
    const child = spawnNodePty(
      process.execPath,
      [
        '-e',
        `process.stdin.setRawMode(true);process.stdin.once('data',()=>process.exit(0));process.stdout.write('${ready}')`
      ],
      { cols: 80, rows: 24, env: process.env as Record<string, string> }
    )
    trace('waiting for terminal readiness')
    let output = ''
    let acknowledged = false
    const timer = setTimeout(() => {
      trace('terminal timed out')
      try {
        child.kill()
      } catch {
        // Preserve the timeout if the process has already disappeared.
      }
      reject(new Error('native terminal probe timed out'))
    }, 10_000)
    child.onExit(({ exitCode }) => {
      trace(`terminal exited (${exitCode})`)
      clearTimeout(timer)
      if (acknowledged && exitCode === 0) resolve()
      else reject(new Error('native terminal probe failed'))
    })
    child.onData((data) => {
      if (acknowledged) return
      const pending = output + data
      if (pending.includes(ready)) {
        trace('terminal ready; sending input')
        acknowledged = true
        child.write('\r')
      } else output = pending.slice(-ready.length)
    })
  })
}
