/**
 * Workspaces: a folder under the root holding an `orchestra.json` sets the rules of every repo
 * under it (roles, tickets, checks, integration suites, non-git targets, routing hints). The mod
 * itself knows no project: without a workspace, a repo gets the generic defaults below.
 *
 * A workspace is a folder of repos, never a repo: the apps stay agnostic of the orchestra, and
 * their rules (checks, integration suites, roles) are keyed by their path in the workspace file.
 * The file may sit in a subfolder (a versioned repo of the stack, say) and name the folder it rules
 * with `"root": ".."`. Workspaces nest: an inner folder's file refines the outer one's, key by key
 * (`roles`, `checks`, `integration` and `targets` merge one level deep; other keys are replaced).
 *
 * Text lines in a workspace file may use placeholders, filled where the line is used:
 * {workspace} (the workspace folder), {role}, {folder} (the role's folder), {from} and {start}
 * (where the task branch starts, in words and as a git revision).
 */

/** The folder every repo path is relative to; sessions start there. */
export const ROOT = '/app'

/** The file that makes a folder a workspace. */
export const WORKSPACE_FILE = 'orchestra.json'

/** The engine runs a command for 10 minutes at most: a check cannot run longer. */
const MAX_CHECK_SECONDS = 600

/** The role of a task when neither the task nor its workspace names one. */
export const DEFAULT_ROLE = 'developer'

export type TicketRules = {
  /** What the tracker is called in prompts, e.g. "Jira project X". */
  name: string
  /** A key of this tracker (regex source). The rules apply only to a request that names one. */
  key: string
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

/** A role card read from a folder of cards (cortex's agents/roles): what the role's agent is. */
export type RoleCard = { title: string; prompt: string; file: string; overlay?: string; semantic?: string }

/** An indexed file set (a capability card, a workflow): its title, and its files, base first. */
export type Indexed = { title: string; files: string[] }

/** A character of a personality theme: who plays a role. */
export type Character = { name: string; alias: string; card: string }

/**
 * A cortex personality theme for the sessions: `from` names the theme folder, which hooks/repos.py
 * reads into `theme` (its rules) and `characters` (by role). Workers play their role's character;
 * the reviewer plays the character of the role `reviewerAs` names, or none.
 */
export type Personality = { from?: string; reviewerAs?: string; theme?: string; characters?: Record<string, Character> }

export type Roles = {
  /**
   * A folder of role cards laid out as cortex's agents/roles/<folder>/<role>.md (or a list, the
   * first existing one wins); hooks/repos.py reads it into `list` and `cards`. "" for none here.
   */
  from?: string | string[]
  /** The cards read from `from`: each one is the whole instructions of its role's agent. */
  cards?: Record<string, RoleCard>
  /** A folder of workspace overlays of the cards, same layout: each is added after its base. */
  overlays?: string
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

export type Workspace = {
  /** The workspace folder, relative to the root. */
  path: string
  /** Where its file was read, for error messages. */
  file?: string
  roles?: Roles
  tickets?: TicketRules
  /**
   * Commands the orchestrator itself runs in a repo before a review, by repo path relative to the
   * workspace (`.` for the workspace folder itself, `*` for every repo of it): a failing one sends
   * the task back to its worker with the output, and spares a review session. `{base}` in a command is the commit the
   * task branch started from (`git diff --name-only {base}` lists the task's files).
   */
  checks?: Record<string, string[]>
  /** How long one check may run, in seconds: 1 to 600, the engine's limit for a command (default 600). */
  checkTimeout?: number
  /** Integration suites by repo path relative to the workspace: the command, run from the repo. */
  integration?: Record<string, string>
  /**
   * How many tasks may run at once in one repo of the workspace (default 1). Above 1, the extra
   * ones work in local clones of the repo, their branch fetched back on approval; a check that
   * only works in the main checkout (a container mounting it) does not suit them.
   */
  parallel?: number
  /** Files (relative to the workspace) the router reads to know the repos. */
  overview?: string[]
  /** Folder names the repo listing skips under this workspace. */
  ignore?: string[]
  /** Non-git targets by name. */
  targets?: Record<string, Target>
  /** Extra routing rules for the model that picks the repo. */
  route?: string[]
  /** A personality theme the workers (and the reviewer, if `reviewerAs` says so) play. */
  personality?: Personality
  /** Conventions every worker follows and every reviewer holds the work to: `docs`, read into `texts`; `docs: []` for none here. */
  practices?: { docs?: string[]; texts?: { file: string; text: string; semantic: string }[] }
  /** The reviewer's rules: `docs`, files read in order (a base, then overlays) into `texts`. */
  review?: { docs?: string[]; texts?: { file: string; text: string; semantic: string }[] }
  /** Capability cards (cortex capabilities/), indexed by name: a worker gets the paths of those its repo's stack uses. */
  capabilities?: { from?: string | string[]; index?: Record<string, Indexed> }
  /** Workflows (cortex workflows/ and the workspace's), indexed by name: a task may follow one. */
  workflows?: { from?: string | string[]; index?: Record<string, Indexed> }
  /**
   * What every new app must meet: lines for the worker and the reviewer of a task whose folder the
   * orchestrator just made a repo (git init, or a first commit), e.g. running under Docker Compose.
   */
  newApp?: string[]
}

let workspaces: readonly Workspace[] = []
let problems: readonly string[] = []

/** The workspaces in force, longest path first (the innermost wins). */
export const setWorkspaces = (list: readonly Workspace[], errors: readonly string[] = []): void => {
  workspaces = [...list].sort((a, b) => b.path.length - a.path.length)
  problems = [...errors]
}

export const allWorkspaces = (): readonly Workspace[] => workspaces

/** What is wrong with the workspace files read last: a file left out, a rule ignored. */
export const workspaceErrors = (): readonly string[] => problems

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string')

const compiles = (source: string): boolean => {
  try {
    new RegExp(source)
    return true
  } catch {
    return false
  }
}

/**
 * The faults of one workspace file that would silently change what the orchestra does: each
 * faulty part is dropped (the rest applies) and named, so the person knows.
 */
const validate = (raw: Record<string, unknown>, where: string): { ws: Workspace; errors: string[] } => {
  const errors: string[] = []
  const ws = { ...raw } as Workspace & Record<string, unknown>
  const drop = (key: string, why: string) => {
    errors.push(`${where}: ${key} ${why}; ignored`)
    delete ws[key]
  }
  const tickets = raw.tickets as Partial<TicketRules> | undefined
  if (tickets !== undefined) {
    if (typeof tickets?.name !== 'string' || typeof tickets.key !== 'string' || !isStrings(tickets.worker)) {
      drop('tickets', 'needs name, key and worker (lines)')
    } else if (!compiles(tickets.key)) {
      drop('tickets', `key "${tickets.key}" is not a valid regex`)
    }
  }
  const roles = raw.roles as Roles | undefined
  if (roles !== undefined) {
    const bad = (roles.byRepo ?? []).find(pair => !Array.isArray(pair) || typeof pair[0] !== 'string' || !compiles(pair[0]))
    if (bad !== undefined) {
      drop('roles', `byRepo pattern ${JSON.stringify(bad)} is not a valid regex`)
    } else if ((roles.worker && !isStrings(roles.worker)) || (roles.reviewer && !isStrings(roles.reviewer))) {
      drop('roles', 'worker and reviewer must be lists of lines')
    }
  }
  const checks = raw.checks as Record<string, unknown> | undefined
  if (checks !== undefined && (typeof checks !== 'object' || !Object.values(checks).every(isStrings))) {
    drop('checks', 'must map a repo path to a list of commands')
  }
  const targets = raw.targets as Record<string, Partial<Target>> | undefined
  if (targets !== undefined && !Object.values(targets).every(t => typeof t?.about === 'string' && isStrings(t.worker ?? []) && isStrings(t.review ?? []))) {
    drop('targets', 'each needs about, and worker / review as lists of lines')
  }
  const personality = raw.personality as Personality | undefined
  if (personality !== undefined && (typeof personality !== 'object' || (personality.reviewerAs !== undefined && typeof personality.reviewerAs !== 'string'))) {
    drop('personality', 'must be {from, reviewerAs?}')
  }
  if (raw.newApp !== undefined && !isStrings(raw.newApp)) {
    drop('newApp', 'must be a list of lines')
  }
  if (raw.checkTimeout !== undefined && !(Number.isInteger(raw.checkTimeout) && (raw.checkTimeout as number) >= 1 && (raw.checkTimeout as number) <= MAX_CHECK_SECONDS)) {
    drop('checkTimeout', `must be a whole number of seconds from 1 to ${MAX_CHECK_SECONDS}`)
  }
  if (raw.parallel !== undefined && !(Number.isInteger(raw.parallel) && (raw.parallel as number) >= 1)) {
    drop('parallel', 'must be a whole number from 1')
  }

  return { ws, errors }
}

/** Reads what hooks/repos.py --workspaces prints: the workspaces, and what is wrong with their files. */
export const parseWorkspaces = (stdout: string): { workspaces: Workspace[]; errors: string[] } => {
  let list: unknown
  try {
    list = JSON.parse(stdout)
  } catch {
    return { workspaces: [], errors: [] }
  }
  if (!Array.isArray(list)) {
    return { workspaces: [], errors: [] }
  }
  const found: Workspace[] = []
  const errors: string[] = []
  for (const entry of list as Record<string, unknown>[]) {
    const where = typeof entry?.file === 'string' ? entry.file : String(entry?.path ?? '?')
    if (Array.isArray(entry?.problems)) {
      errors.push(...(entry.problems as unknown[]).map(p => `${where}: ${String(p)}`))
    }
    if (typeof entry?.error === 'string') {
      errors.push(`${where}: ${entry.error}; the whole file is ignored`)
      continue
    }
    // Path '' is the root's own file, which rules every repo under the root.
    if (typeof entry?.path !== 'string' || typeof entry !== 'object') {
      continue
    }
    const checked = validate(entry, where)
    found.push(checked.ws)
    errors.push(...checked.errors)
  }

  return { workspaces: found, errors }
}

const inside = (repo: string, ws: Workspace): boolean => ws.path === '' || repo === ws.path || repo.startsWith(`${ws.path}/`)

/** Every workspace a repo sits in, innermost first. */
const chainOf = (repo: string): Workspace[] => workspaces.filter(ws => inside(repo, ws))

const MERGED = ['roles', 'checks', 'integration', 'targets'] as const

/** The workflow that is the reviewer's, never a task's. */
export const REVIEW_WORKFLOW = 'engineering/code-review'

/**
 * The rules in force for a repo: its workspaces merged from the outermost in, so an inner folder's
 * file refines the outer one's. Repo-relative keys (checks, integration) are rewritten relative to
 * the innermost workspace before merging.
 */
export const workspaceOf = (repo: string): Workspace | null => {
  const chain = chainOf(repo)
  if (chain.length === 0) {
    return null
  }
  const inner = chain[0] as Workspace
  const merged: Workspace = { path: inner.path }
  for (const ws of [...chain].reverse()) {
    const rebase = (map: Record<string, unknown> | undefined) =>
      Object.fromEntries(
        Object.entries(map ?? {}).map(([key, value]) => {
          if (key === '*') return [key, value]
          const full = key === '.' ? ws.path : ws.path ? `${ws.path}/${key}` : key
          const rel = full === inner.path ? '.' : full.startsWith(`${inner.path}/`) ? full.slice(inner.path.length + 1) : `!${full}`
          return [rel, value]
        }),
      )
    for (const [key, value] of Object.entries(ws) as [keyof Workspace, unknown][]) {
      if (key === 'path' || key === 'file') continue
      if ((MERGED as readonly string[]).includes(key)) {
        const own = key === 'checks' || key === 'integration' ? rebase(value as Record<string, unknown>) : (value as Record<string, unknown>)
        const before = (merged[key] as Record<string, unknown> | undefined) ?? {}
        const next: Record<string, unknown> = { ...before, ...own }
        if (key === 'roles') {
          next.list = { ...((before as Roles).list ?? {}), ...((own as Roles).list ?? {}) }
        }
        ;(merged as Record<string, unknown>)[key] = next
      } else {
        ;(merged as Record<string, unknown>)[key] = value
      }
    }
  }

  return merged
}

/** A repo's path inside its workspace (`.` for the workspace folder itself). */
export const relative = (repo: string, ws: Workspace): string => (ws.path ? repo.slice(ws.path.length).replace(/^\//, '') : repo) || '.'

export const workspaceDir = (ws: Workspace): string => (ws.path ? `${ROOT}/${ws.path}` : ROOT)

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

export const targetNames = (): string[] => [...new Set(workspaces.flatMap(ws => Object.keys(ws.targets ?? {})))]

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

/**
 * The ticket rules a task goes by: only when the request names a key of a tracker some workspace
 * declares, wherever the repo is (the repo's own workspace first). No key named, no ticket rules:
 * no key to look for, ask for, or put in branch names and commits.
 */
export const ticketsFor = (repo: string, text = ''): TicketRules | null => {
  const own = workspaceOf(repo)?.tickets
  if (own && keyPattern(own)?.test(text)) {
    return own
  }
  for (const ws of workspaces) {
    if (ws.tickets && keyPattern(ws.tickets)?.test(text)) {
      return ws.tickets
    }
  }
  return null
}

/** The trackers the workspaces declare, for prompts: name and key pattern. */
export const trackers = (): TicketRules[] => workspaces.flatMap(ws => (ws.tickets ? [ws.tickets] : []))

/** Every role a repo's workspace knows (any workspace's, for no repo), with its folder. */
export const knownRoles = (repo: string | null): Record<string, string> => {
  const ws = repo === null ? null : workspaceOf(repo) ?? targetOf(repo)?.ws ?? null
  return ws ? { ...(ws.roles?.list ?? {}) } : Object.assign({}, ...workspaces.map(w => w.roles?.list ?? {}))
}

export const isKnownRole = (role: string, repo: string | null): boolean => role in knownRoles(repo) || role === DEFAULT_ROLE

export const roleFolder = (role: string, repo: string | null): string => knownRoles(repo)[role] ?? ''

/** The card of a role in a repo's workspaces, if they have cards. */
export const roleCard = (role: string, repo: string): RoleCard | null => {
  const ws = workspaceOf(repo) ?? targetOf(repo)?.ws ?? null
  return ws?.roles?.cards?.[role] ?? null
}

/** The theme and the character a session of `role` plays in a repo, if its workspace has a personality. */
export const characterFor = (role: string, repo: string): { theme: string; character: Character } | null => {
  const personality = (workspaceOf(repo) ?? targetOf(repo)?.ws)?.personality
  const character = personality?.characters?.[role]
  return personality?.theme && character ? { theme: personality.theme, character } : null
}

/** The character the reviewer plays in a repo: the one of the role `reviewerAs` names, if any. */
export const reviewerCharacter = (repo: string): { theme: string; character: Character } | null => {
  const role = (workspaceOf(repo) ?? targetOf(repo)?.ws)?.personality?.reviewerAs
  return role ? characterFor(role, repo) : null
}

/** The reviewer's rules in a repo's workspaces: the texts of review.docs, base first. */
export const reviewTexts = (repo: string): { file: string; text: string; semantic: string }[] =>
  (workspaceOf(repo) ?? targetOf(repo)?.ws)?.review?.texts ?? []

/** The conventions of a repo's workspaces that every worker and reviewer gets. */
export const practiceTexts = (repo: string): { file: string; text: string }[] => (workspaceOf(repo) ?? targetOf(repo)?.ws)?.practices?.texts ?? []

/** The capability cards a repo's workspace offers, by name (`languages/php`). */
export const capabilityIndex = (repo: string): Record<string, Indexed> => (workspaceOf(repo) ?? targetOf(repo)?.ws)?.capabilities?.index ?? {}

/** The workflows a repo's workspace offers (any workspace's, for none), the reviewer's left out. */
export const workflowIndex = (repo: string | null): Record<string, Indexed> => {
  const all: Record<string, Indexed> =
    repo === null ? Object.assign({}, ...workspaces.map(w => w.workflows?.index ?? {})) : (workspaceOf(repo) ?? targetOf(repo)?.ws)?.workflows?.index ?? {}
  return Object.fromEntries(Object.entries(all).filter(([name]) => name !== REVIEW_WORKFLOW))
}

/** The roles of a repo (any workspace's, for none), each with what its card says it is: `lead-frontend (Lead UI/UX & Frontend Developer)`. */
export const roleSummaries = (repo: string | null): string[] => {
  const cards: Record<string, RoleCard> =
    repo === null ? Object.assign({}, ...workspaces.map(w => w.roles?.cards ?? {})) : (workspaceOf(repo) ?? targetOf(repo)?.ws)?.roles?.cards ?? {}
  return Object.keys(knownRoles(repo)).map(role => (cards[role] ? `${role} (${cards[role].title})` : role))
}

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
  const match = (ws.roles?.byRepo ?? []).find(([pattern]) => compiles(pattern) && new RegExp(pattern, 'i').test(path))

  return match?.[1] ?? ws.roles?.default ?? DEFAULT_ROLE
}

export const isLightRole = (role: string, repo: string): boolean =>
  (workspaceOf(repo) ?? targetOf(repo)?.ws)?.roles?.light?.includes(role) ?? false

/** The integration suite a repo's tasks must run, if its workspace names one. */
export const integrationFor = (repo: string): string => {
  const ws = workspaceOf(repo)
  return ws ? ws.integration?.[relative(repo, ws)] ?? '' : ''
}

/** The commands the orchestrator runs in a repo before its review: the repo's own, then the workspace-wide ones. */
export const checksFor = (repo: string): string[] => {
  const ws = workspaceOf(repo)
  return ws ? [...(ws.checks?.[relative(repo, ws)] ?? []), ...(ws.checks?.['*'] ?? [])] : []
}

export const checkTimeoutMs = (repo: string): number =>
  Math.min(MAX_CHECK_SECONDS, Math.max(1, workspaceOf(repo)?.checkTimeout ?? MAX_CHECK_SECONDS)) * 1000

/** What a new app made under this repo's workspaces must meet. */
export const newAppRules = (repo: string): string[] => workspaceOf(repo)?.newApp ?? []

/** How many tasks may run at once in a repo. */
export const parallelFor = (repo: string): number => (isTarget(repo) ? 1 : workspaceOf(repo)?.parallel ?? 1)

/** What the orchestra applies to a repo, in a few lines, for `/orch config`. */
export const describe = (repo: string): string[] => {
  const target = targetOf(repo)
  if (target) {
    return [
      `${repo}: non-git target of ${target.ws.path} — ${target.target.about}`,
      `Works from: ${target.target.cwd ?? '.'} (relative to ${workspaceDir(target.ws)})`,
      `Role: ${repoRole(repo)}`,
      `Worker rules: ${target.target.worker.length}, review rules: ${target.target.review.length}`,
    ]
  }
  const ws = workspaceOf(repo)
  const chain = chainOf(repo).map(w => w.file ?? `${w.path}/${WORKSPACE_FILE}`)
  return [
    `${repo}: ${ws ? `workspace ${ws.path || ROOT} (from ${chain.reverse().join(' → ')})` : 'no workspace: generic rules'}`,
    `Role by default: ${repoRole(repo)}${ws?.roles?.list ? ` · roles known: ${Object.keys(ws.roles.list).join(', ')}` : ''}`,
    `Reviewer's rules: ${reviewTexts(repo).map(t => t.file).join(' + ') || 'the generic ones'}`,
    `Practices: ${practiceTexts(repo).map(t => t.file).join(' + ') || 'none'}`,
    `Capability cards offered: ${Object.keys(capabilityIndex(repo)).length}, workflows: ${Object.keys(workflowIndex(repo)).join(', ') || 'none'}`,
    `Role cards: ${Object.keys(ws?.roles?.cards ?? {}).length ? `${Object.keys(ws?.roles?.cards ?? {}).length}${ws?.roles?.from ? `, from ${String(ws.roles.from)}` : ''}` : 'none (each session reads what its workspace tells it)'}`,
    `Tickets: ${trackers().length ? `only when the request names a key (${trackers().map(t => `${t.name}: ${t.key}`).join('; ')})` : 'none declared'}`,
    `Checks before review: ${checksFor(repo).join(' && ') || 'none'}`,
    `Integration suite: ${integrationFor(repo) || 'none'}`,
    `Tasks at once: ${parallelFor(repo)}`,
    `Rules for a new app: ${newAppRules(repo).length ? newAppRules(repo).join(' ') : 'none'}`,
    `Personality: ${ws?.personality?.characters ? `${String(ws.personality.from)} · ${Object.entries(ws.personality.characters).map(([r, c]) => `${r} = ${c.name}`).join(', ')}${ws.personality.reviewerAs ? ` · reviewer = ${ws.personality.characters[ws.personality.reviewerAs]?.name ?? '?'}` : ''}` : 'none'}`,
  ]
}
