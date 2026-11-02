import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
/** Invoke npm's JS entrypoint: execFile cannot execute Windows npm.cmd. */
export function npmCommand(
  env = process.env,
  executable = process.execPath
): { command: string; args: string[] } {
  const candidates = [
    join(dirname(executable), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(executable), '../lib/node_modules/npm/bin/npm-cli.js')
  ]
  const pathCandidates: string[] = []
  for (const dir of (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    pathCandidates.push(
      join(dir, 'node_modules/npm/bin/npm-cli.js'),
      join(dir, '../lib/node_modules/npm/bin/npm-cli.js')
    )
    const script = join(dir, 'npm')
    try {
      // Unix npm is normally a symlink to npm-cli.js; run it with the selected runtime.
      if (readFileSync(script, 'utf8').startsWith('#!/usr/bin/env node'))
        pathCandidates.push(script)
    } catch {
      /* Missing executable. */
    }
  }
  try {
    candidates.push(createRequire(executable).resolve('npm/bin/npm-cli.js'))
  } catch {
    /* npm may be outside Node's prefix. */
  }
  const cli = [...pathCandidates, ...candidates].find(existsSync)
  if (!cli) throw new Error('npm CLI was not found; install npm alongside Node')
  return { command: executable, args: [cli] }
}
