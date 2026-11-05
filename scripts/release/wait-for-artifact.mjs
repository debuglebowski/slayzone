#!/usr/bin/env node

// Waits until a job in the SAME workflow run has uploaded an artifact, so a job can do its
// own setup while that job is still running and only then download its output — `needs:`
// would hold the whole job back until the producer finished.
//
// Exits 0 once the artifact is listed; 1 if the producing job ended without it (failed,
// cancelled, or succeeded with nothing uploaded) or the timeout passes.
//
// Usage: wait-for-artifact.mjs --artifact <name> --job <job name suffix> [--timeout-minutes <n>]
// Env:   GH_TOKEN (actions: read), GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i]
    if (!current.startsWith('--')) continue
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${current}`)
    args[current.slice(2)] = value
    i += 1
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.artifact || !args.job) {
  throw new Error(
    'Usage: wait-for-artifact.mjs --artifact <name> --job <job name suffix> [--timeout-minutes <n>]'
  )
}
const timeoutMs = Number(args['timeout-minutes'] ?? 30) * 60_000
const POLL_MS = 10_000

const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env
const api = process.env.GITHUB_API_URL ?? 'https://api.github.com'
if (!GH_TOKEN || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) {
  throw new Error('GH_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID must be set')
}
const run = `${api}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`

async function get(url) {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28'
    }
  })
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${await res.text()}`)
  return res.json()
}

const artifactListed = async () =>
  (await get(`${run}/artifacts?name=${encodeURIComponent(args.artifact)}`)).artifacts.some(
    (a) => !a.expired
  )

// A called workflow prefixes job names with the caller's job ("release / Build JS"), so
// match the suffix. filter=latest: on a re-run, the newest attempt of each job.
async function producer() {
  const { jobs } = await get(`${run}/jobs?filter=latest&per_page=100`)
  return jobs.find((j) => j.name === args.job || j.name.endsWith(` / ${args.job}`))
}

const deadline = Date.now() + timeoutMs
for (;;) {
  // Transient API errors must not fail a release build: log and poll again.
  const state = await Promise.all([artifactListed(), producer()]).catch((err) => {
    console.log(`::warning::polling failed, retrying: ${err.message}`)
    return null
  })
  if (state) {
    const [listed, job] = state
    if (listed) {
      console.log(`artifact ${args.artifact} is ready`)
      process.exit(0)
    }
    if (job?.status === 'completed') {
      // Listed artifacts can trail the job's completion by a moment; one more look.
      if (job.conclusion === 'success' && (await artifactListed().catch(() => false))) {
        console.log(`artifact ${args.artifact} is ready`)
        process.exit(0)
      }
      console.error(
        `::error::job "${job.name}" ended (${job.conclusion}) without artifact ${args.artifact}`
      )
      process.exit(1)
    }
    console.log(`waiting for ${args.artifact} (job "${args.job}": ${job?.status ?? 'not found'})`)
  }
  if (Date.now() > deadline) {
    console.error(
      `::error::timed out after ${args['timeout-minutes'] ?? 30} min waiting for ${args.artifact}`
    )
    process.exit(1)
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS))
}
