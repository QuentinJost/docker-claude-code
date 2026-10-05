/**
 * Workspaces: a folder under the root holding an `orchestra.json` sets the rules of every repo
 * under it (roles, tickets, integration suites, non-git targets, routing hints). The mod itself
 * knows no project: without a workspace, a repo gets the generic defaults below.
 *
 * Text lines in a workspace file may use placeholders, filled where the line is used:
 * {workspace} (the workspace folder), {repo} (the repo folder), {role}, {folder} (the role's
 * folder), {from} and {start} (where the task branch starts, in words and as a git revision).
 */

/** The folder every repo path is relative to; sessions start there. */
export const ROOT = '/app'

/** The file that makes a folder a workspace. */
export const WORKSPACE_FILE = 'orchestra.json'

/** The role of a task when neither the task nor its workspace names one. */
export const DEFAULT_ROLE = 'developer'

export type TicketRules = {
  /** What the tracker is called in prompts, e.g. "Jira project X". */
  name: string
  /** A key of this tracker (regex source); a request naming one is a ticket task wherever it runs. */
  key: string
  /** Repos of the workspace without tickets, by folder name; a trailing `*` matches a prefix. */
  except?: string[]
  /** The branch rule given to a worker on a ticket task ({from}, {start}). */
  worker: string[]
  /** What the reviewer is told about tickets, if anything. */
  reviewer?: string[]
}

/** A place work happens that is not a git repo (a running stack…): no branch, no commit, no diff. */
export type Target = {
  /** One line on what it is, for routing and briefs. */
  about: string
  /** Where its sessions work, relative to the workspace (default: the workspace itself). */
  cwd?: string
  role?: string
  /** The rules its worker follows. */
  worker: string[]
  /** How its reviewer checks the work, read-only. */
  review: string[]
}

export type Workspace = {
  /** The workspace folder, relative to the root. */
  path: string
  roles?: {
    /** Every role a task may name with `@role`, with its folder. */
    list?: Record<string, string>
    /** The role by repo path (relative to the workspace), first match wins: [regex source, role]. */
    byRepo?: [string, string][]
    default?: string
    /** Roles whose default sizing is lighter. */
    light?: string[]
    /** What a worker session is told at start ({role}, {folder}, {workspace}). */
    worker?: string[]
    /** What a reviewer session is told at start ({workspace}). */
    reviewer?: string[]
  }
  tickets?: TicketRules
  /** Integration suites by repo path relative to the workspace: the command, run from the repo. */
  integration?: Record<string, string>
  /** Files (relative to the workspace) the router reads to know the repos. */
  overview?: string[]
  /** Folder names the repo listing skips under this workspace. */
  ignore?: string[]
  /** Non-git targets by name. */
  targets?: Record<string, Target>
  /** Extra routing rules for the model that picks the repo. */
  route?: string[]
}

let workspaces: readonly Workspace[] = []

/** The workspaces in force, longest path first (the innermost wins). */
export const setWorkspaces = (list: readonly Workspace[]): void => {
  workspaces = [...list].sort((a, b) => b.path.length - a.path.length)
}

export const allWorkspaces = (): readonly Workspace[] => workspaces

/** Reads what hooks/repos.py --workspaces prints; malformed entries are left out. */
export const parseWorkspaces = (stdout: string): Workspace[] => {
  try {
    const list = JSON.parse(stdout) as unknown
    return Array.isArray(list)
      ? list.filter((w): w is Workspace => typeof w?.path === 'string' && w.path !== '' && typeof w === 'object')
      : []
  } catch {
    return []
  }
}

const inside = (repo: string, ws: Workspace): boolean => repo === ws.path || repo.startsWith(`${ws.path}/`)

/** The workspace a repo belongs to, if any. */
export const workspaceOf = (repo: string): Workspace | null => workspaces.find(ws => inside(repo, ws)) ?? null

/** A repo's path inside its workspace. */
export const relative = (repo: string, ws: Workspace): string => repo.slice(ws.path.length).replace(/^\//, '')

export const workspaceDir = (ws: Workspace): string => `${ROOT}/${ws.path}`

/** The non-git target of that name, with its workspace. */
export const targetOf = (name: string): { target: Target; ws: Workspace } | null => {
  for (const ws of workspaces) {
    const target = ws.targets?.[name]
    if (target) {
      return { target, ws }
    }
  }
  return null
}

export const isTarget = (name: string): boolean => targetOf(name) !== null

export const targetNames = (): string[] => workspaces.flatMap(ws => Object.keys(ws.targets ?? {}))

/** Fills a line's placeholders; unknown ones stay as they are. */
export const fill = (line: string, values: Record<string, string>): string =>
  line.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all)

const keyPattern = (tickets: TicketRules): RegExp | null => {
  try {
    return new RegExp(`\\b(?:${tickets.key})\\b`)
  } catch {
    return null
  }
}

const isExcepted = (name: string, except: readonly string[]): boolean =>
  except.some(e => (e.endsWith('*') ? name.startsWith(e.slice(0, -1)) : name === e))

/**
 * The ticket rules a task goes by: those of a tracker whose key the request names, wherever the
 * repo is; else its workspace's, unless the repo is excepted; else none (no key to find or ask for).
 */
export const ticketsFor = (repo: string, text = ''): TicketRules | null => {
  for (const ws of workspaces) {
    if (ws.tickets && keyPattern(ws.tickets)?.test(text)) {
      return ws.tickets
    }
  }
  const ws = workspaceOf(repo)
  const name = repo.split('/').at(-1) ?? repo

  return ws?.tickets && !isTarget(repo) && !isExcepted(name, ws.tickets.except ?? []) ? ws.tickets : null
}

/** Every role any workspace knows, with its folder. */
const knownRoles = (repo: string | null): Record<string, string> => {
  const ws = repo === null ? null : workspaceOf(repo) ?? targetOf(repo)?.ws ?? null
  return ws ? { ...(ws.roles?.list ?? {}) } : Object.assign({}, ...workspaces.map(w => w.roles?.list ?? {}))
}

export const isKnownRole = (role: string, repo: string | null): boolean => role in knownRoles(repo) || role === DEFAULT_ROLE

export const roleFolder = (role: string, repo: string | null): string => knownRoles(repo)[role] ?? ''

/** The role a repo's tasks run under when the task names none. */
export const repoRole = (repo: string): string => {
  const target = targetOf(repo)
  if (target) {
    return target.target.role ?? target.ws.roles?.default ?? DEFAULT_ROLE
  }
  const ws = workspaceOf(repo)
  if (!ws) {
    return DEFAULT_ROLE
  }
  const path = relative(repo, ws)
  const match = (ws.roles?.byRepo ?? []).find(([pattern]) => {
    try {
      return new RegExp(pattern, 'i').test(path)
    } catch {
      return false
    }
  })

  return match?.[1] ?? ws.roles?.default ?? DEFAULT_ROLE
}

export const isLightRole = (role: string, repo: string): boolean =>
  (workspaceOf(repo) ?? targetOf(repo)?.ws)?.roles?.light?.includes(role) ?? false

/** The integration suite a repo's tasks must run, if its workspace names one. */
export const integrationFor = (repo: string): string => {
  const ws = workspaceOf(repo)
  return ws ? ws.integration?.[relative(repo, ws)] ?? '' : ''
}
