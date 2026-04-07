<p align="center">
  <img src="packages/apps/app/build/icon.png" width="128" height="128" alt="SlayZone" />
</p>

<h1 align="center">SlayZone</h1>

<p align="center">
  <strong>Kanban with terminals. Card → Terminal → Agent.</strong>
  <br />
  Every card hides a terminal, a browser, git management, worktree, and much more. Agent management for humans.
</p>

<br />

<p align="center">
  <a href="https://github.com/debuglebowski/slayzone/releases/latest/download/SlayZone-arm64.dmg"><img src="https://img.shields.io/badge/Download_for-macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" /></a>&nbsp;&nbsp;
  <a href="https://github.com/debuglebowski/slayzone/releases/latest/download/SlayZone-setup-x64.exe"><img src="https://img.shields.io/badge/Download_for-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows" /></a>&nbsp;&nbsp;
  <a href="https://github.com/debuglebowski/slayzone/releases/latest/download/SlayZone-x64.AppImage"><img src="https://img.shields.io/badge/Download_for-Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download for Linux" /></a>
</p>

<details>
<summary><strong>More install options</strong></summary>
<br />

**Homebrew** (macOS):
```bash
brew tap debuglebowski/slayzone
brew install --cask slayzone
```

**Nix** (macOS / Linux):
```bash
nix profile install github:debuglebowski/slayzone
```

**Direct download** — or grab a specific build from [Releases](https://github.com/debuglebowski/slayzone/releases).

</details>

### Get started

1. Install the app using any method above.
2. Create a project — click **+** in the sidebar and point it to a folder on your machine.
3. Add a task — click **+** inside the project, then open the card to access the terminal, browser, and git panels.

<br />

---

<br />

### &nbsp;&#x1F916;&nbsp; Integrated AI agents

Claude Code, Codex, Gemini, and more — running inside task terminals. Spin up as many as you need per task. Real PTY sessions, not sandboxed previews.

### &nbsp;&#x1F9E9;&nbsp; Agent-Kanban interaction

Use SlayZone's MCP server so agents can read task context and update tasks, statuses, and subtasks from the terminal. Or use the `slay` CLI to manage tasks directly from any shell.

### &nbsp;&#x1F310;&nbsp; Embedded browser panels

Docs, PRs, and previews inside tasks — without leaving the app.

### &nbsp;&#x1F50D;&nbsp; Automatic status tracking

SlayZone watches your agents and tracks each task's status automatically — idle, working, or waiting for input.

### &nbsp;&#x1F33F;&nbsp; Git worktree per task

Isolated branches with built-in diff, conflict resolution, and commit UI. One branch per task, no more stashing half-finished work.

### &nbsp;&#x1F512;&nbsp; Fully local

Your agents run locally on your machine — SlayZone is just the interface.

<br />

---

### `slay` CLI

Manage tasks from any terminal without opening the app. The app live-updates when you make changes. Requires Node 24+.

```bash
# List tasks
slay tasks list
slay tasks list --status in_progress --project "My Project"

# Create a task
slay tasks create "Fix bug" --project "My Project"

# Create a project (path is auto-created if missing)
slay projects create "My Project" --path .

# Complete or open tasks
slay tasks done <id>
slay tasks open <id>

# Control the embedded browser (inside task terminals)
slay tasks browser navigate "https://localhost:3000"
```

Install via **SlayZone → Settings → About → Install**, or manually:

```bash
sudo ln -sf /Applications/SlayZone.app/Contents/Resources/bin/slay /usr/local/bin/slay
```

---

### Known bugs

- Terminal sync works perfectly 99% of the time. Cmd+R is a current workaround for the other situations.
- Auto-status tracking only fully works for Claude Code — Codex, Cursor, and OpenCode adapters are partial
- Large kanban boards (100+ cards) can feel sluggish during drag-and-drop

---

### Built with

Electron &middot; React &middot; SQLite &middot; node-pty &middot; xterm.js

### Get involved

SlayZone is built with SlayZone. PRs, issues, and ideas are all welcome.

```bash
git clone https://github.com/debuglebowski/slayzone.git
cd slayzone && pnpm install
pnpm dev
```

| Command | |
|---|---|
| `pnpm dev` | Start dev server |
| `pnpm dev:protocol` | Start dev server with deep-link protocol handler registration |
| `pnpm build` | Production build |
| `pnpm typecheck` | Typecheck all packages |
| `pnpm test:e2e` | Run E2E tests (build first) |

---

<p align="center">
  <img src="assets/star-history.jpg" width="100%" alt="Star History" />
</p>
 
 
