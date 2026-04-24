import { Command } from 'commander'
import archiver from 'archiver'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { openDb, notifyApp, postJson, getAssetsDir, getDataDir, getMcpPort, type SlayDb } from '../../db'
import {
  BlobStore,
  createVersion,
  saveCurrent,
  mutateVersion,
  setCurrentVersion,
  getCurrentVersion,
  listVersions,
  resolveVersionRef,
  readVersionContent,
  renameVersion,
  diffVersions,
  pruneVersions,
  nodeSqliteTxn,
  isVersionError,
} from '@slayzone/task-assets/main'
import {
  getExtensionFromTitle,
  getEffectiveRenderMode,
  isBinaryRenderMode,
  canExportAsPdf,
  canExportAsPng,
  canExportAsHtml,
  type RenderMode,
} from '@slayzone/task/shared/types'
import { apiPost } from '../../api'
import { cliAuthor } from './_shared'

interface AssetRow extends Record<string, unknown> {
  id: string
  task_id: string
  folder_id: string | null
  title: string
  render_mode: string | null
  language: string | null
  order: number
  created_at: string
  updated_at: string
}

interface AssetFolderRow extends Record<string, unknown> {
  id: string
  task_id: string
  parent_id: string | null
  name: string
  order: number
  created_at: string
}

function resolveAsset(db: SlayDb, prefix: string): AssetRow {
  const rows = db.query<AssetRow>(
    `SELECT * FROM task_assets WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': prefix }
  )
  if (rows.length === 0) {
    console.error(`Asset not found: "${prefix}"`)
    process.exit(1)
  }
  if (rows.length > 1) {
    console.error(`Ambiguous asset id "${prefix}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }
  return rows[0]
}

function resolveTaskForAsset(db: SlayDb, taskOpt?: string): { id: string; title: string } {
  const ref = taskOpt ?? process.env.SLAYZONE_TASK_ID
  if (!ref) {
    console.error('No task ID provided and $SLAYZONE_TASK_ID is not set.')
    process.exit(1)
  }
  const rows = db.query<{ id: string; title: string }>(
    `SELECT id, title FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': ref }
  )
  if (rows.length === 0) {
    console.error(`Task not found: "${ref}"`)
    process.exit(1)
  }
  if (rows.length > 1) {
    console.error(`Ambiguous task id "${ref}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }
  return rows[0]
}

function resolveFolder(db: SlayDb, prefix: string): AssetFolderRow {
  const rows = db.query<AssetFolderRow>(
    `SELECT * FROM asset_folders WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': prefix }
  )
  if (rows.length === 0) {
    console.error(`Folder not found: "${prefix}"`)
    process.exit(1)
  }
  if (rows.length > 1) {
    console.error(`Ambiguous folder id "${prefix}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }
  return rows[0]
}

function assetFilePath(assetsDir: string, taskId: string, assetId: string, title: string): string {
  const ext = getExtensionFromTitle(title) || '.txt'
  return path.join(assetsDir, taskId, `${assetId}${ext}`)
}

function printAssets(assets: AssetRow[], folders?: AssetFolderRow[]) {
  if (assets.length === 0) {
    console.log('No assets.')
    return
  }
  const folderMap = new Map((folders ?? []).map(f => [f.id, f.name]))
  const idW = 9
  const titleW = 24
  const modeW = 16
  const folderW = 14
  console.log(`${'ID'.padEnd(idW)}  ${'TITLE'.padEnd(titleW)}  ${'FOLDER'.padEnd(folderW)}  ${'MODE'.padEnd(modeW)}  CREATED`)
  console.log(`${'-'.repeat(idW)}  ${'-'.repeat(titleW)}  ${'-'.repeat(folderW)}  ${'-'.repeat(modeW)}  ${'-'.repeat(20)}`)
  for (const a of assets) {
    const id = a.id.slice(0, 8).padEnd(idW)
    const title = a.title.slice(0, titleW).padEnd(titleW)
    const folder = (a.folder_id ? (folderMap.get(a.folder_id) ?? '?') : '').slice(0, folderW).padEnd(folderW)
    const mode = getEffectiveRenderMode(a.title, a.render_mode as RenderMode | null).padEnd(modeW)
    const created = a.created_at.slice(0, 19)
    console.log(`${id}  ${title}  ${folder}  ${mode}  ${created}`)
  }
}

function printAssetTree(assets: AssetRow[], folders: AssetFolderRow[]) {
  if (assets.length === 0 && folders.length === 0) {
    console.log('No assets.')
    return
  }
  // Build folder path map
  const byId = new Map(folders.map(f => [f.id, f]))
  function folderPath(id: string): string {
    const f = byId.get(id)
    if (!f) return '?'
    return f.parent_id ? `${folderPath(f.parent_id)}/${f.name}` : f.name
  }

  // Group: parentId -> children
  const childFolders = new Map<string | null, AssetFolderRow[]>()
  for (const f of folders) {
    const arr = childFolders.get(f.parent_id) ?? []
    arr.push(f)
    childFolders.set(f.parent_id, arr)
  }
  const assetsByFolder = new Map<string | null, AssetRow[]>()
  for (const a of assets) {
    const arr = assetsByFolder.get(a.folder_id) ?? []
    arr.push(a)
    assetsByFolder.set(a.folder_id, arr)
  }

  function printLevel(parentId: string | null, indent: string) {
    const subFolders = childFolders.get(parentId) ?? []
    for (const f of subFolders) {
      console.log(`${indent}${f.name}/  (${f.id.slice(0, 8)})`)
      printLevel(f.id, indent + '  ')
    }
    const subAssets = assetsByFolder.get(parentId) ?? []
    for (const a of subAssets) {
      console.log(`${indent}${a.title}  (${a.id.slice(0, 8)})`)
    }
  }

  printLevel(null, '')
}

async function readStdin(): Promise<Buffer> {
  if (process.stdin.isTTY) {
    console.error('No content provided. Pipe content via stdin.')
    process.exit(1)
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function getAvailableExportTypes(mode: RenderMode): string[] {
  const types = ['raw']
  if (canExportAsPdf(mode)) types.push('pdf')
  if (canExportAsPng(mode)) types.push('png')
  if (canExportAsHtml(mode)) types.push('html')
  return types
}

export function assetsSubcommand(): Command {
  const cmd = new Command('assets')
    .description('Manage task assets')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // slay tasks assets list <taskId>
  cmd
    .command('list <taskId>')
    .description('List assets for a task')
    .option('--json', 'Output as JSON')
    .option('--tree', 'Show as indented tree')
    .action(async (taskId: string, opts) => {
      const db = openDb()
      const task = resolveTaskForAsset(db, taskId)
      const rows = db.query<AssetRow>(
        `SELECT * FROM task_assets WHERE task_id = :taskId ORDER BY "order" ASC, created_at ASC`,
        { ':taskId': task.id }
      )
      const folderRows = db.query<AssetFolderRow>(
        `SELECT * FROM asset_folders WHERE task_id = :taskId ORDER BY "order" ASC, created_at ASC`,
        { ':taskId': task.id }
      )
      db.close()
      if (opts.json) {
        console.log(JSON.stringify({ folders: folderRows, assets: rows }, null, 2))
      } else if (opts.tree) {
        printAssetTree(rows, folderRows)
      } else {
        printAssets(rows, folderRows)
      }
    })

  // slay tasks assets read <assetId>
  cmd
    .command('read <assetId>')
    .description('Output asset content to stdout')
    .action(async (assetId: string) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      db.close()
      const dir = getAssetsDir()
      const fp = assetFilePath(dir, asset.task_id, asset.id, asset.title)
      if (!fs.existsSync(fp)) return
      const mode = getEffectiveRenderMode(asset.title, asset.render_mode as RenderMode | null)
      if (isBinaryRenderMode(mode)) {
        process.stdout.write(fs.readFileSync(fp))
      } else {
        process.stdout.write(fs.readFileSync(fp, 'utf-8'))
      }
    })

  // slay tasks assets create <title>
  cmd
    .command('create <title>')
    .description('Create a new asset')
    .option('--task <id>', 'Task ID (or $SLAYZONE_TASK_ID)')
    .option('--folder <id>', 'Folder ID to create asset in')
    .option('--copy-from <path>', 'Copy content from file')
    .option('--render-mode <mode>', 'Override render mode')
    .option('--json', 'Output as JSON')
    .action(async (title: string, opts) => {
      const db = openDb()
      const task = resolveTaskForAsset(db, opts.task)
      const folderId = opts.folder ? resolveFolder(db, opts.folder).id : null
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const maxOrder = db.query<{ m: number | null }>(
        folderId
          ? `SELECT MAX("order") as m FROM task_assets WHERE task_id = :taskId AND folder_id = :folderId`
          : `SELECT MAX("order") as m FROM task_assets WHERE task_id = :taskId AND folder_id IS NULL`,
        folderId ? { ':taskId': task.id, ':folderId': folderId } : { ':taskId': task.id }
      )[0]?.m ?? -1

      db.run(
        `INSERT INTO task_assets (id, task_id, folder_id, title, render_mode, "order", created_at, updated_at)
         VALUES (:id, :taskId, :folderId, :title, :renderMode, :order, :now, :now)`,
        {
          ':id': id,
          ':taskId': task.id,
          ':folderId': folderId,
          ':title': title,
          ':renderMode': opts.renderMode ?? null,
          ':order': maxOrder + 1,
          ':now': now,
        }
      )

      const dir = getAssetsDir()
      const fp = assetFilePath(dir, task.id, id, title)
      fs.mkdirSync(path.dirname(fp), { recursive: true })

      let bytes: Buffer
      if (opts.copyFrom) {
        if (!fs.existsSync(opts.copyFrom)) {
          console.error(`File not found: ${opts.copyFrom}`)
          process.exit(1)
        }
        bytes = fs.readFileSync(opts.copyFrom)
        fs.writeFileSync(fp, bytes)
      } else {
        const content = await readStdin()
        bytes = Buffer.from(content)
        fs.writeFileSync(fp, bytes)
      }

      // Create v1 version row.
      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      createVersion(raw, nodeSqliteTxn(raw), blobStore, {
        assetId: id,
        bytes,
        author: cliAuthor(),
      })

      db.close()
      await notifyApp()
      const openPort = getMcpPort()
      if (openPort) await postJson(openPort, `/api/open-asset/${id}`)

      if (opts.json) {
        console.log(JSON.stringify({ id, task_id: task.id, title, render_mode: opts.renderMode ?? null, order: maxOrder + 1, created_at: now, updated_at: now }, null, 2))
      } else {
        console.log(`Created: ${id.slice(0, 8)}  ${title}`)
      }
    })

  // slay tasks assets upload <sourcePath>
  cmd
    .command('upload <sourcePath>')
    .description('Upload a file as an asset')
    .option('--task <id>', 'Task ID (or $SLAYZONE_TASK_ID)')
    .option('--title <name>', 'Asset title (defaults to filename)')
    .option('--json', 'Output as JSON')
    .action(async (sourcePath: string, opts) => {
      if (!fs.existsSync(sourcePath)) {
        console.error(`File not found: ${sourcePath}`)
        process.exit(1)
      }
      const db = openDb()
      const task = resolveTaskForAsset(db, opts.task)
      const id = crypto.randomUUID()
      const title = opts.title ?? path.basename(sourcePath)
      const now = new Date().toISOString()
      const maxOrder = db.query<{ m: number | null }>(
        `SELECT MAX("order") as m FROM task_assets WHERE task_id = :taskId`,
        { ':taskId': task.id }
      )[0]?.m ?? -1

      db.run(
        `INSERT INTO task_assets (id, task_id, title, "order", created_at, updated_at)
         VALUES (:id, :taskId, :title, :order, :now, :now)`,
        { ':id': id, ':taskId': task.id, ':title': title, ':order': maxOrder + 1, ':now': now }
      )

      const dir = getAssetsDir()
      const fp = assetFilePath(dir, task.id, id, title)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.copyFileSync(sourcePath, fp)

      // Seed v1 version row from uploaded bytes.
      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      createVersion(raw, nodeSqliteTxn(raw), blobStore, {
        assetId: id,
        bytes: fs.readFileSync(fp),
        author: cliAuthor(),
      })

      db.close()
      await notifyApp()
      const openPort = getMcpPort()
      if (openPort) await postJson(openPort, `/api/open-asset/${id}`)

      if (opts.json) {
        console.log(JSON.stringify({ id, task_id: task.id, title, order: maxOrder + 1, created_at: now, updated_at: now }, null, 2))
      } else {
        console.log(`Uploaded: ${id.slice(0, 8)}  ${title}`)
      }
    })

  // slay tasks assets update <assetId>
  cmd
    .command('update <assetId>')
    .description('Update asset metadata')
    .option('--title <name>', 'New title')
    .option('--render-mode <mode>', 'New render mode')
    .option('--json', 'Output as JSON')
    .action(async (assetId: string, opts) => {
      if (!opts.title && !opts.renderMode) {
        console.error('Provide at least one of --title, --render-mode.')
        process.exit(1)
      }
      const db = openDb()
      const asset = resolveAsset(db, assetId)

      const sets: string[] = []
      const params: Record<string, string | number | bigint | null | Uint8Array> = { ':id': asset.id }

      if (opts.title !== undefined) {
        sets.push('title = :title')
        params[':title'] = opts.title
      }
      if (opts.renderMode !== undefined) {
        sets.push('render_mode = :renderMode')
        params[':renderMode'] = opts.renderMode
      }
      sets.push("updated_at = :now")
      params[':now'] = new Date().toISOString()

      db.run(`UPDATE task_assets SET ${sets.join(', ')} WHERE id = :id`, params)

      // Rename file on disk if extension changed
      if (opts.title) {
        const dir = getAssetsDir()
        const oldExt = getExtensionFromTitle(asset.title) || '.txt'
        const newExt = getExtensionFromTitle(opts.title) || '.txt'
        if (oldExt !== newExt) {
          const oldPath = path.join(dir, asset.task_id, `${asset.id}${oldExt}`)
          const newPath = path.join(dir, asset.task_id, `${asset.id}${newExt}`)
          if (fs.existsSync(oldPath)) {
            const content = fs.readFileSync(oldPath)
            fs.writeFileSync(newPath, content)
            fs.unlinkSync(oldPath)
          }
        }
      }

      db.close()
      await notifyApp()

      const newTitle = opts.title ?? asset.title
      if (opts.json) {
        const updated = { ...asset, title: newTitle, render_mode: opts.renderMode ?? asset.render_mode, updated_at: params[':now'] }
        console.log(JSON.stringify(updated, null, 2))
      } else {
        console.log(`Updated: ${asset.id.slice(0, 8)}  ${newTitle}`)
      }
    })

  // slay tasks assets write <assetId>
  cmd
    .command('write <assetId>')
    .description('Replace asset content from stdin')
    .option('--mutate-version [ref]', 'Bare: autosave to current (auto-branches if locked). With ref: bypass lock and mutate the target version in place')
    .action(async (assetId: string, opts: { mutateVersion?: boolean | string }) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)

      const content = await readStdin()
      const bytes = Buffer.from(content)

      const dir = getAssetsDir()
      const fp = assetFilePath(dir, asset.task_id, asset.id, asset.title)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.writeFileSync(fp, bytes)

      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      const txn = nodeSqliteTxn(raw)
      try {
        const v = typeof opts.mutateVersion === 'string'
          ? mutateVersion(raw, txn, blobStore, { assetId: asset.id, ref: opts.mutateVersion, bytes, author: cliAuthor() })
          : opts.mutateVersion === true
            ? saveCurrent(raw, txn, blobStore, { assetId: asset.id, bytes, author: cliAuthor() })
            : createVersion(raw, txn, blobStore, { assetId: asset.id, bytes, author: cliAuthor() })
        db.run(`UPDATE task_assets SET updated_at = :now WHERE id = :id`, {
          ':id': asset.id,
          ':now': new Date().toISOString(),
        })
        db.close()
        await notifyApp()
        console.log(`Written: ${asset.id.slice(0, 8)}  ${asset.title}  v${v.version_num}`)
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  // slay tasks assets append <assetId>
  cmd
    .command('append <assetId>')
    .description('Append to asset content from stdin')
    .option('--mutate-version [ref]', 'Bare: autosave to current (auto-branches if locked). With ref: bypass lock and mutate the target version in place')
    .action(async (assetId: string, opts: { mutateVersion?: boolean | string }) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)

      const content = await readStdin()

      const dir = getAssetsDir()
      const fp = assetFilePath(dir, asset.task_id, asset.id, asset.title)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.appendFileSync(fp, content)
      const fullBytes = fs.readFileSync(fp)

      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      const txn = nodeSqliteTxn(raw)
      try {
        const v = typeof opts.mutateVersion === 'string'
          ? mutateVersion(raw, txn, blobStore, { assetId: asset.id, ref: opts.mutateVersion, bytes: fullBytes, author: cliAuthor() })
          : opts.mutateVersion === true
            ? saveCurrent(raw, txn, blobStore, { assetId: asset.id, bytes: fullBytes, author: cliAuthor() })
            : createVersion(raw, txn, blobStore, { assetId: asset.id, bytes: fullBytes, author: cliAuthor() })
        db.run(`UPDATE task_assets SET updated_at = :now WHERE id = :id`, {
          ':id': asset.id,
          ':now': new Date().toISOString(),
        })
        db.close()
        await notifyApp()
        console.log(`Appended: ${asset.id.slice(0, 8)}  ${asset.title}  v${v.version_num}`)
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  // slay tasks assets delete <assetId>
  cmd
    .command('delete <assetId>')
    .description('Delete an asset')
    .action(async (assetId: string) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)

      const dir = getAssetsDir()
      const fp = assetFilePath(dir, asset.task_id, asset.id, asset.title)
      if (fs.existsSync(fp)) fs.unlinkSync(fp)

      db.run(`DELETE FROM task_assets WHERE id = :id`, { ':id': asset.id })
      db.close()
      await notifyApp()
      console.log(`Deleted: ${asset.id.slice(0, 8)}  ${asset.title}`)
    })

  // slay tasks assets path <assetId>
  cmd
    .command('path <assetId>')
    .description('Print asset file path')
    .action(async (assetId: string) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      db.close()
      const dir = getAssetsDir()
      process.stdout.write(assetFilePath(dir, asset.task_id, asset.id, asset.title))
    })

  // slay tasks assets mkdir <name>
  cmd
    .command('mkdir <name>')
    .description('Create a folder')
    .option('--task <id>', 'Task ID (or $SLAYZONE_TASK_ID)')
    .option('--parent <id>', 'Parent folder ID')
    .option('--json', 'Output as JSON')
    .action(async (name: string, opts) => {
      const db = openDb()
      const task = resolveTaskForAsset(db, opts.task)
      const parentId = opts.parent ? resolveFolder(db, opts.parent).id : null
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const maxOrder = db.query<{ m: number | null }>(
        parentId
          ? `SELECT MAX("order") as m FROM asset_folders WHERE task_id = :taskId AND parent_id = :parentId`
          : `SELECT MAX("order") as m FROM asset_folders WHERE task_id = :taskId AND parent_id IS NULL`,
        parentId ? { ':taskId': task.id, ':parentId': parentId } : { ':taskId': task.id }
      )[0]?.m ?? -1

      db.run(
        `INSERT INTO asset_folders (id, task_id, parent_id, name, "order", created_at)
         VALUES (:id, :taskId, :parentId, :name, :order, :now)`,
        { ':id': id, ':taskId': task.id, ':parentId': parentId, ':name': name, ':order': maxOrder + 1, ':now': now }
      )
      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ id, task_id: task.id, parent_id: parentId, name, order: maxOrder + 1, created_at: now }, null, 2))
      } else {
        console.log(`Created folder: ${id.slice(0, 8)}  ${name}`)
      }
    })

  // slay tasks assets rmdir <folderId>
  cmd
    .command('rmdir <folderId>')
    .description('Delete a folder (assets move to root)')
    .option('--json', 'Output as JSON')
    .action(async (folderId: string, opts) => {
      const db = openDb()
      const folder = resolveFolder(db, folderId)
      db.run(`DELETE FROM asset_folders WHERE id = :id`, { ':id': folder.id })
      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ deleted: folder.id, name: folder.name }))
      } else {
        console.log(`Deleted folder: ${folder.id.slice(0, 8)}  ${folder.name}`)
      }
    })

  // slay tasks assets mvdir <folderId>
  cmd
    .command('mvdir <folderId>')
    .description('Move a folder to another parent (or root)')
    .requiredOption('--parent <id>', 'Target parent folder ID, or "root" for top level')
    .option('--json', 'Output as JSON')
    .action(async (folderId: string, opts) => {
      const db = openDb()
      const folder = resolveFolder(db, folderId)
      let targetParentId: string | null = null
      let targetName = 'root'
      if (opts.parent !== 'root') {
        const parent = resolveFolder(db, opts.parent)
        targetParentId = parent.id
        targetName = parent.name
        // cycle check: walk ancestors of target — reject if source appears
        let cur: string | null = targetParentId
        while (cur) {
          if (cur === folder.id) {
            console.error('Cannot move folder into its own descendant')
            process.exit(1)
          }
          const row: { parent_id: string | null } | undefined = db.query<{ parent_id: string | null }>(
            `SELECT parent_id FROM asset_folders WHERE id = :id`,
            { ':id': cur }
          )[0]
          cur = row?.parent_id ?? null
        }
      }
      db.run(
        `UPDATE asset_folders SET parent_id = :parentId WHERE id = :id`,
        { ':parentId': targetParentId, ':id': folder.id }
      )
      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ id: folder.id, parent_id: targetParentId }))
      } else {
        console.log(`Moved folder: ${folder.id.slice(0, 8)} -> ${targetName}`)
      }
    })

  // slay tasks assets mv <assetId>
  cmd
    .command('mv <assetId>')
    .description('Move asset to a folder (or root)')
    .requiredOption('--folder <id>', 'Target folder ID, or "root" for top level')
    .option('--json', 'Output as JSON')
    .action(async (assetId: string, opts) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      let targetFolderId: string | null = null
      let targetName = 'root'
      if (opts.folder !== 'root') {
        const folder = resolveFolder(db, opts.folder)
        targetFolderId = folder.id
        targetName = folder.name
      }
      db.run(
        `UPDATE task_assets SET folder_id = :folderId, updated_at = :now WHERE id = :id`,
        { ':folderId': targetFolderId, ':now': new Date().toISOString(), ':id': asset.id }
      )
      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify({ id: asset.id, folder_id: targetFolderId }))
      } else {
        console.log(`Moved: ${asset.id.slice(0, 8)} -> ${targetName}`)
      }
    })

  // slay tasks assets download [assetId]
  cmd
    .command('download [assetId]')
    .description('Download an asset in a given format')
    .option('--type <type>', 'Export type: raw, pdf, png, html, zip', 'raw')
    .option('--output <path>', 'Output file path (default: ./<filename>)')
    .option('--task <id>', 'Task ID for zip (or $SLAYZONE_TASK_ID)')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Download Types by Render Mode:
  raw   — always available (copies original file)
  pdf   — markdown, code, html, svg, mermaid
  png   — svg, mermaid
  html  — markdown, code, mermaid
  zip   — all assets in task (no assetId needed)

pdf/png/html require the SlayZone app to be running.
`)
    .action(async (assetId: string | undefined, opts) => {
      const validTypes = ['raw', 'pdf', 'png', 'html', 'zip']
      if (!validTypes.includes(opts.type)) {
        console.error(`Invalid type "${opts.type}". Valid types: ${validTypes.join(', ')}`)
        process.exit(1)
      }

      // --- ZIP: task-level ---
      if (opts.type === 'zip') {
        const db = openDb()
        const task = resolveTaskForAsset(db, opts.task)
        const assets = db.query<AssetRow>(
          `SELECT * FROM task_assets WHERE task_id = :taskId ORDER BY "order" ASC`,
          { ':taskId': task.id }
        )
        const folders = db.query<AssetFolderRow>(
          `SELECT * FROM asset_folders WHERE task_id = :taskId`,
          { ':taskId': task.id }
        )
        db.close()

        if (assets.length === 0) {
          console.error('No assets to download.')
          process.exit(1)
        }

        const dir = getAssetsDir()
        const outputPath = opts.output ? path.resolve(opts.output) : path.resolve('assets.zip')
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })

        const byId = new Map(folders.map(f => [f.id, f]))
        function folderPath(id: string): string {
          const f = byId.get(id)
          if (!f) return ''
          return f.parent_id ? path.join(folderPath(f.parent_id), f.name) : f.name
        }

        const output = fs.createWriteStream(outputPath)
        const archive = archiver('zip', { zlib: { level: 9 } })
        archive.pipe(output)

        for (const asset of assets) {
          const fp = assetFilePath(dir, asset.task_id, asset.id, asset.title)
          if (!fs.existsSync(fp)) continue
          const rel = asset.folder_id
            ? path.join(folderPath(asset.folder_id), asset.title)
            : asset.title
          archive.file(fp, { name: rel })
        }

        await archive.finalize()
        await new Promise<void>((resolve, reject) => {
          output.on('close', resolve)
          output.on('error', reject)
        })

        if (opts.json) {
          console.log(JSON.stringify({ path: outputPath, type: 'zip', taskId: task.id }))
        } else {
          console.log(outputPath)
        }
        return
      }

      // --- Non-zip: assetId required ---
      if (!assetId) {
        console.error(`Asset ID required for --type ${opts.type}. Use --type zip for task-level download.`)
        process.exit(1)
      }

      const db = openDb()
      const asset = resolveAsset(db, assetId)
      db.close()

      const mode = getEffectiveRenderMode(asset.title, asset.render_mode as RenderMode | null)
      const baseName = asset.title.replace(/\.[^.]+$/, '') || asset.title

      // --- RAW ---
      if (opts.type === 'raw') {
        const dir = getAssetsDir()
        const srcPath = assetFilePath(dir, asset.task_id, asset.id, asset.title)
        if (!fs.existsSync(srcPath)) {
          console.error('Asset file not found on disk.')
          process.exit(1)
        }
        const outputPath = opts.output ? path.resolve(opts.output) : path.resolve(asset.title)
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })
        fs.copyFileSync(srcPath, outputPath)

        if (opts.json) {
          console.log(JSON.stringify({ path: outputPath, type: 'raw', assetId: asset.id }))
        } else {
          console.log(outputPath)
        }
        return
      }

      // --- PDF / PNG / HTML (requires app) ---
      const available = getAvailableExportTypes(mode)
      if (!available.includes(opts.type)) {
        console.error(`Cannot export "${asset.title}" (${mode}) as ${opts.type}.\nAvailable types for ${mode}: ${available.join(', ')}`)
        process.exit(1)
      }

      const ext = opts.type
      const outputPath = opts.output ? path.resolve(opts.output) : path.resolve(`${baseName}.${ext}`)
      await apiPost(`/api/assets/${asset.id}/export/${opts.type}`, { outputPath })

      if (opts.json) {
        console.log(JSON.stringify({ path: outputPath, type: opts.type, assetId: asset.id }))
      } else {
        console.log(outputPath)
      }
    })

  // --- Versions subcommand ---
  const versions = new Command('versions').description('Manage asset version history')

  versions
    .command('list <assetId>')
    .description('List version history for an asset (newest first)')
    .option('--limit <n>', 'Max rows', (v) => parseInt(v, 10), 50)
    .option('--offset <n>', 'Skip N rows', (v) => parseInt(v, 10), 0)
    .option('--json', 'Output as JSON')
    .action(async (assetId: string, opts: { limit: number; offset: number; json?: boolean }) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      const blobStore = new BlobStore(getDataDir())
      void blobStore
      const raw = db.raw()
      const rows = listVersions(raw, asset.id, { limit: opts.limit, offset: opts.offset })
      db.close()
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }
      if (rows.length === 0) {
        console.log('(no versions)')
        return
      }
      console.log(`VER  HASH       SIZE   NAME              AUTHOR            CREATED`)
      console.log(`---  ---------  -----  ----------------  ----------------  ----------------`)
      for (const v of rows) {
        const hash = v.content_hash.slice(0, 8)
        const name = (v.name ?? '').padEnd(16).slice(0, 16)
        const author = ((v.author_id ?? v.author_type ?? '') as string).padEnd(16).slice(0, 16)
        console.log(`v${String(v.version_num).padEnd(3)} ${hash}  ${String(v.size).padStart(5)}  ${name}  ${author}  ${v.created_at}`)
      }
    })

  versions
    .command('read <assetId> <version>')
    .description('Print content of a specific version (int, hash prefix, name, -N, HEAD~N)')
    .action(async (assetId: string, versionRef: string) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      try {
        const v = resolveVersionRef(raw, asset.id, versionRef)
        const buf = readVersionContent(blobStore, v)
        db.close()
        process.stdout.write(buf)
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  versions
    .command('diff <assetId> <a> [b]')
    .description('Diff two versions (b defaults to latest). Colorized unless --no-color.')
    .option('--no-color', 'Plain output')
    .option('--json', 'Output as JSON')
    .action(async (assetId: string, a: string, b: string | undefined, opts: { color: boolean; json?: boolean }) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      try {
        const result = diffVersions(raw, blobStore, { assetId: asset.id, a, b })
        db.close()
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }
        if (result.kind === 'binary') {
          console.log(`(binary)`)
          console.log(`  a: ${result.a.hash.slice(0, 8)}  ${result.a.size} bytes`)
          console.log(`  b: ${result.b.hash.slice(0, 8)}  ${result.b.size} bytes`)
          return
        }
        const useColor = opts.color !== false && process.stdout.isTTY
        const RED = useColor ? '\x1b[31m' : ''
        const GREEN = useColor ? '\x1b[32m' : ''
        const RESET = useColor ? '\x1b[0m' : ''
        for (const hunk of result.hunks) {
          for (const line of hunk.lines) {
            if (line.kind === 'add') process.stdout.write(`${GREEN}+${line.text}${RESET}\n`)
            else if (line.kind === 'del') process.stdout.write(`${RED}-${line.text}${RESET}\n`)
            else process.stdout.write(` ${line.text}\n`)
          }
        }
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  versions
    .command('set-current <assetId> <version>')
    .description('Set the current (HEAD) version. Next UI save branches from here if the target is locked.')
    .option('--json', 'Output as JSON')
    .action(async (assetId: string, version: string, opts: { json?: boolean }) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      const raw = db.raw()
      const txn = nodeSqliteTxn(raw)
      try {
        const v = setCurrentVersion(raw, txn, asset.id, version)
        const blobStore = new BlobStore(getDataDir())
        // Flush the selected version's bytes to disk so editors pick up on next read.
        const bytes = readVersionContent(blobStore, v)
        const dir = getAssetsDir()
        const fp = assetFilePath(dir, asset.task_id, asset.id, asset.title)
        fs.mkdirSync(path.dirname(fp), { recursive: true })
        fs.writeFileSync(fp, bytes)
        db.close()
        await notifyApp()
        if (opts.json) {
          console.log(JSON.stringify(v, null, 2))
        } else {
          console.log(`Current: v${v.version_num}${v.name ? ` (${v.name})` : ''}  ${v.content_hash.slice(0, 8)}`)
        }
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  versions
    .command('current <assetId>')
    .description('Print the current (HEAD) version')
    .option('--json', 'Output as JSON')
    .action((assetId: string, opts: { json?: boolean }) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      const raw = db.raw()
      const v = getCurrentVersion(raw, asset.id)
      db.close()
      if (!v) {
        console.error('No versions for this asset')
        process.exit(1)
      }
      if (opts.json) {
        console.log(JSON.stringify(v, null, 2))
      } else {
        console.log(`v${v.version_num}${v.name ? ` (${v.name})` : ''}  ${v.content_hash.slice(0, 8)}`)
      }
    })

  versions
    .command('create <assetId>')
    .description('Create a version from the current working copy (honors unchanged content)')
    .option('--name <name>', 'Optional name for the version')
    .option('--json', 'Output as JSON')
    .action(async (assetId: string, opts: { name?: string; json?: boolean }) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      const txn = nodeSqliteTxn(raw)
      try {
        const dir = getAssetsDir()
        const fp = assetFilePath(dir, asset.task_id, asset.id, asset.title)
        const bytes = fs.existsSync(fp) ? fs.readFileSync(fp) : Buffer.alloc(0)
        const v = createVersion(raw, txn, blobStore, {
          assetId: asset.id,
          bytes,
          name: opts.name ?? null,
          honorUnchanged: true,
          author: cliAuthor(),
        })
        db.close()
        if (opts.json) {
          console.log(JSON.stringify(v, null, 2))
        } else {
          console.log(`Created: v${v.version_num}${v.name ? ` (${v.name})` : ''}`)
        }
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  versions
    .command('rename <assetId> <version> [newName]')
    .description('Set, change, or clear (omit newName) the name of a version')
    .option('--clear', 'Clear the name')
    .option('--json', 'Output as JSON')
    .action(async (assetId: string, versionRef: string, newName: string | undefined, opts: { clear?: boolean; json?: boolean }) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      const raw = db.raw()
      const txn = nodeSqliteTxn(raw)
      try {
        const target = opts.clear ? null : (newName ?? null)
        const v = renameVersion(raw, txn, asset.id, versionRef, target)
        db.close()
        if (opts.json) {
          console.log(JSON.stringify(v, null, 2))
        } else {
          console.log(`Renamed v${v.version_num}: ${target ?? '(no name)'}`)
        }
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  versions
    .command('prune <assetId>')
    .description('Remove old versions. Named and current versions protected by default.')
    .option('--keep-last <n>', 'Keep the N most recent versions', (v) => parseInt(v, 10), 0)
    .option('--no-keep-named', 'Also delete named versions')
    .option('--no-keep-current', 'Allow deleting the current (HEAD) version')
    .option('--dry-run', 'Show what would be deleted without modifying')
    .option('--json', 'Output as JSON')
    .action(async (assetId: string, opts: { keepLast: number; keepNamed: boolean; keepCurrent: boolean; dryRun?: boolean; json?: boolean }) => {
      const db = openDb()
      const asset = resolveAsset(db, assetId)
      const blobStore = new BlobStore(getDataDir())
      const raw = db.raw()
      const txn = nodeSqliteTxn(raw)
      try {
        const report = pruneVersions(raw, txn, blobStore, asset.id, {
          keepLast: opts.keepLast,
          keepNamed: opts.keepNamed,
          keepCurrent: opts.keepCurrent,
          dryRun: opts.dryRun,
        })
        db.close()
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2))
        } else {
          const verb = opts.dryRun ? 'would delete' : 'deleted'
          console.log(`${verb} ${report.deletedVersions} versions, ${report.deletedBlobs} blobs (kept ${report.keptNamed} named)`)
        }
      } catch (err) {
        db.close()
        if (isVersionError(err)) {
          console.error(`Error [${err.code}]: ${err.message}`)
          process.exit(1)
        }
        throw err
      }
    })

  cmd.addCommand(versions)

  return cmd
}
