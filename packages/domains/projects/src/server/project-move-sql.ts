/**
 * The SQL every project list and project-scoped job shares about a project being
 * moved to (or from) another hub — a `task_moves` row with `scope = 'project'`.
 * One definition, so a list, a reorder and the automation engine never disagree.
 */

const UNFINISHED = "('running', 'paused', 'failed')"

/**
 * Project row `alias` is not in transit between hubs: a list shows it. In transit =
 * arriving from another hub and not committed here yet, or already taken by the
 * target hub and about to be released here (an outgoing move at `release`). Either
 * way the other hub's copy is the one to show, so a moving project never appears twice.
 */
export const projectNotInTransitSql = (alias: string): string => `NOT EXISTS (
  SELECT 1 FROM task_moves pm
   WHERE pm.scope = 'project' AND pm.project_id = ${alias}.id AND pm.status IN ${UNFINISHED}
     AND (pm.direction = 'in' OR pm.step = 'release'))`

/**
 * The project `projectIdExpr` names is in an unfinished project move, either
 * direction: its writes are refused and its automations do not run.
 */
export const projectMovingSql = (projectIdExpr: string): string => `EXISTS (
  SELECT 1 FROM task_moves pm
   WHERE pm.scope = 'project' AND pm.project_id = ${projectIdExpr} AND pm.status IN ${UNFINISHED})`
