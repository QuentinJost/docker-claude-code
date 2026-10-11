import type { HistoryEntry, Setting, Sizing, Task, Worker } from '../types'
import {
  ROOT,
  allWorkspaces,
  fill,
  integrationFor,
  isKnownRole,
  knownRoles,
  roleCard,
  characterFor,
  reviewTexts,
  practiceTexts,
  workflowIndex,
  reviewerCharacter,
  roleSummaries,
  isLightRole,
  isTarget,
  repoRole,
  roleFolder,
  targetNames,
  targetOf,
  ticketsFor,
  newAppRules,
  parallelFor,
  trackers,
  workspaceDir,
  workspaceOf,
} from './workspace'

/** Review rounds a task may fail before it is handed to the person. */
export const MAX_ROUNDS = 3

// A non-git target (a running stack…), named by a workspace: its tasks have no branch, no commit,
// no diff; the worker acts on it and reports what it did, the reviewer checks that report against it.
export { isTarget }

/** Where a task's worker runs. */
export const repoPath = (repo: string): string => {
  const found = targetOf(repo)
  if (!found) {
    return `${ROOT}/${repo}`
  }
  const cwd = (found.target.cwd ?? '.').replace(/^\.\/?/, '').replace(/\/$/, '')

  return cwd.startsWith('/') ? cwd : `${workspaceDir(found.ws)}${cwd ? `/${cwd}` : ''}`
}

/** Whether a task goes by a ticket: see ticketsFor. */
export const hasTickets = (repo: string, text = ''): boolean => ticketsFor(repo, text) !== null

/** Where a task works: a local clone when it runs beside another task of its repo, else the repo (or target) itself. */
export const taskDir = (task: Pick<Task, 'repo' | 'dir'>): string => task.dir || repoPath(task.repo)

const ROLE_TAG = /(^|\s)@([a-z-]+)\b/

/** The role a task runs under: its `@role` when its workspace knows it, else the repo's. */
export const roleFor = (repo: string, text: string): { role: string; text: string } => {
  const named = ROLE_TAG.exec(text)?.[2]
  if (named && isKnownRole(named, repo || null)) {
    return { role: named, text: text.replace(ROLE_TAG, ' ').trim() }
  }

  return { role: repoRole(repo), text }
}

/** Splits `<repo> <description>` as typed in the pane or after `/orch task`. */
export const parseTask = (input: string): { repo: string; text: string } | null => {
  // The text keeps its line breaks: a request may come with answers or a brief, line by line.
  const [, repo, text = ''] = /^(\S+)\s+([\s\S]*)$/.exec(input.trim()) ?? []

  return repo && text ? { repo: repo.replace(new RegExp(`^${ROOT}/`), '').replace(/\/$/, ''), text } : null
}

/** The model the orchestrator session runs on, which sizes every task. */
export const ORCHESTRATOR_MODEL = 'fable'

export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const isSetting = (value: unknown): value is Setting => {
  const setting = value as Partial<Setting> | null
  return (
    typeof setting?.model === 'string' &&
    (MODELS as readonly string[]).includes(setting.model) &&
    typeof setting.effort === 'string' &&
    (EFFORTS as readonly string[]).includes(setting.effort)
  )
}

/** Development never runs on a model weaker than this one (the person's rule). */
export const WORK_FLOOR = 'opus'

/**
 * No session the orchestrator launches runs on a model weaker than this one, reviews included
 * (the person's rule, 2026-10-03: avoid haiku). A Haiku background session starts in the
 * `default` permission mode, not `auto`, and waits for ever on its first approval: a reviewer
 * sized to haiku hung that way on 2026-10-03.
 */
export const SESSION_FLOOR = 'sonnet'

const RANK: readonly string[] = ['haiku', 'sonnet', 'opus', 'fable']

/** The setting raised to the floor model when it is below it; effort is kept. */
export const atLeast = (setting: Setting, floor: string): Setting =>
  RANK.indexOf(setting.model) < RANK.indexOf(floor) ? { ...setting, model: floor } : setting

/** The sizing when the orchestrator's model gives none. */
export const defaultSizing = (role: string, repo = ''): Sizing => ({
  work: isLightRole(role, repo) ? { model: WORK_FLOOR, effort: 'medium' } : { model: WORK_FLOOR, effort: 'high' },
  review: { model: 'opus', effort: 'high' },
  why: `default for ${role}`,
})

const OVERRIDE = /(^|\s)(model|effort|after|from):(\S+)/g

/** What a task's `key:value` words ask: the development's setting, the tasks it waits for, its start branch. */
export type Overrides = { text: string; work: Partial<Setting>; after: number[]; from: string }

/**
 * Pulls `model:<x>` and `effort:<y>` (they force the development's setting), `after:#n[,#m]`
 * (the task starts once those are approved) and `from:<branch>` (its branch starts there) out of a task.
 */
export const parseOverrides = (text: string): Overrides => {
  const work: Partial<Setting> = {}
  const after: number[] = []
  let from = ''
  for (const [, , key, value] of text.matchAll(OVERRIDE)) {
    if (key === 'after' && value) {
      after.push(...value.split(',').map(v => Number(v.replace(/^#/, ''))).filter(n => Number.isInteger(n) && n > 0))
    }
    if (key === 'from' && value) {
      from = value
    }
    if (key === 'model' && value && (MODELS as readonly string[]).includes(value)) {
      work.model = value
    }
    if (key === 'effort' && value && (EFFORTS as readonly string[]).includes(value)) {
      work.effort = value
    }
  }

  return { text: text.replace(OVERRIDE, ' ').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim(), work, after: [...new Set(after)], from }
}

export const SIZING_SYSTEM = [
  'You size Claude Code sessions for an orchestrator. Each task runs in one development session, then each review round in a fresh reviewer session.',
  'Pick, for each, the cheapest model and effort that will do the job well; a failed review round costs more than a stronger first pass.',
  'Models: fable (most capable, slowest, most expensive: ambiguous design, cross-cutting or risky changes), opus (strong default for real code changes), sonnet (well-specified routine changes, docs, small fixes, light reviews). Haiku is never used.',
  `Development runs on ${WORK_FLOOR} or fable, never below ${WORK_FLOOR}: pick between those two and size the effort; the reviewer runs on ${SESSION_FLOOR}, opus or fable.`,
  'Effort: low, medium, high, xhigh, max. Raise it for subtle logic, security, data migrations, concurrency, money; lower it for mechanical work.',
  'The reviewer must be able to catch what the developer can miss: never weaker than the development on a risky task.',
  'Past tasks, when listed, are evidence: a setting that got similar tasks approved at round 1 is enough, take the cheaper one; a setting that needed several rounds, check fixes or escalated was too weak, go stronger.',
  'Reply with JSON only: {"work":{"model":"…","effort":"…"},"review":{"model":"…","effort":"…"},"why":"one short sentence"}',
].join('\n')

/** How many past tasks the sizing sees. */
export const HISTORY_SHOWN = 15

/** One past task as the sizing reads it. */
const historyLine = (h: HistoryEntry): string =>
  `- ${h.repo} · ${h.role} · dev ${h.work.model}·${h.work.effort} · review ${h.review.model}·${h.review.effort} → ${h.outcome} after ${h.rounds} round(s)${h.checkFixes ? `, ${h.checkFixes} check fix(es)` : ''}, ≈$${h.cost.toFixed(2)} · ${h.title}`

/** The past tasks closest to this one: same role or repo first, most recent first. */
export const relevantHistory = (history: readonly HistoryEntry[], repo: string, role: string): HistoryEntry[] => {
  const recent = [...history].reverse()
  const close = recent.filter(h => h.role === role || h.repo === repo)
  return [...close, ...recent.filter(h => !close.includes(h))].slice(0, HISTORY_SHOWN)
}

export const sizingPrompt = (repo: string, role: string, text: string, history: readonly HistoryEntry[] = []): string =>
  [
    `Repo: ${repo}\nRole: ${role}\nTask: ${text}`,
    ...(history.length ? ['', 'Past tasks (setting → outcome, cost):', ...relevantHistory(history, repo, role).map(historyLine)] : []),
  ].join('\n')

/** Reads the sizing JSON the orchestrator's model replied, or null when it is not one. */
export const parseSizing = (reply: string): Sizing | null => {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0]
  if (!json) {
    return null
  }
  try {
    const parsed = JSON.parse(json) as Partial<Sizing>
    return isSetting(parsed.work) && isSetting(parsed.review)
      ? { work: parsed.work, review: parsed.review, why: typeof parsed.why === 'string' ? parsed.why : '' }
      : null
  } catch {
    return null
  }
}

/** The Prompt Manager's framework, applied to a task before the workers see it. */
export const UPGRADE_SYSTEM = [
  'You are the Prompt Manager of a software team: the first reader of every request, who reframes it before a developer agent works on it in a background Claude Code session.',
  'The developer only sees the brief you write, in its own session: it reads the repo, but not this conversation.',
  'Analyse the request for clarity, completeness, ambiguity and contradictions. Then rewrite it as a brief, in the language the request was written in, in this order:',
  '1. Objective (what and why, one or two lines) 2. Context (repo, area, current state, as far as the request says) 3. Task (precise, numbered steps when several) 4. Constraints (conventions, scope limits, what not to touch) 5. Done when (observable checks: tests, behaviour).',
  'Keep every fact, identifier and ticket key of the request verbatim; never invent requirements, file names or data the request does not give. Where the request leaves a routine choice open, say which default the developer should take.',
  'A request whose intent cannot be told, or that contradicts itself, is not forwarded: ask instead, with the fewest questions that would settle it.',
  `A request that spans distinct domains of one repo (an API and the UI that uses it, a schema migration and the code on it, the code and its end-to-end tests) is split into one task per domain, each for the role of that domain among the roles listed, so that each is done by a specialist; at most ${4} tasks. Tasks run one after the other in a repo: give a task "after", the 0-based positions of the earlier tasks of your list it builds on (the UI waits for the API it calls). Do not split a request that one developer does best in one go (a small change, a single domain).`,
  'When a listed workflow fits the work (a feature, a support case, frontend tests, a regulatory deliverable…), name it in "workflow": its developer follows its steps for its part, and a split follows the workflow\'s order of roles. Name none when nothing fits.',
  'Reply with JSON only, one of: {"status":"ready","title":"one line, 100 characters at most, the ticket key first when there is one","role":"a listed role, or omit it","workflow":"a listed workflow, or omit it","brief":"the brief, markdown, newlines as \\n"} for one task; {"status":"ready","tasks":[{"role":"a listed role","workflow":"…","after":[0],"title":"…","brief":"…"}]} for a split; or {"status":"unclear","questions":["…"]}.',
].join('\n')

/** How a repo reads in prompts: its ticket tracker, or that it has none. */
const ticketNote = (repo: string, text = ''): string => {
  const tickets = ticketsFor(repo, text)
  return tickets ? ` (ticket task: ${tickets.name})` : ' (the request names no ticket key: no ticket rules, never look for or ask for a key)'
}

export const upgradePrompt = (repo: string, role: string, text: string): string =>
  [
    isTarget(repo)
      ? `Target: ${targetOf(repo)?.target.about ?? repo}, from ${repoPath(repo)}, which is not a git repo: operations work, no code change. Done-when checks are observable states of the target.`
      : `Repo: ${ROOT}/${repo}${ticketNote(repo, text)}`,
    `Developer role: ${role} (its role card, if any, is loaded in its session)`,
    ...(Object.keys(knownRoles(repo)).length ? [`Roles for a split: ${roleSummaries(repo).join(', ')}`] : []),
    ...(Object.keys(workflowIndex(repo)).length ? [`Workflows: ${Object.entries(workflowIndex(repo)).map(([n, w]) => `${n} (${w.title})`).join(', ')}`] : []),
    `Request:\n${text}`,
  ].join('\n')

/** One repo of the workspace, as hooks/repos.py lists it for routing. */
export type RepoInfo = { repo: string; about: string }

/** At most this many tasks come out of one routed request, one per repo. */
export const MAX_ROUTED = 4

/** `/orch prompt` without a repo: the Prompt Manager also picks where the work happens. */
export const ROUTE_SYSTEM = [
  ...UPGRADE_SYSTEM.split('\n').slice(0, -1),
  `The request names no repo: you also pick where the work happens, among the git repositories listed (paths under ${ROOT}) and the non-git targets listed. Read the workspace overviews to know what each one is.`,
  'Work on a non-git target itself, with no code change in any repo, goes to that target, by its name as listed.',
  'Pick the repo whose code the change lives in. Prefer a main checkout over a ticket worktree (a folder named after a ticket key) unless the request names that ticket; never pick a throwaway sandbox unless the request names it; never pick a repo marked as migrated or deprecated.',
  `A request that needs changes in several repos becomes one task per repo, each with its own brief (at most ${MAX_ROUTED} tasks in all); say in each brief what the other side does. Within one repo, split by domain as above, several tasks on the same repo. Tasks run in parallel unless one needs another's result: then give it "after", the 0-based positions of the earlier tasks of your list it waits for (the frontend that consumes a new API field waits for the backend task).`,
  `Ticket rules apply only to a request that names a ticket key: never invent, search or ask for a key. A request you cannot place is not forwarded: ask instead.`,
  'Reply with JSON only, either {"status":"ready","tasks":[{"repo":"path as listed","role":"a listed role, or omit it","workflow":"a listed workflow, or omit it","after":[0],"title":"one line, 100 characters at most, the ticket key first when there is one","brief":"the brief, markdown, newlines as \\n"}]} or {"status":"unclear","questions":["…"]}.',
].join('\n')

export const routePrompt = (repos: readonly RepoInfo[], overview: string, role: string | null, text: string): string =>
  [
    `Targets: the git repositories under ${ROOT}${targetNames().length ? ', and the non-git targets' : ''}:`,
    ...allWorkspaces().flatMap(ws => Object.entries(ws.targets ?? {}).map(([name, t]) => `- ${name} — ${t.about}, no git`)),
    ...repos.map(r => `- ${r.repo}${r.about ? ` — ${r.about}` : ''}`),
    ...(trackers().length ? ['', `Ticket trackers: ${trackers().map(t => t.name).join(', ')}; a task is a ticket task only when the request names a key.`] : []),
    ...allWorkspaces().flatMap(ws => (ws.route ?? []).map(line => fill(line, { workspace: workspaceDir(ws) }))).map((line, i) => (i === 0 ? `\nRouting rules of the workspaces:\n- ${line}` : `- ${line}`)),
    ...(overview ? ['', 'Workspace overview:', overview] : []),
    '',
    ...(Object.keys(knownRoles(null)).length ? ['', `Roles: ${roleSummaries(null).join(', ')}`] : []),
    ...(Object.keys(workflowIndex(null)).length ? [`Workflows: ${Object.entries(workflowIndex(null)).map(([n, w]) => `${n} (${w.title})`).join(', ')}`] : []),
    ...(role ? [`Developer role, named by the person: ${role}`] : []),
    `Request:\n${text}`,
  ].join('\n')

export type RoutedTask = { repo: string; title: string; brief: string; after: number[]; role?: string; workflow?: string }

export type Routed = { tasks: RoutedTask[] } | { questions: string[] }

/** Reads the routing JSON, keeping only tasks on a listed repo; null when it is not one. */
export const parseRouting = (reply: string, repos: readonly RepoInfo[]): Routed | null => {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0]
  if (!json) {
    return null
  }
  try {
    const parsed = JSON.parse(json) as { status?: string; tasks?: unknown; questions?: unknown }
    if (parsed.status === 'ready' && Array.isArray(parsed.tasks)) {
      const known = new Set([...targetNames(), ...repos.map(r => r.repo)])
      const tasks = parsed.tasks
        .map(t => t as { repo?: unknown; title?: unknown; brief?: unknown; after?: unknown; role?: unknown; workflow?: unknown })
        .filter(t => typeof t.repo === 'string' && known.has(t.repo) && typeof t.brief === 'string' && t.brief.trim() !== '')
        .map((t, index) => {
          const brief = String(t.brief).trim()
          // Only earlier tasks of the same list: no cycle, and their ids exist by then.
          const after = Array.isArray(t.after) ? t.after.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < index) : []
          return {
            repo: String(t.repo),
            title: firstLine(typeof t.title === 'string' ? t.title.trim() : '') || firstLine(brief),
            brief,
            after,
            ...(typeof t.role === 'string' && t.role ? { role: t.role } : {}),
            ...(typeof t.workflow === 'string' && t.workflow ? { workflow: t.workflow } : {}),
          }
        })
        .slice(0, MAX_ROUTED)
      return tasks.length > 0 && tasks.length === Math.min(parsed.tasks.length, MAX_ROUTED) ? { tasks } : null
    }
    if (parsed.status === 'unclear' && Array.isArray(parsed.questions)) {
      const questions = parsed.questions.filter((q): q is string => typeof q === 'string' && q.trim() !== '')
      return questions.length > 0 ? { questions } : null
    }
    return null
  } catch {
    return null
  }
}

export type Upgrade = { title: string; brief: string; role?: string; workflow?: string } | { tasks: RoutedTask[] } | { questions: string[] }

/** Reads the upgrade JSON the orchestrator's model replied, or null when it is not one. */
/** Reads the upgrade JSON: one brief, a split of the request by domain into tasks on `repo`, or questions. */
export const parseUpgrade = (reply: string, repo = ''): Upgrade | null => {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0]
  if (!json) {
    return null
  }
  try {
    const parsed = JSON.parse(json) as { status?: string; title?: string; brief?: string; role?: unknown; workflow?: unknown; tasks?: unknown; questions?: unknown }
    if (parsed.status === 'ready' && Array.isArray(parsed.tasks)) {
      // The same shape as a routing, every task on the repo the person named.
      const tasks = (parsed.tasks as Record<string, unknown>[]).map(t => ({ ...t, repo }))
      const routed = parseRouting(JSON.stringify({ status: 'ready', tasks }), [{ repo, about: '' }])
      return routed && 'tasks' in routed ? routed : null
    }
    if (parsed.status === 'ready' && typeof parsed.title === 'string' && typeof parsed.brief === 'string' && parsed.brief.trim()) {
      return {
        title: firstLine(parsed.title.trim()) || firstLine(parsed.brief.trim()),
        brief: parsed.brief.trim(),
        ...(typeof parsed.role === 'string' && parsed.role ? { role: parsed.role } : {}),
        ...(typeof parsed.workflow === 'string' && parsed.workflow ? { workflow: parsed.workflow } : {}),
      }
    }
    if (parsed.status === 'unclear' && Array.isArray(parsed.questions)) {
      const questions = parsed.questions.filter((q): q is string => typeof q === 'string' && q.trim() !== '')
      return questions.length > 0 ? { questions } : null
    }
    return null
  } catch {
    return null
  }
}

export const agentName = (role: string): string => `orch-${role}`

export const REVIEWER = 'orch-reviewer'

/**
 * The personality lines of a session: the theme's rules and the character's card, kept to the
 * prose, so that the lines the orchestrator reads (STATUS:, VERDICT:…) stay as the brief asks.
 */
const personalityLines = (played: { theme: string; character: { name: string; card: string } } | null): string[] =>
  played
    ? [
        `You play ${played.character.name}: the theme and the character card follow. They set your tone only, never your work, and the files they name are not to be looked for. The personality goes in your prose: every line the brief's report format asks for (STATUS:, SUMMARY:, BRANCH:, CHANGES:, TESTS:, NEEDS:, VERDICT:, FINDINGS:) keeps its exact form, with your signature quote before them.`,
        '----- theme -----',
        played.theme,
        '----- character card -----',
        played.character.card,
        '----- end of personality -----',
      ]
    : []

/**
 * The reviewer's rules as its workspace gives them: the base, then each overlay, whole. This
 * review is local: what the rules say of publishing (GitHub events, labels, comments) is left out.
 */
const reviewDocLines = (repo: string): string[] => {
  const texts = repo ? reviewTexts(repo) : []
  return texts.length
    ? [
        'Your review rules follow: the base, then the workspace overlay, which wins where they differ (a replacement overlay rewrites the parts it names; the rest of the base stands). This review is local: you publish nothing, so the steps about GitHub events, labels and comments do not apply; your verdict goes to the orchestrator, in the brief\'s format, with the rules\' severities and vocabulary.',
        ...texts.flatMap(t => [`----- ${t.semantic === 'base' ? 'base rules' : `overlay (${t.semantic})`}: ${t.file} -----`, t.text]),
        '----- end of review rules -----',
      ]
    : []
}

/** The workspace's conventions, whole: what the worker follows and the reviewer holds the work to. */
const practiceLines = (repo: string, isReviewer: boolean): string[] => {
  const texts = repo ? practiceTexts(repo) : []
  return texts.length
    ? [
        isReviewer
          ? 'The conventions the work must follow are below: one not followed is a finding, at the severity the review rules give a written convention.'
          : 'Follow these conventions in everything you write and commit; a repo\'s own written conventions win over them.',
        ...texts.flatMap(t => [`----- conventions: ${t.file} -----`, t.text]),
        '----- end of conventions -----',
      ]
    : []
}

/** The workspace a task's repo or target belongs to. */
const wsOf = (repo: string) => workspaceOf(repo) ?? targetOf(repo)?.ws ?? null

/** What `--agents` takes for one worker role: the workspace's start lines point at its role cards. */
/**
 * How a session reports, in its agent definition: the system prompt is never compacted, so the
 * format and the address outlive a compaction that summarised the brief away.
 */
const reportRules = (self: string, lines: readonly string[]): string[] => [
  `How you report, every time, also after your context was compacted: with SendMessage to the orchestrator${self ? `, "${self}" (or the session a later [ORCH <name> …] message names)` : ', the session named in the [ORCH <name> …] header of your latest brief'}, in exactly this format, one field per line:`,
  ...lines,
  // Seen 2026-10-09: a reviewer that never loaded the deferred tool wrote "SendMessage to …"
  // as its reply, and the verdict reached no one.
  'SendMessage is a deferred tool in this session: before your first report, load it with ToolSearch (query "select:SendMessage"), then call the SendMessage tool itself. A report written as the text of your reply, "SendMessage to …" included, reaches no one: the orchestrator only gets what the tool delivers.',
]

export const workerAgent = (role: string, repo = '', self = ''): string => {
  const ws = wsOf(repo)
  const values = { role, folder: roleFolder(role, repo || null), workspace: ws ? workspaceDir(ws) : ROOT }
  const card = repo ? roleCard(role, repo) : null
  const prompt = [
    `You are the ${role} worker of an orchestrator session. You do the task yourself: in this session you are not the Prompt Manager and you do not dispatch.`,
    ...(card
      ? [
          `Your role card follows: it is who you are and the standards you hold. It is written for any project: where it names project files (project-context.md, docs/, a README), read the target repo's own when they exist, and go on without them otherwise.`,
          '----- role card -----',
          card.prompt,
          '----- end of role card -----',
          ...(card.overlay
            ? [
                `The workspace's overlay of that card follows (${card.semantic === 'replacement' ? 'it replaces the parts of the card it rewrites' : 'it adds to the card'}; where they differ, the overlay wins).`,
                '----- workspace overlay -----',
                card.overlay,
                '----- end of overlay -----',
              ]
            : []),
        ]
      : []),
    ...(ws?.roles?.worker ?? []).map(line => fill(line, values)),
    ...practiceLines(repo, false),
    ...personalityLines(repo ? characterFor(role, repo) : null),
    'Tasks arrive as cross-session messages from the orchestrator. One task at a time; stay inside the repo the brief names.',
    ...reportRules(self, isTarget(repo) ? STACK_REPORT : REPORT_LINES),
  ].join('\n')

  return JSON.stringify({ [agentName(role)]: { description: `Orchestrator worker: ${role}`, prompt } })
}

/** What `--agents` takes for the reviewer: generic rules, then the workspace's review rules. */
export const reviewerAgent = (repo = '', self = ''): string => {
  const ws = wsOf(repo)
  const prompt = [
    'You are the code reviewer of an orchestrator session. You review; you never edit, commit, push, or comment on GitHub.',
    ...(ws?.roles?.reviewer ?? []).map(line => fill(line, { workspace: workspaceDir(ws as NonNullable<typeof ws>) })),
    'Review against the task\'s acceptance criteria and the repo\'s own conventions. Verify every finding against the code before reporting it. Approve only when no 🔴 blocking and no 🟠 major finding remains.',
    ...reviewDocLines(repo),
    ...practiceLines(repo, true),
    ...personalityLines(repo ? reviewerCharacter(repo) : null),
    ...reportRules(self, ['VERDICT: APPROVED | CHANGES_REQUESTED', 'FINDINGS:', '- 🔴|🟠|⚪ <file:line or what was checked> — <problem> — <expected fix>']),
  ].join('\n')

  return JSON.stringify({ [REVIEWER]: { description: 'Orchestrator reviewer', prompt } })
}

export const firstLine = (text: string): string => (text.split('\n')[0] ?? '').slice(0, 100)

const branchRule = (task: Task): string => {
  const from = task.branchFrom || 'the repo\'s current branch'
  const start = task.branchFrom || 'HEAD'

  const tickets = ticketsFor(task.repo, task.text)

  return tickets
    ? tickets.worker.map(line => `- ${fill(line, { from, start })}`).join('\n')
    : `- The request names no ticket key: no ticket rules, never look for or ask for a key. Branch named <type>/<short-slug> like the repo's existing branches (feat/…, fix/…, perf/…, chore/…), created from ${from} (git switch -c <branch> ${start}), never from another task's branch.`
}

/** The rules of every non-git target, before its workspace's own. */
const targetRules = (task: Task): string[] => [
  `- ${repoPath(task.repo)} is not a git repo: no branch, no commit. Act on the target as the task needs.`,
  ...(targetOf(task.repo)?.target.worker ?? []).map(line => `- ${line}`),
  '- Before anything that destroys or cannot be undone, save what it would lose first, or report STATUS: blocked and ask in NEEDS.',
  '- Keep a log of every command that changed something, and how to undo it. Check the outcome on the target before reporting.',
]

/** What a worker reports on a repo task. */
const REPORT_LINES = [
  'STATUS: done | blocked | failed',
  'SUMMARY: <2-5 lines>',
  'BRANCH: <the task branch, exactly as git names it>',
  'CHANGES: <branch, commits>',
  'TESTS: <what ran, result>',
  'NEEDS: <decision required from the person, if any>',
]

const STACK_REPORT = [
  'STATUS: done | blocked | failed',
  'SUMMARY: <2-5 lines>',
  'CHANGES: <every change made to the target: command, effect, how to undo it>',
  'TESTS: <the checks run on the target and what they showed, with the commands so the reviewer can rerun them>',
  'NEEDS: <decision required from the person, if any>',
]

export const workerBrief = (self: string, task: Task): string =>
  isTarget(task.repo) ? targetBrief(self, task) : [
    `[ORCH ${self} · task #${task.id} · round 1] ${firstLine(task.text)}`,
    '',
    `Repo: ${taskDir(task)} (work only there)`,
    ...(task.dir ? [`This is a local clone of ${ROOT}/${task.repo}, for this task only: another task works in the main checkout. Install dependencies here if the tests need them; never touch the main checkout.`] : []),
    `Task: ${task.text}`,
    ...(task.prior ? ['', task.prior] : []),
    '',
    'Rules:',
    branchRule(task),
    hasTickets(task.repo, task.text)
      ? '- Commit locally with the project\'s git identity and subject format; never push.'
      : '- Commit locally with the project\'s git identity and subject format, without any ticket key; never push.',
    '- Run the relevant tests before reporting.',
    ...(integrationFor(task.repo) ? [`- Run the integration suite too, from the repo: ${integrationFor(task.repo)}. A task is not done while it fails; report its result in TESTS.`] : []),
    ...(task.capabilities?.length
      ? [`- Capability cards for this repo's stack (the practices of its language, framework, database…): read those that bear on your change: ${task.capabilities.join(', ')}.`]
      : []),
    ...(task.workflow && workflowIndex(task.repo)[task.workflow]
      ? [`- Follow the workflow ${task.workflow} for your part (${workflowIndex(task.repo)[task.workflow]?.files.join(' then the overlay ')}): read it first; the steps that are not yours (another role, a review) are done by the orchestrator, not by you.`]
      : []),
    ...(task.isNewApp && newAppRules(task.repo).length ? ['- This is a new app. Every new app must meet these rules, as part of this task:', ...newAppRules(task.repo).map(line => `  - ${line}`)] : []),
    '',
    `When finished, reply via SendMessage to "${self}" with:`,
    'STATUS: done | blocked | failed',
    'SUMMARY: <2-5 lines>',
    'BRANCH: <the task branch, exactly as git names it>',
    'CHANGES: <branch, commits>',
    'TESTS: <what ran, result>',
    'NEEDS: <decision required from the person, if any>',
  ].join('\n')

const targetBrief = (self: string, task: Task): string =>
  [
    `[ORCH ${self} · task #${task.id} · round 1] ${firstLine(task.text)}`,
    '',
    `Target: ${task.repo}, ${targetOf(task.repo)?.target.about ?? 'not a git repo'}, working from ${repoPath(task.repo)}`,
    `Task: ${task.text}`,
    ...(task.prior ? ['', task.prior] : []),
    '',
    'Rules:',
    ...targetRules(task),
    '',
    `When finished, reply via SendMessage to "${self}" with:`,
    ...STACK_REPORT,
  ].join('\n')

/** Where a task's work is, as the follow-up briefs say it. */
const where = (task: Task): string => (isTarget(task.repo) ? `Target: ${task.repo}, from ${repoPath(task.repo)}` : `Repo: ${taskDir(task)}`)

/** The rules a follow-up brief repeats. */
const sameRules = (task: Task, tests: boolean): string =>
  isTarget(task.repo)
    ? 'Same rules: the target\'s rules as first briefed, nothing destructive without a backup or the person\'s go-ahead, every change logged with how to undo it.'
    : `Same rules: local commits on the task branch, never push${tests ? ', run the relevant tests' : ''}.`

export const reworkBrief = (self: string, task: Task, findings: string): string =>
  [
    `[ORCH ${self} · task #${task.id} · round ${task.round}] Review rejected: fix and report again`,
    '',
    where(task),
    `Task: ${task.text}`,
    '',
    'Reviewer findings:',
    findings,
    '',
    `Fix every 🔴 and 🟠 finding; answer the others in SUMMARY. ${sameRules(task, false)}`,
    `Reply via SendMessage to "${self}" with STATUS / SUMMARY / CHANGES / TESTS / NEEDS, as before.`,
  ].join('\n')

/** The orchestrator's own checks failed on the reported code: back to the worker, no review round spent. */
export const checksBrief = (self: string, task: Task, failed: string, output: string): string =>
  [
    `[ORCH ${self} · task #${task.id} · round ${task.round}] Checks failed before review: fix and report again`,
    '',
    where(task),
    `Task: ${task.text}`,
    '',
    `The orchestrator ran \`${failed}\` in ${taskDir(task)} on your branch, and it failed. The end of its output:`,
    '```',
    output,
    '```',
    '',
    `Make it pass, without weakening or skipping the check. ${sameRules(task, true)}`,
    `Reply via SendMessage to "${self}" with STATUS / SUMMARY / CHANGES / TESTS / NEEDS, as before.`,
  ].join('\n')

/** The text of a follow-up task: an approved task's remaining review remarks, on top of its branch. */
export const followupText = (task: Task, note: string): string =>
  [
    `Follow-up of #${task.id}: ${firstLine(task.text)}`,
    '',
    `Address the remarks the reviewer left on #${task.id}, which was approved with them${task.branch ? `; its work is on branch ${task.branch}, build on it` : ''}:`,
    task.reviews.at(-1)?.findings || '(none recorded)',
    ...(note ? ['', `The person adds: ${note}`] : []),
    '',
    'Done when: each remark is fixed, or answered in SUMMARY when it should not be.',
  ].join('\n')

/** The person's answer to a blocked worker: the task again, with the answer, same rules. */
export const answerBrief = (self: string, task: Task, answer: string): string =>
  [
    `[ORCH ${self} · task #${task.id} · round ${task.round}] ${answer}`,
    '',
    where(task),
    `Task: ${task.text}`,
    '',
    `Go on with the task. ${sameRules(task, true)}`,
    `Reply via SendMessage to "${self}" with STATUS / SUMMARY / CHANGES / TESTS / NEEDS, as before.`,
  ].join('\n')

/**
 * What the orchestrator's own model is handed when a task is approved, so the person reads the
 * outcome in Claude's ordinary output and not only in the pane: the facts, then what to do with them.
 */
export const doneDigest = (self: string, task: Task): string => {
  const last = task.reviews.at(-1)
  return [
    `[ORCH ${self}] Task #${task.id} approved at round ${task.round} in ${task.repo}: ${firstLine(task.text)}`,
    '',
    isTarget(task.repo)
      ? `Operations on ${task.repo}, not a git repo: no branch, no commit; the changes are in the worker report.`
      : `Branch started from ${task.branchFrom || 'the repo\'s branch'} at ${task.base || '?'}; nothing was pushed.`,
    '',
    'Worker report:',
    task.report || '(none)',
    '',
    `Reviewer findings (round ${last?.round ?? task.round}):`,
    last?.findings || '(none)',
    '',
    `Write this up for the person, in their language: what was delivered and where (${isTarget(task.repo) ? 'what changed on the target and how to undo it' : 'branch, commits'}), what was tested, the reviewer's remaining remarks, and any open question in NEEDS. Report only: run no tool and change nothing.`,
  ].join('\n')
}

/**
 * The brief of a fresh session on a task whose worker is gone (the daemon stops a background
 * session after an hour without a turn): the task as first briefed, then the latest message.
 */
export const takeoverBrief = (self: string, task: Task, previous: string, latest: string): string =>
  [
    `[ORCH ${self} · task #${task.id} · round ${task.round}] You take over this task: ${previous}, the session that worked on it, is gone.`,
    isTarget(task.repo)
      ? 'Part of the work may already be done on the target: check its current state first, and carry on from there rather than starting over.'
      : `Its work may already be in ${taskDir(task)}: check the branches and the task branch's commits first, and carry on from there rather than starting over.`,
    '',
    'The task as first briefed:',
    '',
    workerBrief(self, task),
    '',
    'The latest message for this task:',
    '',
    latest,
  ].join('\n')

export const reviewBrief = (self: string, task: Task): string =>
  isTarget(task.repo) ? targetReviewBrief(self, task) : [
    `[ORCH ${self} · review task #${task.id} · round ${task.round}] ${firstLine(task.text)}`,
    '',
    `Repo: ${taskDir(task)}`,
    `Task: ${task.text}`,
    `Base: ${task.base || 'unknown'} (${task.branchFrom || 'current branch'}). Review everything since it: git -C ${taskDir(task)} log ${task.base}..HEAD, git -C ${taskDir(task)} diff ${task.base}, and any uncommitted change.`,
    ...(task.checks ? [`The orchestrator already ran the repo's checks on this code, green: ${task.checks}. Do not rerun them; spend the review on the code.`] : []),
    ...(ticketsFor(task.repo, task.text)
      ? ticketsFor(task.repo, task.text)?.reviewer ?? []
      : ['The request names no ticket key: no ticket key in the branch or commits, and the acceptance criteria are the brief\'s "Done when" list. Never raise a missing key as a finding.']),
    ...(task.isNewApp && newAppRules(task.repo).length
      ? ['This is a new app: it must meet these rules, and one not met is a 🔴 finding:', ...newAppRules(task.repo).map(line => `- ${line}`)]
      : []),
    ...(integrationFor(task.repo)
      ? [`This repo's integration suite (${integrationFor(task.repo)}) must have run green on the final code: a report whose TESTS does not show it is a 🔴 finding. Rerun it yourself when the report leaves a doubt.`]
      : []),
    '',
    'Worker report:',
    task.report,
    ...(task.reviews.length > 0
      ? ['', 'Earlier rounds\' findings (check they are fixed):', ...task.reviews.map(r => `Round ${r.round}:\n${r.findings}`)]
      : []),
    '',
    'Do not edit, commit or push anything.',
    `Reply via SendMessage to "${self}" with:`,
    'VERDICT: APPROVED | CHANGES_REQUESTED',
    'FINDINGS:',
    '- 🔴|🟠|⚪ <file:line> — <problem> — <expected fix>',
  ].join('\n')

/** A non-git target has no diff: the review checks the worker's report against the target as it is. */
const targetReviewBrief = (self: string, task: Task): string =>
  [
    `[ORCH ${self} · review task #${task.id} · round ${task.round}] ${firstLine(task.text)}`,
    '',
    `Target: ${task.repo}, ${targetOf(task.repo)?.target.about ?? 'not a git repo'}, from ${repoPath(task.repo)} (not a git repo: there is no diff, and the code-review rules do not apply).`,
    `Task: ${task.text}`,
    '',
    'Review by checking the worker\'s claims against the target itself, with read-only commands only (rerunning its checks among them): is the task\'s "Done when" met, did each change listed take effect, is anything left broken or half-done, is every change undoable as it says, and did it stay within the target\'s rules.',
    ...(targetOf(task.repo)?.target.review ?? []),
    'Raise as 🔴 a claim the target contradicts, an unmet "Done when", or a destructive change made without a backup or go-ahead; as 🟠 a change missing from the report or with no way back.',
    '',
    'Worker report:',
    task.report,
    ...(task.reviews.length > 0
      ? ['', 'Earlier rounds\' findings (check they are fixed):', ...task.reviews.map(r => `Round ${r.round}:\n${r.findings}`)]
      : []),
    '',
    'Change nothing on the target or anywhere else.',
    `Reply via SendMessage to "${self}" with:`,
    'VERDICT: APPROVED | CHANGES_REQUESTED',
    'FINDINGS:',
    '- 🔴|🟠|⚪ <what was checked> — <problem> — <expected fix>',
  ].join('\n')

// Anywhere in the text: a session often opens with `[task #n · round r] STATUS: done — …` on one line.
const STATUS = /\bSTATUS:\s*(done|blocked|failed)\b/i
const VERDICT = /\bVERDICT:\s*(APPROVED|CHANGES_REQUESTED)\b/i

const strip = (text: string): string => text.replace(/<\/?cross-session-message[^>]*>/g, '\n')

export const parseStatus = (text: string): 'done' | 'blocked' | 'failed' | null =>
  (STATUS.exec(strip(text))?.[1]?.toLowerCase() as 'done' | 'blocked' | 'failed' | undefined) ?? null

export const parseVerdict = (text: string): { isApproved: boolean; findings: string } | null => {
  const body = strip(text)
  const verdict = VERDICT.exec(body)?.[1]?.toUpperCase()
  if (!verdict) {
    return null
  }
  const findings = body.split(/^\s*FINDINGS:\s*$/im)[1]?.trim() ?? body.trim()

  return { isApproved: verdict === 'APPROVED', findings }
}

const NEEDS = /^\s*NEEDS:\s*(.+)$/im

/** The question a worker report leaves for the person, if it leaves one ("none" and the like do not count). */
export const parseNeeds = (report: string): string | null => {
  const needs = NEEDS.exec(report)?.[1]?.trim() ?? ''

  return /^(none|n\/a|nothing|-|no)\b/i.test(needs) || needs === '' ? null : needs
}

const ACTIVE: Task['state'][] = ['working', 'checking', 'reviewing', 'blocked', 'escalated']

/**
 * The next dispatches: queued tasks in order, one active task per repo, one task per
 * worker. A task gets an idle worker of its repo, role, model and effort, or `null`: launch one.
 */
/** Whether every task this one waits for is approved. */
export const isReady = (task: Task, tasks: readonly Task[]): boolean =>
  (task.after ?? []).every(id => tasks.find(t => t.id === id)?.state === 'approved')

/** A task this one waits for that will never be approved (dropped), if any. */
export const deadDependency = (task: Task, tasks: readonly Task[]): number | null =>
  (task.after ?? []).find(id => tasks.find(t => t.id === id)?.state === 'dropped') ?? null

/** What a brief says about the approved tasks this one waited for. */
export const priorNote = (task: Task, tasks: readonly Task[]): string => {
  const prior = (task.after ?? []).map(id => tasks.find(t => t.id === id)).filter((t): t is Task => t !== undefined)
  if (prior.length === 0) {
    return ''
  }
  return [
    'This task runs after these approved tasks; build on their work, do not redo it:',
    ...prior.map(t => {
      const where = isTarget(t.repo) ? `on ${t.repo}` : `on branch ${t.branch || '(see its report)'} in ${ROOT}/${t.repo}, not pushed`
      return `- #${t.id} (${t.repo}) ${firstLine(t.text)}: its work is ${where}. Its report: ${(t.report.split('\n').find(l => /^\s*SUMMARY:/i.test(l)) ?? '').trim()}`
    }),
  ].join('\n')
}

const BRANCH = /^\s*BRANCH:\s*`?([^\s`]+)`?/im

/** The task branch a worker's report names. */
export const parseBranch = (report: string): string => BRANCH.exec(report)?.[1] ?? ''

/** Writes the pull request of an approved task from what the pipeline knows of it. */
export const PR_SYSTEM = [
  'You write the pull request of a change that a developer agent made and a reviewer agent approved.',
  'Write it in English. Title: one line, 72 characters at most, the ticket key first when the task has one. Body, markdown: ## Summary (what and why, 2-4 lines), ## Changes (bullets, from the commits), ## Tests (what ran and the result, as the report says), ## Notes (the reviewer\'s remaining remarks and open questions; leave the section out when there are none).',
  'Say only what the task, report, review and commits say: never invent tests, numbers or behaviour.',
  'Reply with JSON only: {"title":"…","body":"…, newlines as \\n"}',
].join('\n')

export const prPrompt = (task: Task, commits: string): string =>
  [
    `Repo: ${task.repo}`,
    `Branch: ${task.branch} into ${task.branchFrom}`,
    `Task:\n${task.text}`,
    `Worker report:\n${task.report}`,
    `Reviewer findings (round ${task.reviews.at(-1)?.round ?? task.round}):\n${task.reviews.at(-1)?.findings || '(none)'}`,
    `Commits:\n${commits}`,
  ].join('\n\n')

/** The line every pull request body ends with. */
export const PR_FOOTER = '🤖 Generated with [Claude Code](https://claude.com/claude-code)'

export const parsePr = (reply: string): { title: string; body: string } | null => {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0]
  if (!json) {
    return null
  }
  try {
    const parsed = JSON.parse(json) as { title?: unknown; body?: unknown }
    if (typeof parsed.title !== 'string' || typeof parsed.body !== 'string' || !parsed.title.trim() || !parsed.body.trim()) {
      return null
    }
    const body = parsed.body.trim()
    return { title: firstLine(parsed.title.trim()).slice(0, 72), body: body.includes(PR_FOOTER) ? body : `${body}\n\n${PR_FOOTER}` }
  } catch {
    return null
  }
}

/**
 * The next dispatches: queued tasks in order, one task per worker. A repo runs one task in its
 * main checkout and, when its workspace allows more at once, the others in local clones (`inClone`).
 * A task gets an idle worker of its repo, role, model and effort (main checkout only), or `null`: launch one.
 */
/** Past this share of its context window, an idle worker is not given another task: a fresh session is. */
export const REUSE_CONTEXT_MAX = 0.5

export const plan = (tasks: Task[], workers: Worker[], full: ReadonlySet<string> = new Set()): { task: Task; worker: Worker | null; inClone: boolean }[] => {
  const active = tasks.filter(t => ACTIVE.includes(t.state))
  const running = new Map<string, number>()
  const mainBusy = new Set<string>()
  for (const t of active) {
    running.set(t.repo, (running.get(t.repo) ?? 0) + 1)
    if (!t.dir) {
      mainBusy.add(t.repo)
    }
  }
  const taken = new Set<string>()
  const moves: { task: Task; worker: Worker | null; inClone: boolean }[] = []

  for (const task of tasks.filter(t => t.state === 'queued')) {
    // A task waiting for another does not hold its repo: the next one of that repo may go first.
    if ((running.get(task.repo) ?? 0) >= parallelFor(task.repo) || !isReady(task, tasks)) {
      continue
    }
    const inClone = mainBusy.has(task.repo)
    const worker = inClone
      ? null
      : workers.find(
          w =>
            w.task === null &&
            !taken.has(w.name) &&
            !full.has(w.name) &&
            w.repo === task.repo &&
            w.role === task.role &&
            w.model === task.sizing.work.model &&
            w.effort === task.sizing.work.effort,
        ) ?? null
    running.set(task.repo, (running.get(task.repo) ?? 0) + 1)
    if (!inClone) {
      mainBusy.add(task.repo)
    }
    if (worker) {
      taken.add(worker.name)
    }
    moves.push({ task, worker, inClone })
  }

  return moves
}

/** The files a repo's stack is told from, at its root. */
export const STACK_MARKERS = ['composer.json', 'package.json', 'go.mod', 'Dockerfile', 'compose.yaml', 'compose.yml', 'docker-compose.yml', 'tsconfig.json'] as const

const COMPLIANCE_ROLES = ['compliance-officer', 'regulatory-compliance-writer']

/**
 * The capability cards a task's worker is pointed at: those of the repo's stack, as its marker
 * files tell it (`files`: marker → content, absent ones left out), among the cards its workspace
 * offers, plus the ones cortex loads for every role (OWASP, code comments). Paths, base first.
 */
export const capabilitiesFor = (files: Partial<Record<(typeof STACK_MARKERS)[number], string>>, role: string, index: Record<string, { files: string[] }>): string[] => {
  const composer = files['composer.json'] ?? ''
  const pkg = files['package.json'] ?? ''
  const compose = [files['compose.yaml'], files['compose.yml'], files['docker-compose.yml']].join('\n')
  const wanted = new Set(['security/owasp', 'practices/code-comments'])
  const want = (name: string, when: boolean) => when && wanted.add(name)
  want('languages/php', files['composer.json'] !== undefined)
  want('frameworks/symfony', /"symfony\//.test(composer))
  want('languages/typescript', files['tsconfig.json'] !== undefined || /"typescript"/.test(pkg))
  want('frameworks/vue', /"(vue|nuxt)"/.test(pkg))
  want('testing/e2e-testing', /"@playwright\/test"|"playwright"|"cypress"/.test(pkg))
  want('testing/component-testing', /"@vue\/test-utils"|"vitest"|"@testing-library\//.test(pkg))
  want('infrastructure/docker', files['Dockerfile'] !== undefined || compose.trim() !== '')
  want('databases/mysql', /mysql|mariadb/i.test(compose))
  want('databases/postgresql', /postgres/i.test(compose))
  want('databases/mongodb', /mongo/i.test(compose))
  want('search/opensearch', /opensearch/i.test(compose + composer + pkg))
  if (COMPLIANCE_ROLES.includes(role)) {
    Object.keys(index).filter(name => name.startsWith('compliance/')).forEach(name => wanted.add(name))
  }
  return [...wanted].filter(name => index[name]).flatMap(name => index[name]?.files ?? [])
}

/** A session name for a new worker, unique among the ones already used. */
export const workerName = (role: string, repo: string, used: string[]): string => {
  const base = `orch-${role}-${repo.split('/').pop() ?? 'repo'}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48)
  let name = base
  for (let n = 2; used.includes(name); n += 1) {
    name = `${base}-${n}`
  }

  return name
}
