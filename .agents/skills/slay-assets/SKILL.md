---
name: slay-assets
description: "Manage task assets (files, folders) via the slay CLI"
trigger: auto
---

Assets are files attached to tasks, stored on disk at `{data-dir}/assets/{taskId}/{assetId}.ext`. They can be text files, images, or any binary content. Use assets to attach specifications, screenshots, logs, or any reference material to a task.

The `--task` flag defaults to `$SLAYZONE_TASK_ID` for `create`, `upload`, and `mkdir`. Note: `list` requires an explicit task ID argument.

## Files

- `slay tasks assets list <taskId> [--json] [--tree]` — list all assets for a task.
  - `--tree` shows an indented folder structure

- `slay tasks assets read <assetId>` — output asset content to stdout.
  - Binary assets (images, etc.) are written as raw buffers
  - Text assets as UTF-8

- `slay tasks assets create <title> [--task <id>] [--folder <id>] [--copy-from <path>] [--render-mode <mode>] [--json]` — create a new asset.
  - Content is read from stdin (must be piped — errors on TTY), or from a file via `--copy-from`
  - Render mode is inferred from the title's file extension if not specified (defaults to plain text if no extension)
  - Reference created assets in task descriptions via `[title](asset:<asset-id>)`

- `slay tasks assets upload <sourcePath> [--task <id>] [--title <name>] [--json]` — upload a file from disk as an asset.
  - Title defaults to the filename

- `slay tasks assets update <assetId> [--title <name>] [--render-mode <mode>] [--json]` — update asset metadata.
  - If the title changes and the file extension differs, the file is renamed on disk

- `slay tasks assets write <assetId> [--mutate-version [ref]]` — replace the asset's content entirely from stdin (pipe required).
  - Default: creates a new version
  - `--mutate-version` (bare): autosave to current version (auto-branches if locked)
  - `--mutate-version <ref>`: bypass lock and mutate the target version in place

- `slay tasks assets append <assetId> [--mutate-version [ref]]` — append to the asset's content from stdin (pipe required).
  - Versioning behavior same as `write`

- `slay tasks assets delete <assetId>` — delete an asset and its file.

- `slay tasks assets path <assetId>` — print the asset's absolute file path on disk.

## Folders

Assets can be organized into folders. Folder operations support cycle detection — you can't move a folder into its own child.

- `slay tasks assets mkdir <name> [--task <id>] [--parent <id>] [--json]` — create a folder, optionally nested under a parent.
- `slay tasks assets rmdir <folderId> [--json]` — delete a folder.
  - Contained assets are moved to root, not deleted
- `slay tasks assets mvdir <folderId> --parent <id|"root"> [--json]` — move a folder to a new parent.
  - Use `"root"` to move to top level
- `slay tasks assets mv <assetId> --folder <id|"root"> [--json]` — move an asset into a folder.
  - Use `"root"` for top level

## Versions

Every asset has immutable, content-addressed version history. Writes via `write`/`append`/`create` or the app UI create new versions automatically. Versions can be referenced by: integer (`5`), hash prefix (`a1b2`), name (`milestone-1`), relative (`-1`, `-2`), or `HEAD~N`.

- `slay tasks assets versions list <assetId> [--limit <n>] [--offset <n>] [--json]` — list version history, newest first.
  - Default limit: 50

- `slay tasks assets versions read <assetId> <version>` — print content of a specific version to stdout.

- `slay tasks assets versions diff <assetId> <a> [b] [--no-color] [--json]` — diff two versions.
  - `b` defaults to latest
  - Colorized output in TTY

- `slay tasks assets versions current <assetId> [--json]` — print the current (HEAD) version.

- `slay tasks assets versions set-current <assetId> <version> [--json]` — set the current (HEAD) version.
  - Flushes bytes to disk
  - Next UI save branches if the target is locked

- `slay tasks assets versions create <assetId> [--name <name>] [--json]` — create a version from the working copy (no-op if content unchanged).

- `slay tasks assets versions rename <assetId> <version> [newName] [--clear] [--json]` — set, change, or clear a version's name.
  - Use `--clear` or omit `newName` to clear
  - Named versions are protected from `prune`

- `slay tasks assets versions prune <assetId> [--keep-last <n>] [--no-keep-named] [--no-keep-current] [--dry-run] [--json]` — remove old versions.
  - Named and current versions protected by default

## Download / Export

Download assets in various formats. Default type is `raw` (original file).

- `slay tasks assets download <assetId> [--type raw|pdf|png|html] [--output <path>] [--json]` — download a single asset.
- `slay tasks assets download --type zip [--task <id>] [--output <path>] [--json]` — download all task assets as a ZIP archive (no assetId needed).

**Available types by render mode:**
| Type | Available for |
|------|--------------|
| raw  | all files |
| pdf  | markdown, code, html, svg, mermaid |
| png  | svg, mermaid |
| html | markdown, code, mermaid |
| zip  | all (task-level) |

`pdf`, `png`, and `html` exports require the SlayZone app to be running. `--output` defaults to the current directory with an auto-generated filename.

## Piping examples

```bash
echo "Meeting notes from standup" | slay tasks assets create "standup-notes.md"
cat report.csv | slay tasks assets write <assetId>
curl -s https://example.com/data.json | slay tasks assets append <assetId>
```
