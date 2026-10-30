/**
 * Regenerates the committed Codex app-server protocol SURFACE
 * (`test-utils/fake-codex/protocol-surface.json`) from the CLI's own
 * machine-generated JSON Schema. The surface is what the drift check
 * (codex-protocol-drift.test.ts) compares the driver against: every method the
 * server can send, the answers each server request accepts, the client requests
 * and their required params, the thread item types and the status enums the
 * driver branches on. The full schema (~5 MB) stays out of the repo.
 *
 * Run after a CLI update (no network, no account):
 *   SLAYZONE_CODEX_BIN_PATH=<codex> npx tsx packages/domains/terminal/src/server/agents/codex/codex-protocol-surface.gen.ts
 * then run the drift check: a new method fails it until the driver handles it or
 * it is listed with a reason.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { CODEX_PROTOCOL_SURFACE_PATH } from '@slayzone/test-utils/fake-codex'

type Json = Record<string, unknown>

const CODEX_BIN = process.env.SLAYZONE_CODEX_BIN_PATH || 'codex'
const run = promisify(execFile)

/**
 * Enums the driver branches on (`codex-chat-session.ts`), by schema definition
 * name. Not `ReasoningEffort`: since 0.15x it is any non-empty string a model
 * advertises (`model/list`), no longer an enum.
 */
const ENUMS = [
  'TurnStatus',
  'CommandExecutionStatus',
  'PatchApplyStatus',
  'McpToolCallStatus',
  'DynamicToolCallStatus',
  'AskForApproval',
  'SandboxMode',
  'ModeKind'
]

function methodOf(variant: Json): string {
  const m = (variant.properties as Json | undefined)?.method as { enum?: string[] } | undefined
  if (!m?.enum?.[0])
    throw new Error(`variant without a method: ${JSON.stringify(variant).slice(0, 200)}`)
  return m.enum[0]
}

function refName(schema: unknown): string | null {
  const ref = (schema as { $ref?: string } | undefined)?.$ref
  return ref ? ref.split('/').at(-1)! : null
}

function variants(schema: Json): Json[] {
  return ((schema.oneOf ?? schema.anyOf ?? []) as Json[]).filter(Boolean)
}

/** String values and object-variant keys of one schema (refs resolved in `defs`). */
function enumValues(
  schema: unknown,
  defs: Record<string, Json>,
  seen = new Set<string>()
): string[] {
  if (!schema || typeof schema !== 'object') return []
  const s = schema as Json
  const name = refName(s)
  if (name) {
    if (seen.has(name)) return []
    seen.add(name)
    return enumValues(defs[name], defs, seen)
  }
  const out: string[] = []
  if (Array.isArray(s.enum)) out.push(...(s.enum as string[]).map(String))
  if (typeof s.const === 'string') out.push(s.const)
  for (const v of variants(s)) {
    const props = v.properties as Json | undefined
    if (!v.enum && !v.const && !refName(v) && props && Array.isArray(v.required)) {
      // `{ acceptWithExecpolicyAmendment: {…} }`-style variant.
      for (const key of v.required as string[]) out.push(`{${key}}`)
    } else out.push(...enumValues(v, defs, seen))
  }
  return [...new Set(out)]
}

async function main(): Promise<void> {
  const version = (await run(CODEX_BIN, ['--version'], { encoding: 'utf8' })).stdout
    .trim()
    .split(' ')
    .at(-1)!
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-codex-schema-'))
  await run(CODEX_BIN, ['app-server', 'generate-json-schema', '--experimental', '--out', dir])
  const read = (f: string): Json => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Json
  const bundle = read('codex_app_server_protocol.v2.schemas.json')
  const defs = bundle.definitions as Record<string, Json>

  const serverNotifications: Record<string, string | null> = {}
  for (const v of variants(read('ServerNotification.json'))) {
    serverNotifications[methodOf(v)] = refName((v.properties as Json).params)
  }

  const serverRequests: Record<string, { params: string | null; decisions: string[] }> = {}
  const sr = read('ServerRequest.json')
  for (const v of variants(sr)) {
    const params = refName((v.properties as Json).params)
    const responseFile = params ? `${params.replace(/Params$/, 'Response')}.json` : null
    let decisions: string[] = []
    if (responseFile && fs.existsSync(path.join(dir, responseFile))) {
      const resp = read(responseFile)
      const decision = (resp.properties as Json | undefined)?.decision
      if (decision)
        decisions = enumValues(decision, (resp.definitions ?? {}) as Record<string, Json>)
    }
    serverRequests[methodOf(v)] = { params, decisions: decisions.sort() }
  }

  const clientRequests: Record<
    string,
    { params: string | null; required: string[]; properties: string[] }
  > = {}
  const cr = read('ClientRequest.json')
  const crDefs = (cr.definitions ?? {}) as Record<string, Json>
  for (const v of variants(cr)) {
    const params = refName((v.properties as Json).params)
    const def = params ? (crDefs[params] ?? defs[params]) : undefined
    clientRequests[methodOf(v)] = {
      params,
      required: [...(((def?.required as string[] | undefined) ?? []) as string[])].sort(),
      properties: Object.keys((def?.properties as Json | undefined) ?? {}).sort()
    }
  }

  const threadItemTypes = variants(defs.ThreadItem).map(
    (v) => ((v.properties as Json).type as { enum: string[] }).enum[0]
  )

  const enums: Record<string, string[]> = {}
  for (const name of ENUMS) {
    if (!defs[name]) throw new Error(`schema has no definition ${name}`)
    enums[name] = enumValues(defs[name], defs).sort()
  }

  const surface = {
    cliVersion: version,
    generatedBy:
      'packages/domains/terminal/src/server/agents/codex/codex-protocol-surface.gen.ts (codex app-server generate-json-schema --experimental)',
    serverNotifications: sortKeys(serverNotifications),
    serverRequests: sortKeys(serverRequests),
    clientRequests: sortKeys(clientRequests),
    threadItemTypes: [...threadItemTypes].sort(),
    enums
  }
  fs.writeFileSync(CODEX_PROTOCOL_SURFACE_PATH, `${JSON.stringify(surface, null, 2)}\n`)
  // The repo's formatter has the last word, so a regeneration diffs only in content.
  await run('pnpm', ['exec', 'biome', 'format', '--write', CODEX_PROTOCOL_SURFACE_PATH])
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(
    `codex ${version}: ${Object.keys(serverNotifications).length} notifications, ` +
      `${Object.keys(serverRequests).length} server requests, ${Object.keys(clientRequests).length} ` +
      `client requests, ${threadItemTypes.length} item types → ${CODEX_PROTOCOL_SURFACE_PATH}`
  )
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
