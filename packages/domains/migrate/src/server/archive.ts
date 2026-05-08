import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { create as tarCreate, extract as tarExtract } from 'tar'
import {
  MIGRATE_PROTOCOL_VERSION,
  type Manifest,
  type ManifestFileEntry,
} from '../shared'

interface PackOptions {
  /** Absolute path of the cleanly-snapshotted SQLite DB (already VACUUM INTO'd). */
  dbSnapshotPath: string
  /** Source data root; we walk artifacts/ + project-icons/ + .secret under it. */
  dataRoot: string
  /** Where to write the tar archive. */
  outArchivePath: string
  /** Where to write manifest.json (same parent dir as archive, written into the tar). */
  outManifestPath: string
  /** Hostname / version for manifest.source. */
  hostname: string
  slayzoneVersion: string
  /** Pre-computed table row counts. */
  tables: Record<string, number>
  /** schema user_version of the source DB. */
  schemaUserVersion: number
}

interface PackResult {
  manifest: Manifest
  archiveSha256: string
  archiveBytes: number
}

const ARTIFACTS_DIR = 'artifacts'
const PROJECT_ICONS_DIR = 'project-icons'
const SECRET_FILE = '.secret'

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path)
  return createHash('sha256').update(data).digest('hex')
}

function listFilesRecursive(root: string, prefix: string, out: ManifestFileEntry[] = []): ManifestFileEntry[] {
  if (!existsSync(root)) return out
  const entries = readdirSync(root, { withFileTypes: true })
  for (const ent of entries) {
    const abs = join(root, ent.name)
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      listFilesRecursive(abs, rel, out)
    } else if (ent.isFile()) {
      const stat = statSync(abs)
      out.push({ path: rel, sha256: '', bytes: stat.size })
    }
  }
  return out
}

export async function packArchive(opts: PackOptions): Promise<PackResult> {
  // Build file list w/ sha256 for everything we'll add.
  const files: ManifestFileEntry[] = []

  // db.sqlite — at the top
  const dbStat = statSync(opts.dbSnapshotPath)
  files.push({
    path: 'db.sqlite',
    sha256: await sha256File(opts.dbSnapshotPath),
    bytes: dbStat.size,
  })

  // artifacts/
  const artifactsRoot = join(opts.dataRoot, ARTIFACTS_DIR)
  for (const entry of listFilesRecursive(artifactsRoot, ARTIFACTS_DIR)) {
    const abs = join(opts.dataRoot, entry.path)
    entry.sha256 = await sha256File(abs)
    files.push(entry)
  }

  // project-icons/
  const iconsRoot = join(opts.dataRoot, PROJECT_ICONS_DIR)
  for (const entry of listFilesRecursive(iconsRoot, PROJECT_ICONS_DIR)) {
    const abs = join(opts.dataRoot, entry.path)
    entry.sha256 = await sha256File(abs)
    files.push(entry)
  }

  // .secret (optional)
  const secretAbs = join(opts.dataRoot, SECRET_FILE)
  if (existsSync(secretAbs)) {
    const secretStat = statSync(secretAbs)
    files.push({
      path: SECRET_FILE,
      sha256: await sha256File(secretAbs),
      bytes: secretStat.size,
    })
  }

  const totalContentBytes = files.reduce((sum, f) => sum + f.bytes, 0)

  const manifest: Manifest = {
    protocolVersion: MIGRATE_PROTOCOL_VERSION,
    source: {
      hostname: opts.hostname,
      slayzoneVersion: opts.slayzoneVersion,
      schemaUserVersion: opts.schemaUserVersion,
      exportedAt: new Date().toISOString(),
    },
    tables: opts.tables,
    files,
    totalContentBytes,
  }

  await writeFile(opts.outManifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

  // Build a working dir for tar. We need consistent relative paths inside the tar:
  //   manifest.json
  //   db.sqlite
  //   artifacts/...
  //   project-icons/...
  //   .secret (if present)
  //
  // Strategy: pass an explicit list of file entries via tar.create's `file` arg,
  // with `cwd` per-file via a working-dir pivot.
  //
  // tar lib supports a single cwd; for files spread across two roots (snapshot + dataRoot),
  // we build an intermediate staging dir (symlinks would be simpler but we want
  // portability). Simpler: we ALWAYS create the archive from a staging dir.
  //
  // But staging dir = duplicate disk usage. For migrations of GBs that's expensive.
  // Alternative: use tar.create twice (once per cwd) and concatenate? Tar archives
  // can be concatenated only if they share format. tar v7 supports it but it's fragile.
  //
  // Pragmatic choice: build the tar in two passes via tar's `Pack` Writable stream.
  // This avoids staging.
  await packMultiRoot({
    outPath: opts.outArchivePath,
    entries: [
      { cwd: opts.dataRoot, files: [manifest], rootDir: opts.dataRoot, arcname: 'manifest.json', source: opts.outManifestPath },
      { cwd: opts.dbSnapshotPath, single: true, arcname: 'db.sqlite' },
      { cwd: opts.dataRoot, glob: ARTIFACTS_DIR, optional: true },
      { cwd: opts.dataRoot, glob: PROJECT_ICONS_DIR, optional: true },
      { cwd: opts.dataRoot, glob: SECRET_FILE, optional: true },
    ],
  })

  const archiveBytes = statSync(opts.outArchivePath).size
  const archiveSha256 = await sha256File(opts.outArchivePath)
  return { manifest, archiveSha256, archiveBytes }
}

interface MultiEntry {
  cwd: string
  files?: unknown[]
  rootDir?: string
  arcname?: string
  source?: string
  single?: boolean
  glob?: string
  optional?: boolean
}

async function packMultiRoot(opts: { outPath: string; entries: MultiEntry[] }): Promise<void> {
  // Single-pass tar creation supporting heterogeneous sources is non-trivial.
  // Simpler path: stage everything into a tmp dir via hard links (cheap),
  // then tar that single dir. Hard links don't duplicate disk usage.
  const stagingDir = `${opts.outPath}.staging`
  if (existsSync(stagingDir)) {
    const { rmSync } = await import('node:fs')
    rmSync(stagingDir, { recursive: true, force: true })
  }
  mkdirSync(stagingDir, { recursive: true })

  const fs = await import('node:fs/promises')

  for (const entry of opts.entries) {
    if (entry.single && entry.arcname) {
      // entry.cwd is the file path itself
      await fs.link(entry.cwd, join(stagingDir, entry.arcname)).catch(async () => {
        // cross-device link fallback
        await fs.copyFile(entry.cwd, join(stagingDir, entry.arcname!))
      })
      continue
    }
    if (entry.source && entry.arcname) {
      // Already-written file at entry.source; link into staging
      await fs.link(entry.source, join(stagingDir, entry.arcname)).catch(async () => {
        await fs.copyFile(entry.source!, join(stagingDir, entry.arcname!))
      })
      continue
    }
    if (entry.glob) {
      const src = join(entry.cwd, entry.glob)
      if (!existsSync(src)) {
        if (entry.optional) continue
        throw new Error(`Missing required path: ${src}`)
      }
      await linkTreeOrFile(src, join(stagingDir, entry.glob))
      continue
    }
  }

  await tarCreate({ file: opts.outPath, cwd: stagingDir, portable: true }, await listStagingTopLevel(stagingDir))

  const { rmSync } = await import('node:fs')
  rmSync(stagingDir, { recursive: true, force: true })
}

async function linkTreeOrFile(src: string, dest: string): Promise<void> {
  const fs = await import('node:fs/promises')
  const stat = await fs.stat(src)
  if (stat.isFile()) {
    const parentDir = dest.slice(0, dest.lastIndexOf('/'))
    if (parentDir) mkdirSync(parentDir, { recursive: true })
    try {
      await fs.link(src, dest)
    } catch {
      await fs.copyFile(src, dest)
    }
    return
  }
  if (!stat.isDirectory()) return
  mkdirSync(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const ent of entries) {
    await linkTreeOrFile(join(src, ent.name), join(dest, ent.name))
  }
}

async function listStagingTopLevel(stagingDir: string): Promise<string[]> {
  const fs = await import('node:fs/promises')
  const entries = await fs.readdir(stagingDir, { withFileTypes: true })
  return entries.map((e) => e.name)
}

export async function unpackArchive(archivePath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  await tarExtract({ file: archivePath, cwd: destDir })
}

export async function readManifest(unpackedDir: string): Promise<Manifest> {
  const path = join(unpackedDir, 'manifest.json')
  if (!existsSync(path)) throw new Error('Archive missing manifest.json')
  const text = await readFile(path, 'utf-8')
  return JSON.parse(text) as Manifest
}

export interface ManifestVerifyResult {
  ok: boolean
  mismatched: string[]
  missing: string[]
  extra: string[]
}

export async function verifyManifestAgainstUnpacked(
  unpackedDir: string,
  manifest: Manifest,
): Promise<ManifestVerifyResult> {
  const mismatched: string[] = []
  const missing: string[] = []

  // Verify each declared file exists w/ matching sha + size.
  for (const entry of manifest.files) {
    const abs = join(unpackedDir, entry.path)
    if (!existsSync(abs)) {
      missing.push(entry.path)
      continue
    }
    const stat = statSync(abs)
    if (stat.size !== entry.bytes) {
      mismatched.push(entry.path)
      continue
    }
    const sha = await sha256File(abs)
    if (sha !== entry.sha256) mismatched.push(entry.path)
  }

  // Check for files in unpacked tree not declared in manifest (other than manifest.json + db.sqlite).
  const declared = new Set(manifest.files.map((f) => f.path))
  declared.add('manifest.json')
  const extra: string[] = []
  walkAndCheck(unpackedDir, unpackedDir, declared, extra)

  return {
    ok: mismatched.length === 0 && missing.length === 0 && extra.length === 0,
    mismatched,
    missing,
    extra,
  }
}

function walkAndCheck(root: string, current: string, declared: Set<string>, extra: string[]): void {
  if (!existsSync(current)) return
  const entries = readdirSync(current, { withFileTypes: true })
  for (const ent of entries) {
    const abs = join(current, ent.name)
    const rel = relative(root, abs).split('\\').join('/')
    if (ent.isDirectory()) {
      walkAndCheck(root, abs, declared, extra)
    } else if (ent.isFile()) {
      if (!declared.has(rel)) extra.push(rel)
    }
  }
}
