export interface FixtureProcess {
  pid: number
  ppid: number
  args: string
}
export declare const WATCHDOG_PATH: string
export declare const WATCHDOG_SCRIPT: string
export declare function listProcesses(): FixtureProcess[]
export declare function dirForms(dir: string): string[]
export declare function fixtureProcesses(
  dirs: string | string[],
  opts?: { procs?: FixtureProcess[] }
): FixtureProcess[]
export declare function killFixtureProcesses(
  dirs: string | string[],
  opts?: { rounds?: number }
): FixtureProcess[]
