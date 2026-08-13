# Project paths belong to the runner, not the hub

## Why

`projects.path` is a single column in the hub's database. It names a directory the
hub cannot see, on a machine the hub does not own, and there is only one of it —
so the moment two runners lay a project out differently, the hub is necessarily
wrong about one of them. A Windows runner does not even agree on the separator.

Today the hub gets away with it because every exec frame takes an absolute path as
a parameter (`pty.spawn` cwd, `git.*` repoPath, `fs.*` rootPath), so the hub has
to supply a string it has no way to validate. Invert that and the whole class of
bug stops being representable: **frames carry a project id, and each runner
resolves its own path.**

This builds directly on `62cb3e972`, which routed the filesystem *operations* to
the owning runner but kept the hub's single path column.

## The model

| Who | Knows |
|---|---|
| Hub | *what* a project is — id, name, optional repo URL, which runner(s) |
| Runner | *where* it put that project — `project_id → absolute path` |

A path arrives on a runner one of two ways, and both are first-class:

- **Adopt** — point at a folder that already exists there. The dominant local
  case: your repos already live at `~/dev/foo` and `/Volumes/Work/bar`. Equally
  valid remotely, when someone already cloned it on the box.
- **Provision** — remote-git mode. The hub holds a repo URL; the runner clones
  into `<workspaceRoot>/<projectId>` and records the result.

`<workspaceRoot>/<projectId>` is the **provisioner's default**, never a constraint
on what the mapping can hold. No per-user folder level — that only made sense for
multiple users inside one runner, which is the thing that cannot work (below).

## One SlayZone user per runner

A runner process runs as exactly one OS account. Two SlayZone users sharing one
runner therefore share a filesystem, a credential set, and a process owner —
per-user subfolders are organisation, not isolation, and rotating credentials by
time does not help because a long-running agent outlives the rotation.

So: add `owner_user_id` to `runners` (it has no owner column today), set at enroll
from whoever minted the join token. A shared server is still fine — it just runs
several runners, one per OS account, each with its own working directory. That is
not a workaround: the runner inherits an OS account's identity and access, so the
real unit was always *user-on-a-machine*.

## Git access — verify, never custody

SlayZone provisions no git credentials today (no `GIT_ASKPASS`, no token
injection, nothing in the tree) and should keep it that way. Agents already push
from the runner using its ambient `gh auth` / ssh-agent / credential helper, so
remote-git mode adds no new permission surface — it relies on the same
prerequisite one step earlier.

Make that prerequisite **visible** instead of owning it: the runner reports
`gh auth status` + `git ls-remote <url>` on demand and at enroll, surfaced as a
runner state. "This runner can't reach that repo" becomes a fact fixed once with
`gh auth login` on that box, not a clone that dies mid-provision with a git error
in a log. Hub-brokered short-lived tokens (a `git credential` helper calling back
over the authed ws, GitHub App installation tokens) stay open as a later opt-in.

## Phases

### 1 — Runner owns the mapping

- Runner-side store `project_id → { path, source: 'adopted' | 'provisioned' }`,
  alongside the existing credential store under the runner's `<ROOT>`.
- Frames: `project.resolvePath`, `project.setPath`, `project.forgetPath`.
- `fs.listRoots` gains `workspaceRoot` (per-runner setting, must sit inside
  `allowedRoots`).
- **One-time seed:** on first connect after upgrade, the hub offers its existing
  `projects.path` for that runner to adopt. Nothing is published, but local dev
  installs would otherwise blank every project.

### 2 — Exec frames carry the project

- `pty.spawn`, `proc.spawn`, `git.*`, `fs.*` accept `projectId` and resolve cwd /
  repoPath runner-side. Absolute-path params stay for worktrees (which the runner
  itself created and named) and for `task.base_dir` overrides.
- `projects.path` is **deleted**, not migrated. It can only ever describe one
  machine.

### 3 — Remote-git mode

- Project fields: `git_mode` (`off` | `remote`), `repo_url`, `default_branch`.
- Before starting an agent session the runner ensures the checkout exists —
  clone if missing, report progress via **`checkout.status`**, which already
  exists in `frames.ts` and is emitted by the gateway but is sent by nobody and
  consumed by nobody. It was reserved for exactly this.
- First agent start becomes a clone: it needs visible progress and a real failure
  state, not a spinner that ends in a git error.

### 4 — Binding + guards

- `runners.owner_user_id`, set at enroll.
- **Lock a project to a runner** — concretely, disable the `tasks.runner_id`
  override for that project.
- **Block project create when zero runners are connected.** A project with no
  machine has nowhere to put a path; today it silently browses the hub's own disk.
- Readiness probe surfaced on the runner row.

### 5 — Move `gh` to the runner

`worktrees/server/gh-cli.ts` — `createPr`, `listOpenPrs`, `getPrComments`,
`hasGithubRemote` — still runs on the **hub**. So the PR panel authenticates as
the hub while the agent pushes as the runner. Same bug class as the one this plan
closes, and it lands in the middle of it: if the runner is where git happens, `gh`
belongs there too.

## Verification

- **Unit** — runner mapping store (adopt / provision / forget, unknown project),
  `project.resolvePath` refusing a path outside `allowedRoots`.
- **Roundtrip** — extend `fs-roundtrip.test.ts`: a `pty.spawn` carrying only a
  `projectId` lands in the right cwd; two runners with the SAME project id and
  DIFFERENT paths each resolve their own (the case one column cannot express).
- **Zero-runner** — `docs/exec-boundary.md`'s acceptance test still holds: the app
  boots, tasks list and archive, the UI renders. Create is the one new refusal.
- **Two-machine manual** — one project adopted locally and provisioned on a
  remote runner at a different path; both terminals open in the right place.
- **E2E** — `pnpm test:e2e`, from a clean host (not the supervised dev app).

## Unresolved

1. Project on two runners at once — supported, or does lock-to-runner become
   mandatory once remote-git mode is on?
2. Runner forgets a project (revoked / re-imaged): re-clone silently, or surface
   "not checked out here" and wait?
3. `task.base_dir` on a runner with no mapping for that project — allow as a raw
   path, or require the project be adopted there first?
4. Provisioned checkout on project delete — remove from the runner, or leave it?
5. `workspaceRoot` default: launch dir (matches today's `allowedRoots` default) or
   an explicit prompt at enroll?
