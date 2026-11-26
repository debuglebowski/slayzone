# Sharing (hub with login)

Who besides a project's owner may reach its hub-resident content. Only a hub that
requires login shares anything; without login the one operator manages everything.

The decision is `packages/apps/api/src/access.ts`. Its facts are `project_members`,
`tasks.visibility`, `task_grants` and `artifact_grants`, written by the `sharing`
router (`packages/domains/projects/src/server/sharing-router.ts`).

## The model

- **Projects** have an owner and members. Each member has a role: view, edit or manage.
- **Tasks** are either public or private.
  - A public task (visibility `project`) is seen by the whole project, each person
    with their project role.
  - A private task is seen by its creator and the people invited to it. The project
    owner and the project's managers are not included.
  - A subtask follows its top-level task.
- **Artifacts** go with their task. A project member can also be invited to one
  artifact on its own. If they cannot see the artifact's private task, they open
  that artifact only, never the task. They find it under **Shared** in the sidebar's
  bottom toolbar. The button shows a count, lists the files by project, and marks each
  file new until it is opened. Files open view only.
- **Only project people can be invited.** That means the project's owner or one of
  its members. Three places enforce this:
  1. The sharing router refuses a task or artifact grant for anyone else
     (`BAD_REQUEST`). The pickers list only the project's people.
  2. `access.ts` ignores a grant held by anyone else, so a stray row opens nothing.
  3. Removing someone from the project deletes their task and artifact grants in that
     project, in the same transaction. Adding them back later does not restore old
     invitations.
- Computer-resident things are never shared: terminals, chats, worktrees and
  processes stay with their one owner.

## Migration v227: grants to non-members

T-100 first allowed inviting anyone on the hub to a single task or artifact. These
guests saw the item in a sidebar "Shared with me" section, outside any project. That
model is gone.

**Decision: v227 drops existing grants to non-members. It does not make them project
members.** Membership opens every public task of the project. A person invited to one
task was never given that, so automatic membership would silently widen their access.
If a dropped guest should keep access, a project manager adds them as a member
(Project Settings → Members), then invites them to the private task or file again.

v227 also adds `artifact_grants.opened_at`. While it is NULL, the file shows as new
under Shared.

## Out of scope

Sharing an artifact by link or URL. That needs its own design.
