import type { Setting, Sizing, Task, Worker } from '../types'
import {
  ROOT,
  allWorkspaces,
  fill,
  integrationFor,
  isKnownRole,
  isLightRole,
  isTarget,
  repoRole,
  roleFolder,
  targetNames,
  targetOf,
  ticketsFor,
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
  const [repo, ...words] = input.trim().split(/\s+/)
  const text = words.join(' ')

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

  return { text: text.replace(OVERRIDE, ' ').replace(/\s+/g, ' ').trim(), work, after: [...new Set(after)], from }
}

export const SIZING_SYSTEM = [
  'You size Claude Code sessions for an orchestrator. Each task runs in one development session, then each review round in a fresh reviewer session.',
  'Pick, for each, the cheapest model and effort that will do the job well; a failed review round costs more than a stronger first pass.',
  'Models: fable (most capable, slowest, most expensive: ambiguous design, cross-cutting or risky changes), opus (strong default for real code changes), sonnet (well-specified routine changes, docs, small fixes, light reviews). Haiku is never used.',
  `Development runs on ${WORK_FLOOR} or fable, never below ${WORK_FLOOR}: pick between those two and size the effort; the reviewer runs on ${SESSION_FLOOR}, opus or fable.`,
  'Effort: low, medium, high, xhigh, max. Raise it for subtle logic, security, data migrations, concurrency, money; lower it for mechanical work.',
  'The reviewer must be able to catch what the developer can miss: never weaker than the development on a risky task.',
  'Reply with JSON only: {"work":{"model":"…","effort":"…"},"review":{"model":"…","effort":"…"},"why":"one short sentence"}',
].join('\n')

export const sizingPrompt = (repo: string, role: string, text: string): string =>
  `Repo: ${repo}\nRole: ${role}\nTask: ${text}`

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
  'Reply with JSON only, either {"status":"ready","title":"one line, 100 characters at most, the ticket key first when there is one","brief":"the brief, markdown, newlines as \\n"} or {"status":"unclear","questions":["…"]}.',
].join('\n')

/** How a repo reads in prompts: its ticket tracker, or that it has none. */
const ticketNote = (repo: string, text = ''): string => {
  const tickets = ticketsFor(repo, text)
  return tickets ? ` (tickets: ${tickets.name})` : ' (no ticket tracker: there is no key, never ask for one)'
}

export const upgradePrompt = (repo: string, role: string, text: string): string =>
  [
    isTarget(repo)
      ? `Target: ${targetOf(repo)?.target.about ?? repo}, from ${repoPath(repo)}, which is not a git repo: operations work, no code change. Done-when checks are observable states of the target.`
      : `Repo: ${ROOT}/${repo}${ticketNote(repo, text)}`,
    `Developer role: ${role} (its role card, if any, is loaded in its session)`,
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
  `A request that needs changes in several repos becomes one task per repo, each with its own brief (at most ${MAX_ROUTED}); say in each brief what the other side does. Tasks run in parallel unless one needs another's result: then give it "after", the 0-based positions of the earlier tasks of your list it waits for (the frontend that consumes a new API field waits for the backend task).`,
  `A request on a repo with a ticket tracker and no key: do not invent one; the developer searches the tracker. A request you cannot place is not forwarded: ask instead.`,
  'Reply with JSON only, either {"status":"ready","tasks":[{"repo":"path as listed","after":[0],"title":"one line, 100 characters at most, the ticket key first when there is one","brief":"the brief, markdown, newlines as \\n"}]} or {"status":"unclear","questions":["…"]}.',
].join('\n')

export const routePrompt = (repos: readonly RepoInfo[], overview: string, role: string | null, text: string): string =>
  [
    `Targets: the git repositories under ${ROOT}${targetNames().length ? ', and the non-git targets' : ''}:`,
    ...allWorkspaces().flatMap(ws => Object.entries(ws.targets ?? {}).map(([name, t]) => `- ${name} — ${t.about}, no git`)),
    // Per repo, not per request: a key in the request says nothing of the other repos.
    ...repos.map(r => `- ${r.repo}${r.about ? ` — ${r.about}` : ''}${ticketsFor(r.repo) ? ` (tickets: ${ticketsFor(r.repo)?.name})` : ' (no ticket tracker)'}`),
    ...allWorkspaces().flatMap(ws => (ws.route ?? []).map(line => fill(line, { workspace: workspaceDir(ws) }))).map((line, i) => (i === 0 ? `\nRouting rules of the workspaces:\n- ${line}` : `- ${line}`)),
    ...(overview ? ['', 'Workspace overview:', overview] : []),
    '',
    ...(role ? [`Developer role, named by the person: ${role}`] : []),
    `Request:\n${text}`,
  ].join('\n')

export type RoutedTask = { repo: string; title: string; brief: string; after: number[] }

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
        .map(t => t as { repo?: unknown; title?: unknown; brief?: unknown; after?: unknown })
        .filter(t => typeof t.repo === 'string' && known.has(t.repo) && typeof t.brief === 'string' && t.brief.trim() !== '')
        .map((t, index) => {
          const brief = String(t.brief).trim()
          // Only earlier tasks of the same list: no cycle, and their ids exist by then.
          const after = Array.isArray(t.after) ? t.after.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < index) : []
          return { repo: String(t.repo), title: firstLine(typeof t.title === 'string' ? t.title.trim() : '') || firstLine(brief), brief, after }
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

export type Upgrade = { title: string; brief: string } | { questions: string[] }

/** Reads the upgrade JSON the orchestrator's model replied, or null when it is not one. */
export const parseUpgrade = (reply: string): Upgrade | null => {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0]
  if (!json) {
    return null
  }
  try {
    const parsed = JSON.parse(json) as { status?: string; title?: string; brief?: string; questions?: unknown }
    if (parsed.status === 'ready' && typeof parsed.title === 'string' && typeof parsed.brief === 'string' && parsed.brief.trim()) {
      return { title: firstLine(parsed.title.trim()) || firstLine(parsed.brief.trim()), brief: parsed.brief.trim() }
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

/** The workspace a task's repo or target belongs to. */
const wsOf = (repo: string) => workspaceOf(repo) ?? targetOf(repo)?.ws ?? null

/** What `--agents` takes for one worker role: the workspace's start lines point at its role cards. */
export const workerAgent = (role: string, repo = ''): string => {
  const ws = wsOf(repo)
  const values = { role, folder: roleFolder(role, repo || null), workspace: ws ? workspaceDir(ws) : ROOT }
  const prompt = [
    `You are the ${role} worker of an orchestrator session. You do the task yourself: in this session you are not the Prompt Manager and you do not dispatch.`,
    ...(ws?.roles?.worker ?? []).map(line => fill(line, values)),
    'Tasks arrive as cross-session messages from the orchestrator. One task at a time; stay inside the repo the brief names.',
    'Always finish by replying with SendMessage to the orchestrator, in the exact report format the brief asks for.',
  ].join('\n')

  return JSON.stringify({ [agentName(role)]: { description: `Orchestrator worker: ${role}`, prompt } })
}

/** What `--agents` takes for the reviewer: generic rules, then the workspace's review rules. */
export const reviewerAgent = (repo = ''): string => {
  const ws = wsOf(repo)
  const prompt = [
    'You are the code reviewer of an orchestrator session. You review; you never edit, commit, push, or comment on GitHub.',
    ...(ws?.roles?.reviewer ?? []).map(line => fill(line, { workspace: workspaceDir(ws as NonNullable<typeof ws>) })),
    'Review against the task\'s acceptance criteria and the repo\'s own conventions. Verify every finding against the code before reporting it. Approve only when no 🔴 blocking and no 🟠 major finding remains.',
    'Always finish by replying with SendMessage to the orchestrator, in the exact verdict format the brief asks for.',
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
    : `- This repo has no ticket tracker: never look for or ask for a ticket key. Branch named <type>/<short-slug> like the repo's existing branches (feat/…, fix/…, perf/…, chore/…), created from ${from} (git switch -c <branch> ${start}), never from another task's branch.`
}

/** The rules of every non-git target, before its workspace's own. */
const targetRules = (task: Task): string[] => [
  `- ${repoPath(task.repo)} is not a git repo: no branch, no commit. Act on the target as the task needs.`,
  ...(targetOf(task.repo)?.target.worker ?? []).map(line => `- ${line}`),
  '- Before anything that destroys or cannot be undone, save what it would lose first, or report STATUS: blocked and ask in NEEDS.',
  '- Keep a log of every command that changed something, and how to undo it. Check the outcome on the target before reporting.',
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
    `Repo: ${ROOT}/${task.repo} (work only there)`,
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
const where = (task: Task): string => (isTarget(task.repo) ? `Target: ${task.repo}, from ${repoPath(task.repo)}` : `Repo: ${ROOT}/${task.repo}`)

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
      : `Its work may already be in ${ROOT}/${task.repo}: check the branches and the task branch's commits first, and carry on from there rather than starting over.`,
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
    `Repo: ${ROOT}/${task.repo}`,
    `Task: ${task.text}`,
    `Base: ${task.base || 'unknown'} (${task.branchFrom || 'current branch'}). Review everything since it: git -C ${ROOT}/${task.repo} log ${task.base}..HEAD, git -C ${ROOT}/${task.repo} diff ${task.base}, and any uncommitted change.`,
    ...(ticketsFor(task.repo, task.text)
      ? ticketsFor(task.repo, task.text)?.reviewer ?? []
      : ['This repo has no ticket tracker: no ticket key in the branch or commits, and the acceptance criteria are the brief\'s "Done when" list. Never raise a missing key as a finding.']),
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

const ACTIVE: Task['state'][] = ['working', 'reviewing', 'blocked', 'escalated']

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

export const plan = (tasks: Task[], workers: Worker[]): { task: Task; worker: Worker | null }[] => {
  const busyRepos = new Set(tasks.filter(t => ACTIVE.includes(t.state)).map(t => t.repo))
  const taken = new Set<string>()
  const moves: { task: Task; worker: Worker | null }[] = []

  for (const task of tasks.filter(t => t.state === 'queued')) {
    // A task waiting for another does not hold its repo: the next one of that repo may go first.
    if (busyRepos.has(task.repo) || !isReady(task, tasks)) {
      continue
    }
    const worker =
      workers.find(
        w =>
          w.task === null &&
          !taken.has(w.name) &&
          w.repo === task.repo &&
          w.role === task.role &&
          w.model === task.sizing.work.model &&
          w.effort === task.sizing.work.effort,
      ) ?? null
    busyRepos.add(task.repo)
    if (worker) {
      taken.add(worker.name)
    }
    moves.push({ task, worker })
  }

  return moves
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
