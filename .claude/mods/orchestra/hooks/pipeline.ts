import type { Setting, Sizing, Task, Worker } from '../types'

/** Review rounds a task may fail before it is handed to the person. */
export const MAX_ROUNDS = 3

/** Every cortex role a task may name with `@role`, by its folder under agents/roles/. */
export const ROLES: Record<string, string> = {
  architect: 'engineering',
  'consultant-platform': 'engineering',
  dba: 'engineering',
  'lead-backend': 'engineering',
  'lead-frontend': 'engineering',
  'performance-engineer': 'engineering',
  'platform-engineer': 'engineering',
  'qa-automation': 'engineering',
  'support-engineer': 'engineering',
  'tech-writer': 'communication',
  'data-analyst': 'data',
  'business-analyst': 'product',
  'product-owner': 'product',
  'security-engineer': 'security-compliance',
  'compliance-officer': 'security-compliance',
}

const ROLE_BY_REPO: [RegExp, string][] = [
  [/frontend|design/i, 'lead-frontend'],
  [/e2e/i, 'qa-automation'],
  [/database/i, 'dba'],
  [/^utils\/bluspark$|iac|infra/i, 'platform-engineer'],
]

const ROLE_TAG = /(^|\s)@([a-z-]+)\b/

/** The role a task runs under: its `@role` when it names a known one, else the repo's. */
export const roleFor = (repo: string, text: string): { role: string; text: string } => {
  const named = ROLE_TAG.exec(text)?.[2]
  if (named && ROLES[named]) {
    return { role: named, text: text.replace(ROLE_TAG, ' ').trim() }
  }

  return { role: ROLE_BY_REPO.find(([pattern]) => pattern.test(repo))?.[1] ?? 'lead-backend', text }
}

/** Splits `<repo> <description>` as typed in the pane or after `/orch task`. */
export const parseTask = (input: string): { repo: string; text: string } | null => {
  const [repo, ...words] = input.trim().split(/\s+/)
  const text = words.join(' ')

  return repo && text ? { repo: repo.replace(/^\/app\//, '').replace(/\/$/, ''), text } : null
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

/** Development never runs on a model weaker than this one (the person's rule); reviews are not bound. */
export const WORK_FLOOR = 'opus'

const RANK: readonly string[] = ['haiku', 'sonnet', 'opus', 'fable']

/** The setting raised to the floor model when it is below it; effort is kept. */
export const atLeast = (setting: Setting, floor: string): Setting =>
  RANK.indexOf(setting.model) < RANK.indexOf(floor) ? { ...setting, model: floor } : setting

const LIGHT_ROLES = ['tech-writer', 'data-analyst', 'business-analyst', 'product-owner']

/** The sizing when the orchestrator's model gives none. */
export const defaultSizing = (role: string): Sizing => ({
  work: LIGHT_ROLES.includes(role) ? { model: WORK_FLOOR, effort: 'medium' } : { model: WORK_FLOOR, effort: 'high' },
  review: { model: 'opus', effort: 'high' },
  why: `default for ${role}`,
})

const OVERRIDE = /(^|\s)(model|effort):(\S+)/g

/** Pulls `model:<x>` and `effort:<y>` out of a task: they force the development's setting. */
export const parseOverrides = (text: string): { text: string; work: Partial<Setting> } => {
  const work: Partial<Setting> = {}
  for (const [, , key, value] of text.matchAll(OVERRIDE)) {
    if (key === 'model' && value && (MODELS as readonly string[]).includes(value)) {
      work.model = value
    }
    if (key === 'effort' && value && (EFFORTS as readonly string[]).includes(value)) {
      work.effort = value
    }
  }

  return { text: text.replace(OVERRIDE, ' ').replace(/\s+/g, ' ').trim(), work }
}

export const SIZING_SYSTEM = [
  'You size Claude Code sessions for an orchestrator. Each task runs in one development session, then each review round in a fresh reviewer session.',
  'Pick, for each, the cheapest model and effort that will do the job well; a failed review round costs more than a stronger first pass.',
  'Models: fable (most capable, slowest, most expensive: ambiguous design, cross-cutting or risky changes), opus (strong default for real code changes), sonnet (well-specified routine changes, docs, small fixes), haiku (trivial mechanical edits only).',
  `Development runs on ${WORK_FLOOR} or fable, never below ${WORK_FLOOR}: pick between those two and size the effort; the reviewer may use any model.`,
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

export const agentName = (role: string): string => `orch-${role}`

export const REVIEWER = 'orch-reviewer'

/** What `--agents` takes for one worker role: its prompt points at the cortex files, read at start. */
export const workerAgent = (role: string): string => {
  const folder = ROLES[role] ?? 'engineering'
  const prompt = [
    `You are the ${role} worker of a Bluspark orchestrator session. You do the task yourself: in this session you are not the Prompt Manager and you do not dispatch.`,
    `Before your first task, read /app/cortex/agents/roles/${folder}/${role}.md and, when they exist, /app/agents/roles/${folder}/${role}.md (workspace overlay), /app/agents/project-context.md, and the target repo's project-overview.md and project-context.md. Apply that role's standards.`,
    'Tasks arrive as cross-session messages from the orchestrator. One task at a time; stay inside the repo the brief names.',
    'Always finish by replying with SendMessage to the orchestrator, in the exact report format the brief asks for.',
  ].join('\n')

  return JSON.stringify({ [agentName(role)]: { description: `Orchestrator worker: ${role}`, prompt } })
}

/** What `--agents` takes for the reviewer. */
export const reviewerAgent = (): string => {
  const prompt = [
    'You are the code reviewer of a Bluspark orchestrator session. You review; you never edit, commit, push, or comment on GitHub.',
    'Apply /app/agents/workflows/engineering/code-review.md (Bluspark review rules; its cortex base too when that file exists), the conventions of /app/agents/project-context.md and of the repo\'s project-context.md, and the task\'s acceptance criteria.',
    'Verify every finding against the code before reporting it. Approve only when no 🔴 Bloquant and no 🟠 Majeur remains.',
    'Always finish by replying with SendMessage to the orchestrator, in the exact verdict format the brief asks for.',
  ].join('\n')

  return JSON.stringify({ [REVIEWER]: { description: 'Orchestrator reviewer', prompt } })
}

const firstLine = (text: string): string => (text.split('\n')[0] ?? '').slice(0, 100)

export const workerBrief = (self: string, task: Task): string =>
  [
    `[ORCH ${self} · task #${task.id} · round 1] ${firstLine(task.text)}`,
    '',
    `Repo: /app/${task.repo} (work only there)`,
    `Task: ${task.text}`,
    '',
    'Rules:',
    `- Branch named after the Jira key of the task (BLUSPARK-<n>), created from ${task.branchFrom || 'the repo\'s current branch'} (git switch -c <key> ${task.branchFrom || 'HEAD'}), never from another task's branch. No key in the task: report STATUS: blocked and ask for it.`,
    '- Commit locally with the project\'s git identity and subject format; never push.',
    '- Run the relevant tests before reporting.',
    '',
    `When finished, reply via SendMessage to "${self}" with:`,
    'STATUS: done | blocked | failed',
    'SUMMARY: <2-5 lines>',
    'CHANGES: <branch, commits>',
    'TESTS: <what ran, result>',
    'NEEDS: <decision required from the person, if any>',
  ].join('\n')

export const reworkBrief = (self: string, task: Task, findings: string): string =>
  [
    `[ORCH ${self} · task #${task.id} · round ${task.round}] Review rejected: fix and report again`,
    '',
    `Repo: /app/${task.repo}`,
    `Task: ${task.text}`,
    '',
    'Reviewer findings:',
    findings,
    '',
    'Fix every 🔴 and 🟠 finding; answer the others in SUMMARY. Same rules: local commits on the task branch, never push.',
    `Reply via SendMessage to "${self}" with STATUS / SUMMARY / CHANGES / TESTS / NEEDS, as before.`,
  ].join('\n')

export const reviewBrief = (self: string, task: Task): string =>
  [
    `[ORCH ${self} · review task #${task.id} · round ${task.round}] ${firstLine(task.text)}`,
    '',
    `Repo: /app/${task.repo}`,
    `Task: ${task.text}`,
    `Base: ${task.base || 'unknown'} (${task.branchFrom || 'current branch'}). Review everything since it: git -C /app/${task.repo} log ${task.base}..HEAD, git -C /app/${task.repo} diff ${task.base}, and any uncommitted change.`,
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

const STATUS = /^\s*STATUS:\s*(done|blocked|failed)\b/im
const VERDICT = /^\s*VERDICT:\s*(APPROVED|CHANGES_REQUESTED)\b/im

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
export const plan = (tasks: Task[], workers: Worker[]): { task: Task; worker: Worker | null }[] => {
  const busyRepos = new Set(tasks.filter(t => ACTIVE.includes(t.state)).map(t => t.repo))
  const taken = new Set<string>()
  const moves: { task: Task; worker: Worker | null }[] = []

  for (const task of tasks.filter(t => t.state === 'queued')) {
    if (busyRepos.has(task.repo)) {
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
