import type { Command } from 'commander'
import { writeFileSync, readFileSync, openSync, fsyncSync, closeSync } from 'node:fs'

type Request = <T>(
  method: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>
) => Promise<T>
interface Report {
  id: string
  state: 'incomplete' | 'complete'
  counts: { projects: number; tasks: number; artifacts: number; versions: number }
  computers: Array<{ name: string; deleted: boolean }>
  failures: string[]
}
export function registerHubErasureCommands(users: Command, request: Request): void {
  async function userId(email: string) {
    const list = await request<Array<{ id: string; email: string }>>('GET')
    const user = list.find((u) => u.email.toLowerCase() === email.trim().toLowerCase())
    if (!user) throw new Error('User not found on the selected hub.')
    return user.id
  }
  function show(report: Report, json?: boolean) {
    if (json) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(
        `${report.state === 'complete' ? 'SlayZone content erased.' : 'Some data has not been deleted yet.'} Operation: ${report.id}`
      )
      for (const computer of report.computers.filter((c) => !c.deleted))
        console.log(`Data on ${computer.name} has not been deleted yet.`)
      if (report.failures.length) console.log(`Cleanup failures: ${report.failures.join(', ')}`)
    }
    if (report.state !== 'complete') process.exitCode = 2
  }
  users
    .command('erase-content <email>')
    .description('Preview permanent erasure of a disabled user’s content; --confirm performs it')
    .option('--confirm <email>', 'Confirm the selected email and permanently erase its content')
    .option('--json', 'Output JSON')
    .action(async (email: string, opts: { confirm?: string; json?: boolean }) => {
      const id = await userId(email)
      if (opts.confirm === undefined) {
        const preview = await request<{ counts: Report['counts'] }>('GET', undefined, {
          erasure: 'preview',
          userId: id
        })
        console.log(JSON.stringify(preview, null, 2))
        if (!opts.json)
          console.log('Preview only. To erase permanently, repeat with --confirm <selected email>.')
        return
      }
      if (opts.confirm.trim().toLowerCase() !== email.trim().toLowerCase())
        throw new Error('--confirm must match the selected email.')
      show(
        await request<Report>('PATCH', {
          action: 'erase-content',
          userId: id,
          confirmation: opts.confirm
        }),
        opts.json
      )
    })
  users
    .command('erasure-status <email>')
    .description('Show erasure progress and remaining computer copies')
    .option('--json', 'Output JSON')
    .action(async (email: string, opts: { json?: boolean }) => {
      const reports = await request<Report[]>('GET', undefined, {
        erasure: 'reports',
        userId: await userId(email)
      })
      if (opts.json) {
        console.log(JSON.stringify(reports, null, 2))
        if (reports.some((report) => report.state === 'incomplete')) process.exitCode = 2
        return
      }
      if (!reports.length) console.log('No erasure operations recorded.')
      for (const report of reports) show(report, opts.json)
    })
  users
    .command('retry-erasure <job-id>')
    .description('Resume an already-confirmed erasure')
    .option('--json', 'Output JSON')
    .action(async (jobId: string, opts: { json?: boolean }) =>
      show(await request<Report>('PATCH', { action: 'retry-erasure', jobId }), opts.json)
    )
  users
    .command('erasure-receipt <job-id>')
    .description('Save non-content erasure evidence outside the hub backup')
    .requiredOption('--output <path>', 'Create a new receipt file')
    .action(async (jobId: string, opts: { output: string }) => {
      const receipt = await request<unknown>('GET', undefined, { erasure: 'receipt', jobId })
      save(opts.output, receipt)
      console.log(`Saved erasure receipt: ${opts.output}`)
    })
  users
    .command('computer-erasure-request <job-id> <computer-id>')
    .description('Create an offline cleanup request containing identifiers only')
    .requiredOption(
      '--computer-hub-url <url>',
      'The exact URL this computer used, ending in /computers'
    )
    .requiredOption('--output <path>', 'Create a new request file')
    .action(
      async (
        jobId: string,
        computerId: string,
        opts: { computerHubUrl: string; output: string }
      ) => {
        const data = await request<unknown>('PATCH', {
          action: 'computer-erasure-request',
          jobId,
          computerId,
          hubUrl: opts.computerHubUrl
        })
        save(opts.output, data)
        console.log(`Saved offline cleanup request: ${opts.output}`)
      }
    )
  users
    .command('confirm-computer-erasure <receipt-file>')
    .description('Record operator verification from an offline computer cleanup receipt')
    .option('--json', 'Output JSON')
    .action(async (file: string, opts: { json?: boolean }) => {
      const receipt = JSON.parse(readFileSync(file, 'utf8')) as unknown
      show(
        await request<Report>('PATCH', { action: 'confirm-computer-erasure', receipt }),
        opts.json
      )
    })
}

function save(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
