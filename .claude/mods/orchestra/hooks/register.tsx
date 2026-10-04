import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { RepoInfo } from './pipeline'
import type { FeedEntry, Peer, WorkerUsage, Setting, Sizing, Task, TaskState, Worker } from '../types'
import { dollars, fillBar, tokens, toUsage } from './usage'
import type { TranscriptTotals } from './usage'
import { BADGE, STATES, ago, lastFindings, ordered, reportLine, roundDots } from './view'
import { body, deliveryFailure, isAutoModeHold, oneLine, parseBackgrounded, parseInbound, parseListing } from './parse'
import {
  MAX_ROUNDS,
  MAX_ROUTED,
  ORCHESTRATOR_MODEL,
  ROUTE_SYSTEM,
  STACK,
  REVIEWER,
  SIZING_SYSTEM,
  UPGRADE_SYSTEM,
  WORK_FLOOR,
  SESSION_FLOOR,
  agentName,
  atLeast,
  defaultSizing,
  firstLine,
  parseStatus,
  parseNeeds,
  parseOverrides,
  parseSizing,
  parseRouting,
  parseTask,
  parseUpgrade,
  parseVerdict,
  plan,
  reviewBrief,
  isStack,
  routePrompt,
  reviewerAgent,
  reworkBrief,
  answerBrief,
  doneDigest,
  takeoverBrief,
  roleFor,
  sizingPrompt,
  upgradePrompt,
  workerAgent,
  workerBrief,
  workerName,
} from './pipeline'

const PANE = 'orchestra'
const PANE_BACKGROUND = 'bashMessageBackgroundColor'
const ROOT = '/app'
const REFRESH_MS = 30_000
const FEED_MAX = 300
// How long a report may trail its session's idle notice before the silence counts.
const IDLE_GRACE_MS = 20_000
const RESENT_HEADER = '[ORCH] You went idle without reporting: your brief is sent again, in full. Reply with STATUS / SUMMARY / CHANGES / TESTS / NEEDS, or VERDICT / FINDINGS for a review.'

const self = atom({ plugin: 'orchestra', key: 'self' } as const, '')
const peers = atom({ plugin: 'orchestra', key: 'peers' } as const, [] as Peer[])
const refreshedAt = atom({ plugin: 'orchestra', key: 'refreshedAt' } as const, 0)
const tasks = atom({ plugin: 'orchestra', key: 'tasks' } as const, [] as Task[])
const workers = atom({ plugin: 'orchestra', key: 'workers' } as const, [] as Worker[])
const feed = atom({ plugin: 'orchestra', key: 'feed' } as const, [] as FeedEntry[])
const selected = atom({ plugin: 'orchestra', key: 'selected' } as const, 0)
const showDone = atom({ plugin: 'orchestra', key: 'showDone' } as const, false)
const usage = atom({ plugin: 'orchestra', key: 'usage' } as const, {} as Record<string, WorkerUsage>)

const hhmm = (ms: number): string => (ms ? new Date(ms).toTimeString().slice(0, 5) : '--:--')

const setting = ({ model, effort }: Setting): string => `${model}·${effort}`

// Bumped after each new task so the field is drawn anew, empty.
let added = 0

// Every change to tasks and workers runs one after the other: reports, new tasks
// and dispatches arrive concurrently, and each reads then writes the queue.
let chain: Promise<unknown> = Promise.resolve()

function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work)
  chain = run.catch(() => undefined)

  return run
}

async function log($: EngineInterface, entry: Omit<FeedEntry, 'at'>) {
  const at = await $.clock.now()
  await update($, feed, list => [...list, { ...entry, at }].slice(-FEED_MAX))
}

async function notify($: EngineInterface, peer: string, text: string) {
  await log($, { direction: 'notice', peer, text })
  $.ui.toast(`${peer}: ${text}`.slice(0, 120))
}

async function patchTask($: EngineInterface, id: number, change: Partial<Task>) {
  const at = await $.clock.now()
  await update($, tasks, list => list.map(t => (t.id === id ? { ...t, ...change, updatedAt: at } : t)))
}

async function patchWorker($: EngineInterface, name: string, change: Partial<Worker>) {
  await update($, workers, list => list.map(w => (w.name === name ? { ...w, ...change } : w)))
}

/**
 * Reads ListAgents into `self` and `peers`; the names of the live sessions, or null when the
 * listing could not be read, in which case no session is taken for gone.
 */
async function listSessions($: EngineInterface): Promise<Set<string> | null> {
  const ran = await $.tool.call({ tool: 'ListAgents' }).catch((error: unknown) => ({ deny: String(error), result: undefined, text: undefined }))
  if (ran.deny !== undefined) {
    await log($, { direction: 'notice', peer: '-', text: `ListAgents refused: ${ran.deny}` })
    return null
  }
  const listing = (ran.result as { listing?: string } | undefined)?.listing ?? ran.text ?? ''
  const parsed = parseListing(listing)
  if (!parsed.self) {
    // Not the listing as known: better to keep every worker than to drop live ones.
    return null
  }
  const at = await $.clock.now()
  await update($, self, () => parsed.self)
  await update($, peers, () => parsed.peers)
  await update($, refreshedAt, () => at)

  return new Set(parsed.peers.map(p => p.name))
}

/** True only when the listing was read and no longer names the session. */
const isGone = (name: string, live: Set<string> | null): boolean => live !== null && !live.has(name)

async function refresh($: EngineInterface) {
  await listSessions($)
  // Best effort: usage is shown when it can be read, and never stops the rest.
  await refreshUsage($).catch(() => undefined)
}

/** Where this machine's transcripts of sessions started in ROOT live. */
async function transcriptsDir($: EngineInterface) {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  return `${config}/projects/${ROOT.replace(/[^A-Za-z0-9]/g, '-')}`
}

/**
 * Reads what the orchestrator and each of its live sessions consumed from their transcripts
 * (hooks/usage.py sums them, any size). Retired sessions keep their last reading.
 */
async function refreshUsage($: EngineInterface) {
  const dir = await transcriptsDir($)
  const files = await $.fs.list(dir).catch(() => [])
  const me = await $.session.id()
  const sessions = [
    { name: (await read($, self)) || 'orchestrator', id: me, role: 'orchestrator', task: null as number | null },
    ...(await read($, workers)).map(w => ({ name: w.name, id: w.bgId, role: w.role, task: w.task })),
  ]
  const paths = sessions
    .map(session => ({ session, file: files.find(f => f.name.startsWith(session.id) && f.name.endsWith('.jsonl'))?.name }))
    .filter((found): found is { session: (typeof sessions)[number]; file: string } => found.file !== undefined)
  if (paths.length === 0) {
    return
  }
  const ran = await exec($, ['python3', `${$.plugin.root}/hooks/usage.py`, ...paths.map(p => `${dir}/${p.file}`)])
  let totals: Record<string, TranscriptTotals> = {}
  try {
    totals = JSON.parse(ran.stdout) as Record<string, TranscriptTotals>
  } catch {
    return
  }
  const at = await $.clock.now()
  await update($, usage, all => {
    const next = { ...all }
    for (const { session, file } of paths) {
      const found = totals[`${dir}/${file}`]
      if (found) {
        next[session.name] = { ...toUsage(found, at), task: session.task, role: session.role }
      }
    }
    return next
  })
}

async function exec($: EngineInterface, argv: string[]) {
  return $.process
    .run(argv, { cwd: ROOT, env: { NO_COLOR: '1' }, timeoutMs: 60_000 })
    .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: String(error) }))
}

/**
 * Delivers a message through the model's own SendMessage tool, the one route seen to wake an
 * idle background session (a hook's `$.session.send` once reported a brief delivered that a
 * blocked worker never received). `watch` subscribes to the receiver's next idle notice, which
 * is how a session that goes quiet without reporting is caught. Resolves to the reason when
 * nothing was delivered.
 */
async function send($: EngineInterface, to: string, text: string, watch = false): Promise<string | null> {
  await log($, { direction: 'out', peer: to, text: oneLine(text) })
  const call = async () =>
    deliveryFailure(
      await $.tool
        .call({ tool: 'SendMessage', to, message: text, summary: `orchestra → ${to}`, ...(watch ? { notify_when_idle: true } : {}) })
        .catch((error: unknown) => ({ deny: String(error), isError: undefined, result: undefined, text: undefined })),
    )
  let reason = await call()
  // The classifier's own advice on a hold is to issue the call again once, as is.
  if (reason !== null && isAutoModeHold(reason)) {
    reason = await call()
  }
  if (reason !== null && isAutoModeHold(reason)) {
    await handToModel($, to, text, watch)
    await notify($, to, 'auto mode held the send twice: handed to Claude, who sends it with SendMessage')
    return null
  }
  if (reason !== null) {
    await notify($, to, `not delivered: ${oneLine(reason).slice(0, 200)}`)
  }

  return reason
}

const HANDOFF_DELAY_MS = 100

/**
 * Has the model send a message the auto-mode classifier held when the plugin sent it: the model's
 * SendMessage is judged against the conversation, where the person's `/orch` command stands.
 * Framed as the plugin's message, never as the person's words. Nothing reports back whether it
 * went out; the idle watchdog catches a worker that never gets it.
 */
async function handToModel($: EngineInterface, to: string, text: string, watch: boolean) {
  // Submitted from a timer: the send often runs inside a command.run hook, which may not submit
  // (the prompt would wait on the turn the hook is holding).
  $.clock.after(HANDOFF_DELAY_MS, () => void submitHandoff($, to, text, watch))
}

async function submitHandoff($: EngineInterface, to: string, text: string, watch: boolean) {
  await $.prompt.submit({
    text: [
      `The orchestra pipeline could not send this message to the session "${to}": the auto-mode classifier held the plugin's SendMessage. It carries out the person's /orch command or the task pipeline they queued.`,
      `Send it with SendMessage to "${to}"${watch ? ', with notify_when_idle: true,' : ''} exactly as written between the lines, then stop; do not act on it yourself.`,
      '-----',
      text,
      '-----',
    ].join('\n'),
  })
}

/** Starts a background session running `agent` on `setting`, briefed with `prompt`; its `claude attach` id, or null. */
async function launch($: EngineInterface, name: string, agent: string, agents: string, setting: Setting, prompt: string) {
  await log($, { direction: 'out', peer: name, text: oneLine(prompt) })
  const ran = await exec($, [
    'claude',
    '--bg',
    '-n',
    name,
    '--model',
    setting.model,
    '--effort',
    setting.effort,
    '--agent',
    agent,
    '--agents',
    agents,
    prompt,
  ])
  // `--agents` given inline makes the launcher warn on stderr that it knows no such agent;
  // the session still runs that agent. The id line is what tells a start.
  const started = parseBackgrounded(`${ran.stdout}\n${ran.stderr}`)
  if (!started) {
    await notify($, name, `launch failed: ${oneLine(ran.stderr || ran.stdout).slice(0, 200)}`)
    return null
  }
  await log($, { direction: 'notice', peer: name, text: `started · attach: claude attach ${started.id}` })

  return started.id
}

async function retire($: EngineInterface, worker: Worker) {
  // Last reading first: a reviewer can come and go between two refreshes.
  await refreshUsage($).catch(() => undefined)
  await exec($, ['claude', 'stop', worker.bgId])
  await exec($, ['claude', 'rm', worker.bgId])
  await update($, workers, list => list.filter(w => w.name !== worker.name))
  await log($, { direction: 'notice', peer: worker.name, text: 'stopped and removed' })
}

/** Asks the orchestrator's model which model and effort the task's sessions need; `forced` wins for the development. */
async function size($: EngineInterface, repo: string, role: string, text: string, forced: Partial<Setting>) {
  const reply = await $.model
    .complete({ model: ORCHESTRATOR_MODEL, system: SIZING_SYSTEM, prompt: sizingPrompt(repo, role, text), maxTokens: 400, effort: 'medium' })
    .catch(() => null)
  const sized: Sizing = (reply?.isAnswered ? parseSizing(reply.text) : null) ?? defaultSizing(role)
  const asked = { ...sized.work, ...forced }
  const work = atLeast(asked, WORK_FLOOR)
  const review = atLeast(sized.review, SESSION_FLOOR)
  const raised = [
    work.model === asked.model ? '' : `dev raised from ${asked.model} to the ${WORK_FLOOR} floor`,
    review.model === sized.review.model ? '' : `review raised from ${sized.review.model} to the ${SESSION_FLOOR} floor`,
  ].filter(Boolean)
  const why = raised.length > 0 ? `${sized.why} (${raised.join('; ')})` : sized.why

  return { work, review, why }
}

/** What a typed task holds: `<repo> <description> [@role] [model:… effort:…]`. */
type Input = { repo: string; role: string; text: string; work: Partial<Setting> }

const parseInput = (input: string): Input | null => {
  const parsed = parseTask(input)
  if (!parsed) {
    return null
  }
  const overrides = parseOverrides(parsed.text)
  const { role, text } = roleFor(parsed.repo, overrides.text)

  return { repo: parsed.repo, role, text, work: overrides.work }
}

async function queueTask($: EngineInterface, { repo, role, text, work }: Input) {
  const sizing = await size($, repo, role, text, work)
  const at = await $.clock.now()
  const list = await read($, tasks)
  const id = list.reduce((max, t) => Math.max(max, t.id), 0) + 1
  const task: Task = {
    id,
    repo,
    role,
    text,
    state: 'queued',
    round: 1,
    worker: '',
    reviewer: '',
    base: '',
    report: '',
    branchFrom: '',
    sizing,
    reviews: [],
    updatedAt: at,
  }
  added += 1
  await update($, tasks, all => [...all, task])
  await log($, {
    direction: 'notice',
    peer: `#${id}`,
    text: `queued for ${role} in ${repo} · dev ${setting(sizing.work)} · review ${setting(sizing.review)} · ${sizing.why}`,
  })
  await dispatch($)

  return id
}

async function addTask($: EngineInterface, input: string) {
  const parsed = parseInput(input)
  if (!parsed) {
    $.ui.toast('Usage: <repo> <description> [@role]')
    return
  }
  await queueTask($, parsed)
}

/**
 * `/orch prompt`: the orchestrator's model, as Prompt Manager, rewrites the request into a brief
 * (objective, context, task, constraints, done-when) before it is queued; a request it cannot
 * make sense of comes back as questions, and nothing is queued.
 */
async function upgradeTask($: EngineInterface, input: string): Promise<string> {
  const repos = await listRepos($)
  const first = parseTask(input)?.repo
  // A request that does not start with a repo of the workspace is routed: the model picks where.
  if (repos.length > 0 && !isStack(first ?? '') && !repos.some(r => r.repo === first)) {
    return routeTask($, input, repos)
  }
  const parsed = parseInput(input)
  if (!parsed) {
    return 'Usage: /orch prompt [<repo>] <request> [@role] [model:… effort:…]'
  }
  const reply = await $.model
    .complete({ model: ORCHESTRATOR_MODEL, system: UPGRADE_SYSTEM, prompt: upgradePrompt(parsed.repo, parsed.role, parsed.text), maxTokens: 2000, effort: 'high' })
    .catch(() => null)
  const upgrade = reply?.isAnswered ? parseUpgrade(reply.text) : null
  if (!upgrade) {
    await log($, { direction: 'notice', peer: 'prompt', text: `no usable brief from ${ORCHESTRATOR_MODEL}; nothing queued` })
    return `The orchestrator model gave no usable brief; nothing queued. Retry, or queue it as typed with /orch task.`
  }
  if ('questions' in upgrade) {
    await log($, { direction: 'notice', peer: 'prompt', text: `unclear request, ${upgrade.questions.length} question(s) for you; nothing queued` })
    return ['Not queued: the request needs settling first.', ...upgrade.questions.map(q => `- ${q}`), '', 'Answer in a new /orch prompt.'].join('\n')
  }
  const text = `${upgrade.title}\n\n${upgrade.brief}`
  const id = await queueTask($, { ...parsed, text })
  await log($, { direction: 'notice', peer: `#${id}`, text: `brief written by the Prompt Manager from: ${oneLine(parsed.text)}` })

  return [`Task #${id} queued in ${parsed.repo} for ${parsed.role} with this brief:`, '', text].join('\n')
}

/** The git repositories under the workspace root, with a line on each (hooks/repos.py); empty when unreadable. */
async function listRepos($: EngineInterface): Promise<RepoInfo[]> {
  const ran = await exec($, ['python3', `${$.plugin.root}/hooks/repos.py`, ROOT])
  try {
    const list = JSON.parse(ran.stdout) as unknown
    return Array.isArray(list) ? list.filter((r): r is RepoInfo => typeof r?.repo === 'string').map(r => ({ repo: r.repo, about: String(r.about ?? '') })) : []
  } catch {
    return []
  }
}

/** The workspace overview the router reads beside the repo list: the team's file, then the developer's. */
async function workspaceOverview($: EngineInterface): Promise<string> {
  const parts: string[] = []
  for (const path of [`${ROOT}/agents/project-overview.md`, `${ROOT}/project-overview.md`]) {
    const text = await $.fs.read(path).catch(() => '')
    // The developer's file is often the untouched template: only its filled-in lines tell anything.
    if (text.trim() && !/\[Project \/ service name\]/.test(text)) {
      parts.push(text.slice(0, 8000))
    }
  }
  return parts.join('\n\n')
}

/**
 * `/orch prompt <request>` without a repo: the Prompt Manager picks the repo (or one per repo
 * when the change spans several) and writes each brief; nothing is queued when it cannot tell.
 */
async function routeTask($: EngineInterface, input: string, repos: RepoInfo[]): Promise<string> {
  const overrides = parseOverrides(input.trim())
  const named = roleFor('', overrides.text)
  const role = named.text !== overrides.text ? named.role : null
  const request = named.text
  const reply = await $.model
    .complete({ model: ORCHESTRATOR_MODEL, system: ROUTE_SYSTEM, prompt: routePrompt(repos, await workspaceOverview($), role, request), maxTokens: 4000, effort: 'high' })
    .catch(() => null)
  const routed = reply?.isAnswered ? parseRouting(reply.text, repos) : null
  if (!routed) {
    await log($, { direction: 'notice', peer: 'prompt', text: `no usable routing from ${ORCHESTRATOR_MODEL}; nothing queued` })
    return `The orchestrator model could not place the request in a repo; nothing queued. Retry, or name the repo: /orch prompt <repo> <request>.`
  }
  if ('questions' in routed) {
    await log($, { direction: 'notice', peer: 'prompt', text: `request not placed, ${routed.questions.length} question(s) for you; nothing queued` })
    return ['Not queued: the request needs settling first.', ...routed.questions.map(q => `- ${q}`), '', 'Answer in a new /orch prompt, or name the repo: /orch prompt <repo> <request>.'].join('\n')
  }
  const answers: string[] = []
  for (const { repo, title, brief } of routed.tasks) {
    const text = `${title}\n\n${brief}`
    const taskRole = role ?? roleFor(repo, '').role
    const id = await queueTask($, { repo, role: taskRole, text, work: overrides.work })
    await log($, { direction: 'notice', peer: `#${id}`, text: `routed to ${repo} by the Prompt Manager from: ${oneLine(request)}` })
    answers.push([`Task #${id} queued in ${repo} for ${taskRole} with this brief:`, '', text].join('\n'))
  }
  if (routed.tasks.length === MAX_ROUTED) {
    answers.push(`(${MAX_ROUTED} tasks at most per request.)`)
  }

  return answers.join('\n\n')
}

/** Gives every queued task that can start a worker: an idle one of its repo and role, or a new session. */
async function dispatch($: EngineInterface) {
  // An idle session the daemon has stopped since (it does after an hour without a turn) stays
  // in the list; it is forgotten here, so plan() never hands a task to it.
  const live = await listSessions($)
  for (const gone of (await read($, workers)).filter(w => w.task === null && isGone(w.name, live))) {
    await retire($, gone)
  }
  const me = await read($, self)
  for (const { task, worker } of plan(await read($, tasks), await read($, workers))) {
    // Every task of a repo branches from where the repo stood at its first task, not from
    // whatever task branch the previous worker left checked out.
    // The stack is not a repo: operations work has no branch and no base.
    const git = (...args: string[]) => exec($, ['git', '-C', `${ROOT}/${task.repo}`, ...args])
    const branchFrom = isStack(task.repo)
      ? ''
      : ((await read($, tasks)).find(t => t.repo === task.repo && t.branchFrom)?.branchFrom ??
        (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim())
    const head = isStack(task.repo) ? { exitCode: 0, stdout: '' } : await git('rev-parse', branchFrom || 'HEAD')
    if (head.exitCode !== 0) {
      await patchTask($, task.id, { state: 'blocked', report: `not a git repo: ${ROOT}/${task.repo}` })
      await notify($, `#${task.id}`, `blocked: ${ROOT}/${task.repo} is not a git repository (use "${STACK}" for work on the running stack)`)
      continue
    }
    const started: Task = { ...task, state: 'working', branchFrom, base: head.stdout.trim() }
    const brief = workerBrief(me, started)

    if (worker) {
      await patchTask($, task.id, { state: 'working', branchFrom, base: started.base, worker: worker.name })
      await patchWorker($, worker.name, { task: task.id, brief, nudges: 0 })
      if ((await send($, worker.name, brief, true)) === null) {
        continue
      }
      // Not delivered after all: that session cannot take the task, a fresh one does.
      await retire($, worker)
    }

    // One session per repo: an idle one set up for another role, model or effort makes room.
    for (const idle of (await read($, workers)).filter(w => w.task === null && w.repo === task.repo)) {
      await retire($, idle)
    }
    const used = (await read($, workers)).map(w => w.name).concat((await read($, peers)).map(p => p.name))
    const name = workerName(task.role, task.repo, used)
    const { work } = task.sizing
    const bgId = await launch($, name, agentName(task.role), workerAgent(task.role), work, brief)
    if (!bgId) {
      await patchTask($, task.id, { state: 'blocked', report: 'worker launch failed' })
      continue
    }
    await update($, workers, list => [...list, { name, bgId, repo: task.repo, role: task.role, ...work, task: task.id, brief, nudges: 0 }])
    await patchTask($, task.id, { state: 'working', branchFrom, base: started.base, worker: name })
    // The brief went with the launch; the idle subscription alone goes now.
    await subscribeIdle($, name)
  }
}

/** Subscribes to a session's next idle notice without sending it anything. */
async function subscribeIdle($: EngineInterface, name: string) {
  // An empty message is the tool's own spelling of "subscribe only".
  await $.tool.call({ tool: 'SendMessage', to: name, message: '', notify_when_idle: true }).catch(() => undefined)
}

async function startReview($: EngineInterface, task: Task) {
  const me = await read($, self)
  const name = `orch-review-${task.id}-r${task.round}`
  // Also for a task sized before the floor existed.
  const review = atLeast(task.sizing.review, SESSION_FLOOR)
  const brief = reviewBrief(me, task)
  const bgId = await launch($, name, REVIEWER, reviewerAgent(), review, brief)
  if (!bgId) {
    await patchTask($, task.id, { state: 'blocked', report: 'reviewer launch failed' })
    return
  }
  await update($, workers, list => [...list, { name, bgId, repo: task.repo, role: 'reviewer', ...review, task: task.id, brief, nudges: 0 }])
  await patchTask($, task.id, { state: 'reviewing', reviewer: name })
  await subscribeIdle($, name)
}

async function onWorkerReport($: EngineInterface, worker: Worker, text: string) {
  const task = (await read($, tasks)).find(t => t.id === worker.task)
  const status = parseStatus(text)
  // A blocked task's worker that reports again was unblocked outside the pipeline (the person
  // messaged it directly, or a send the plugin could not make went out another way): take it.
  if (!task || (task.state !== 'working' && task.state !== 'blocked') || task.worker !== worker.name) {
    return
  }
  if (!status) {
    await notify($, `#${task.id}`, `report from ${worker.name} without a STATUS line, ignored`)
    return
  }
  if (task.state === 'blocked') {
    await notify($, `#${task.id}`, `${worker.name} reported ${status} on a blocked task: taken as unblocked`)
  }
  if (status === 'done') {
    const reported = { ...task, report: body(text) }
    await patchTask($, task.id, { report: reported.report })
    await startReview($, reported)
    return
  }
  await patchTask($, task.id, { state: 'blocked', report: body(text) })
  await notify($, `#${task.id}`, `${status}: needs you (/orch retry ${task.id} <answer> or /orch drop ${task.id})`)
}

/** Moves the task on a verdict; on approval, answers the digest the model is handed. */
async function onReviewerReport($: EngineInterface, reviewer: Worker, text: string): Promise<string | undefined> {
  const task = (await read($, tasks)).find(t => t.id === reviewer.task)
  const verdict = parseVerdict(text)
  if (!task || task.state !== 'reviewing') {
    return
  }
  if (!verdict) {
    await notify($, `#${task.id}`, `report from ${reviewer.name} without a VERDICT line, ignored`)
    return
  }
  await retire($, reviewer)
  const reviews = [...task.reviews, { round: task.round, ...verdict }]

  if (verdict.isApproved) {
    await patchTask($, task.id, { state: 'approved', reviews })
    await patchWorker($, task.worker, { task: null })
    const needs = parseNeeds(task.report)
    await notify($, `#${task.id}`, needs ? `approved at round ${task.round}; open question for you: ${needs}` : `approved at round ${task.round}`)
    await dispatch($)
    return doneDigest(await read($, self), { ...task, reviews })
  }
  if (task.round >= MAX_ROUNDS) {
    await patchTask($, task.id, { state: 'escalated', reviews })
    await notify($, `#${task.id}`, `rejected ${MAX_ROUNDS} times: your call (/orch retry ${task.id} <note> or /orch drop ${task.id})`)
    return
  }
  const next = { ...task, round: task.round + 1, reviews }
  await patchTask($, task.id, { state: 'working', round: next.round, reviews, reviewer: '' })
  const { reason } = await briefWorker($, next, reworkBrief(await read($, self), next, verdict.findings))
  if (reason !== null) {
    await patchTask($, task.id, { state: 'blocked', report: blockedReport(`the review's findings reached no worker: ${reason}`) })
    await notify($, `#${task.id}`, `blocked: the review's findings reached no worker (${reason})`)
  }
}

/** A report the pane reads for a task the orchestrator itself had to stop. */
const blockedReport = (why: string): string =>
  `STATUS: blocked\nSUMMARY: ${why}\nNEEDS: /orch retry to try again, or /orch drop`

/** Who holds a task after a brief, whether that is a fresh session, and why nothing reached anyone. */
type Briefed = { worker: string; isFresh: boolean; reason: string | null }

/**
 * Hands a task's worker its next brief. A worker whose session is gone is replaced by a fresh
 * session, briefed in full: the task as first briefed, then this brief.
 */
async function briefWorker($: EngineInterface, task: Task, text: string): Promise<Briefed> {
  if (!isGone(task.worker, await listSessions($))) {
    const reason = await sendBrief($, task.worker, text)
    // A failed send to a session still listed is a refusal: said as is, no replacement.
    if (reason === null || !isGone(task.worker, await listSessions($))) {
      return { worker: task.worker, isFresh: false, reason }
    }
  }

  return replaceWorker($, task, text)
}

/** Starts a fresh session on a task whose worker is gone; the gone one is removed. The new one may take its name. */
async function replaceWorker($: EngineInterface, task: Task, text: string): Promise<Briefed> {
  const previous = (await read($, workers)).find(w => w.name === task.worker)
  if (previous) {
    await retire($, previous)
  }
  await notify($, `#${task.id}`, `${task.worker} is gone; a fresh session takes the task over`)
  const used = (await read($, workers)).map(w => w.name).concat((await read($, peers)).map(p => p.name))
  const name = workerName(task.role, task.repo, used)
  const { work } = task.sizing
  const brief = takeoverBrief(await read($, self), task, task.worker, text)
  const bgId = await launch($, name, agentName(task.role), workerAgent(task.role), work, brief)
  if (!bgId) {
    return { worker: task.worker, isFresh: false, reason: `${task.worker} is gone and no new session could be launched` }
  }
  await update($, workers, list => [...list, { name, bgId, repo: task.repo, role: task.role, ...work, task: task.id, brief, nudges: 0 }])
  await patchTask($, task.id, { worker: name })
  await subscribeIdle($, name)

  return { worker: name, isFresh: true, reason: null }
}

/** Sends a worker its (new) brief, kept for a resend, with the idle subscription. */
async function sendBrief($: EngineInterface, name: string, text: string): Promise<string | null> {
  await patchWorker($, name, { brief: text, nudges: 0 })
  return send($, name, text, true)
}

/** The person's answer to a blocked or escalated task: back to its worker, an escalated one with fresh rounds. */
async function retryTask($: EngineInterface, id: number, note: string): Promise<string> {
  const task = (await read($, tasks)).find(t => t.id === id)
  if (!task || (task.state !== 'blocked' && task.state !== 'escalated')) {
    const why = task ? `it is ${task.state}, not waiting for you` : 'no such task'
    $.ui.toast(`Task #${id}: ${why}.`)
    return `Task #${id} not sent back: ${why}.`
  }
  if (!task.worker) {
    // Blocked before any worker took it (no repo, launch failed): queue it again.
    await patchTask($, id, { state: 'queued', report: '' })
    await dispatch($)
    return `Task #${id} queued again.`
  }
  const findings = task.reviews.at(-1)?.findings ?? ''
  const next = { ...task, round: task.state === 'escalated' ? 1 : task.round }
  const answer = note ? `The person answered: ${note}` : 'The person asks you to continue.'
  const text =
    task.state === 'escalated'
      ? reworkBrief(await read($, self), next, [answer, findings].filter(Boolean).join('\n\n'))
      : answerBrief(await read($, self), next, answer)
  await patchTask($, id, { state: 'working', round: next.round })
  const { worker, isFresh, reason } = await briefWorker($, next, text)
  if (reason !== null) {
    await patchTask($, id, { state: task.state })
    return `Task #${id} not sent back to ${task.worker}: ${reason}`
  }

  return isFresh
    ? `Task #${id} handed to a fresh session, ${worker}, briefed in full: the previous one was gone.`
    : `Task #${id} sent back to ${worker}.`
}

async function dropTask($: EngineInterface, id: number) {
  const task = (await read($, tasks)).find(t => t.id === id)
  if (!task || task.state === 'approved' || task.state === 'dropped') {
    $.ui.toast(`Task #${id} cannot be dropped.`)
    return
  }
  for (const reviewer of (await read($, workers)).filter(w => w.role === 'reviewer' && w.task === id)) {
    await retire($, reviewer)
  }
  await patchTask($, id, { state: 'dropped' })
  if (task.worker) {
    await patchWorker($, task.worker, { task: null })
  }
  await dispatch($)
}

async function stopIdleWorkers($: EngineInterface) {
  for (const worker of (await read($, workers)).filter(w => w.task === null)) {
    await retire($, worker)
  }
}

/**
 * Logs a delivery and moves the pipeline on. `isOwn`: it came from one of the orchestrator's own
 * sessions, so the model has nothing to do with it; `digest`: a task just ended, and this is
 * what the model is handed instead, so the outcome shows in Claude's ordinary output.
 */
async function onReceive($: EngineInterface, text: string): Promise<{ isOwn: boolean; digest?: string }> {
  const inbound = parseInbound(text)
  if (inbound.isIdleNotice) {
    await log($, { direction: 'notice', peer: inbound.peer, text: 'is idle now' })
    const isOwn = (await read($, workers)).some(w => w.name === inbound.peer)
    if (isOwn) {
      // Its report, sent just before the turn ended, may still be on its way: look again later.
      $.clock.after(IDLE_GRACE_MS, () => void serial(() => onIdleWithoutReport($, inbound.peer)))
    }
    return { isOwn }
  }
  await log($, { direction: 'in', peer: inbound.peer, text: oneLine(text) })
  const sender = (await read($, workers)).find(w => w.name === inbound.peer)
  if (sender?.role === 'reviewer') {
    return { isOwn: true, digest: await onReviewerReport($, sender, text) }
  }
  if (sender) {
    await onWorkerReport($, sender, text)
  }

  return { isOwn: sender !== undefined }
}

/**
 * A session of ours went idle and its task still awaits its report: the brief never reached it,
 * or it stopped without reporting. Its brief goes again once; a second silence is for the person.
 */
async function onIdleWithoutReport($: EngineInterface, name: string) {
  const worker = (await read($, workers)).find(w => w.name === name)
  const task = worker && (await read($, tasks)).find(t => t.id === worker.task)
  const awaited = worker?.role === 'reviewer' ? 'reviewing' : 'working'
  if (!worker || !task || task.state !== awaited || !worker.brief) {
    return
  }
  if ((worker.nudges ?? 0) >= 1) {
    await patchTask($, task.id, {
      state: 'blocked',
      report: `STATUS: blocked\nSUMMARY: ${name} went idle twice without reporting, its brief sent again once.\nNEEDS: retry to send the brief a third time, or drop the task`,
    })
    await notify($, `#${task.id}`, `${name} idle twice without a report: your call (/orch retry ${task.id} <note> or /orch drop ${task.id})`)
    return
  }
  await patchWorker($, name, { nudges: (worker.nudges ?? 0) + 1 })
  await notify($, `#${task.id}`, `${name} went idle without reporting; its brief is sent again`)
  const reason = await send($, name, `${RESENT_HEADER}\n\n${worker.brief}`, true)
  if (reason !== null) {
    await patchTask($, task.id, { state: 'blocked', report: blockedReport(`${name} went idle without reporting and its brief could not be sent again: ${reason}`) })
  }
}

async function runCommand($: EngineInterface, args: string) {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const id = Number(rest[0])
  switch (verb) {
    case '':
      return 'Orchestra pane opened.'
    case 'task': {
      // Several tasks in one go: `/orch task <repo> <text> ;; <repo> <text>`.
      const batch = rest.join(' ').split(/\s;;\s/).filter(part => part.trim())
      for (const part of batch) {
        await serial(() => addTask($, part))
      }
      return batch.length === 1 ? 'Task queued.' : `${batch.length} tasks queued.`
    }
    case 'prompt': {
      // Same batching as `task`; each request is rewritten by the model before it is queued.
      const batch = rest.join(' ').split(/\s;;\s/).filter(part => part.trim())
      if (batch.length === 0) {
        return 'Usage: /orch prompt [<repo>] <request> [@role] [model:… effort:…] [;; [<repo>] <request>…]'
      }
      const answers: string[] = []
      for (const part of batch) {
        answers.push(await serial(() => upgradeTask($, part)))
      }
      return answers.join('\n\n')
    }
    case 'retry':
      return serial(() => retryTask($, id, rest.slice(1).join(' ')))
    case 'drop':
      await serial(() => dropTask($, id))
      return `Task #${id} dropped.`
    case 'stop-idle':
      await serial(() => stopIdleWorkers($))
      return 'Idle workers stopped.'
    default:
      if (rest.length === 0) {
        return 'Usage: /orch [task <repo> <description> [@role] [;; …] | prompt [<repo>] <request> [@role] [;; …] | retry <id> [note] | drop <id> | stop-idle | <session> <message>]'
      }
      const known = [...(await read($, peers)).map(p => p.name), ...(await read($, workers)).map(w => w.name)]
      if (!known.includes(verb)) {
        return `No session named "${verb}" (known: ${known.join(', ') || 'none'}). Usage: /orch <session> <message>.`
      }
      const reason = await send($, verb, rest.join(' '))
      return reason === null ? `Sent to ${verb}.` : `Not delivered to ${verb}: ${reason}`
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'orch',
      description: 'Orchestra: `task <repo> <description> [@role]`, `prompt [<repo>] <request> [@role]` (brief written by the model first; without a repo it picks the repo; `stack` = the running stack, no git), `retry <id> [note]`, `drop <id>`, `stop-idle`, `<session> <message>`',
    })
    $.clock.every(REFRESH_MS, () => void refresh($))
    void refresh($)

    return next(e)
  })

  on('command.run', { command: 'orch' }, async ($, e) => {
    await refresh($)
    const text = await runCommand($, e.args)
    await $.ui.open({ id: PANE, title: 'Orchestra', focus: true })

    return { text }
  })

  // A peer's message arrives through one of two doors: a local session's as a submitted
  // prompt (origin peer), a relayed one through session.receive. Both feed the pipeline,
  // and its own sessions' reports are kept from the model, which would act on them twice.
  // A report only moves a task in the state that awaits it, so one seen twice moves nothing.
  // An approved task's digest goes on to the model in the report's place: the person then reads
  // the outcome in Claude's own output, not only in the pane.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    if (kind !== 'peer' && kind !== 'peer-send-message') {
      return next(e)
    }
    const { isOwn, digest } = await serial(() => onReceive($, e.text))
    if (digest) {
      return next({ ...e, text: digest })
    }

    return isOwn ? { drop: `orchestra: ${parseInbound(e.text).peer} report handled by the pipeline` } : next(e)
  })

  on('session.receive', async ($, e, next) => {
    const isPeer = e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message'
    const inbound = parseInbound(e.text)
    if (!isPeer && !inbound.isIdleNotice && inbound.peer === '?') {
      return next(e)
    }
    const { isOwn, digest } = await serial(() => onReceive($, e.text))
    if (digest) {
      return next({ ...e, text: digest })
    }

    return isOwn ? { consumed: 'orchestra: report handled by the pipeline' } : next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const now = await $.clock.now()
    const me = await read($, self)
    const all = await read($, tasks)
    const workerList = await read($, workers)
    const others = (await read($, peers)).filter(p => !workerList.some(w => w.name === p.name))
    const entries = await read($, feed)
    const isDoneShown = await read($, showDone)
    const count = (state: TaskState) => all.filter(t => t.state === state).length
    const needYou = count('blocked') + count('escalated')
    const shown = ordered(all).filter(t => t.state !== 'dropped' && (isDoneShown || t.state !== 'approved'))
    const chosenId = await read($, selected)
    const chosen = all.find(t => t.id === chosenId) ?? shown[0]
    const rows = Math.max(30, e.viewport?.rows ?? 40)
    const used = await read($, usage)
    const totalCost = Object.values(used).reduce((sum, u) => sum + u.cost, 0)
    const taskCost = (task: Task) =>
      Object.entries(used)
        .filter(([name]) => name === task.worker || name.startsWith(`orch-review-${task.id}-`))
        .reduce((sum, [, u]) => sum + u.cost, 0)
    const retired = Object.entries(used).filter(
      ([name, u]) => u.role !== 'orchestrator' && !workerList.some(w => w.name === name),
    )

    const Section = ({ title, right, children }: { title: string; right?: string; children?: RenderChildren }) => (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={0}>
        <Box justifyContent="space-between">
          <Text bold color="white">
            {title}
          </Text>
          {right ? <Text dimColor>{right}</Text> : <Text> </Text>}
        </Box>
        {children}
      </Box>
    )

    const header = (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color="cyan">
            ◆ ORCHESTRA
          </Text>
          <Text dimColor>
            {me || '?'} · {ORCHESTRATOR_MODEL} · <Text color="green">Σ {dollars(totalCost)}</Text> est. · ⟳{' '}
            {hhmm(await read($, refreshedAt))}
          </Text>
        </Box>
        <Box gap={2} flexWrap="wrap">
          {STATES.map(state => (
            <Text color={count(state) > 0 ? BADGE[state].color : 'gray'} dimColor={count(state) === 0}>
              {BADGE[state].icon} {count(state)} {BADGE[state].label}
            </Text>
          ))}
        </Box>
        {needYou > 0 && (
          <Text color="red" bold>
            ⚠ {needYou} task{needYou === 1 ? ' needs' : 's need'} your decision
          </Text>
        )}
      </Box>
    )

    const taskRows = shown.map((task, index) => {
      const badge = BADGE[task.state]
      const isChosen = chosen?.id === task.id
      return (
        <Box key={`task-${task.id}`} flexDirection="column">
          <Box>
            <Text color="cyan">{isChosen ? '▸ ' : '  '}</Text>
            <Button
              key={`pick-${task.id}`}
              label={`#${task.id}`}
              hotkey={index < 9 ? String(index + 1) : undefined}
              plain
              onPress={() => void update($, selected, () => task.id)}
            />
            <Text> </Text>
            <Box key={`state-${task.id}`} width={12} flexShrink={0}>
              <Text color={badge.color} bold={task.state === 'escalated'}>
                {badge.icon} {badge.label}
              </Text>
            </Box>
            <Box width={5} flexShrink={0}>
              <Text color={task.round > 1 ? 'yellow' : 'gray'}>{roundDots(task)}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text wrap="truncate-end">
                {task.repo.split('/').pop()} <Text dimColor>{task.role}</Text>
              </Text>
            </Box>
            <Text dimColor> {ago(task.updatedAt, now)}</Text>
          </Box>
          <Box paddingLeft={4}>
            <Box flexShrink={0} marginRight={1}>
              <Text color="magenta">{setting(task.sizing.work)}</Text>
              <Text dimColor> → </Text>
              <Text color="blue">{setting(task.sizing.review)}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text wrap="truncate-end" dimColor={!isChosen}>
                {firstLine(task.text)}
              </Text>
            </Box>
          </Box>
        </Box>
      )
    })

    const detail = chosen && (
      <Section title={`#${chosen.id} · ${chosen.repo}`} right={`${BADGE[chosen.state].icon} ${BADGE[chosen.state].label} · round ${chosen.round}/${MAX_ROUNDS}`}>
        <Text wrap="wrap">{chosen.text}</Text>
        <Text dimColor wrap="truncate-end">
          {chosen.role} · dev {setting(chosen.sizing.work)} · review {setting(chosen.sizing.review)}
          {chosen.sizing.why ? ` · ${chosen.sizing.why}` : ''}
        </Text>
        {taskCost(chosen) > 0 && (
          <Text dimColor>
            cost ≈ <Text color="green">{dollars(taskCost(chosen))}</Text> (its sessions, estimated at API rates)
          </Text>
        )}
        {chosen.worker && (
          <Text dimColor wrap="truncate-end">
            worker {chosen.worker}
            {chosen.reviewer ? ` · reviewer ${chosen.reviewer}` : ''}
            {chosen.base ? ` · base ${chosen.base.slice(0, 7)}` : ''}
          </Text>
        )}
        {reportLine(chosen.report, 'SUMMARY') && (
          <Text wrap="wrap">
            <Text color="green">▌ </Text>
            {reportLine(chosen.report, 'SUMMARY')}
          </Text>
        )}
        {reportLine(chosen.report, 'TESTS') && (
          <Text wrap="truncate-end" dimColor>
            tests: {reportLine(chosen.report, 'TESTS')}
          </Text>
        )}
        {lastFindings(chosen)
          .slice(0, 5)
          .map(line => (
            <Text wrap="truncate-end" color={line.includes('🔴') ? 'red' : line.includes('🟠') ? 'yellow' : undefined}>
              {line}
            </Text>
          ))}
        {parseNeeds(chosen.report) && (
          <Text color="magenta" wrap="wrap">
            ? {parseNeeds(chosen.report)}
          </Text>
        )}
        {(chosen.state === 'blocked' || chosen.state === 'escalated') && (
          <Box gap={1} marginTop={1}>
            <Button key={`retry-${chosen.id}`} label="retry" hotkey="y" variant="primary" onPress={() => void serial(() => retryTask($, chosen.id, ''))} />
            <Button key={`drop-${chosen.id}`} label="drop" hotkey="d" onPress={() => void serial(() => dropTask($, chosen.id))} />
            <Text dimColor>or /orch retry {chosen.id} {'<answer>'}</Text>
          </Box>
        )}
      </Section>
    )

    const UsageCells = ({ name, isIdle }: { name: string; isIdle?: boolean }) => {
      const u = used[name]
      return u ? (
        <Box flexShrink={0}>
          <Box width={11}>
            <Text color={u.context / u.window > 0.8 ? 'red' : u.context / u.window > 0.5 ? 'yellow' : 'green'} dimColor={isIdle}>
              {fillBar(u.context, u.window)}
            </Text>
          </Box>
          <Box width={8}>
            <Text dimColor>{tokens(u.tokens)}</Text>
          </Box>
          <Box width={8}>
            <Text color="green" dimColor={isIdle}>
              {u.isPriced ? dollars(u.cost) : '$?'}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box width={27} flexShrink={0}>
          <Text dimColor>reading…</Text>
        </Box>
      )
    }

    // Column labels on their own row, with the same widths as the cells, so they sit above their data.
    const sessionColumns = (
      <Box key="worker-columns">
        <Box width={2} flexShrink={0} />
        <Box flexGrow={1}>
          <Text dimColor>session</Text>
        </Box>
        <Box width={14} flexShrink={0}>
          <Text dimColor>model</Text>
        </Box>
        <Box width={10} flexShrink={0}>
          <Text dimColor>status</Text>
        </Box>
        <Box width={11} flexShrink={0}>
          <Text dimColor>context</Text>
        </Box>
        <Box width={8} flexShrink={0}>
          <Text dimColor>tokens</Text>
        </Box>
        <Box width={8} flexShrink={0}>
          <Text dimColor>est. $</Text>
        </Box>
      </Box>
    )

    const orchestratorRow = (
      <Box key="worker-self">
        <Text color="cyan">◆ </Text>
        <Box flexGrow={1}>
          <Text wrap="truncate-end">{me || 'orchestrator'}</Text>
        </Box>
        <Box width={14} flexShrink={0}>
          <Text color="magenta">{ORCHESTRATOR_MODEL}</Text>
        </Box>
        <Box width={10} flexShrink={0}>
          <Text dimColor>orchestr.</Text>
        </Box>
        <UsageCells name={me || 'orchestrator'} />
      </Box>
    )

    const workerRows = workerList.map(worker => {
      const isIdle = worker.task === null
      return (
        <Box key={`worker-${worker.name}`}>
          <Text color={isIdle ? 'gray' : worker.role === 'reviewer' ? 'cyan' : 'yellow'}>{isIdle ? '○' : '●'} </Text>
          <Box flexGrow={1}>
            <Text wrap="truncate-end" dimColor={isIdle}>
              {worker.name} <Text dimColor>⧉ {worker.bgId}</Text>
            </Text>
          </Box>
          <Box width={14} flexShrink={0}>
            <Text color="magenta" dimColor={isIdle}>
              {setting(worker)}
            </Text>
          </Box>
          <Box width={10} flexShrink={0}>
            <Text dimColor>{isIdle ? 'idle' : `task #${worker.task}`}</Text>
          </Box>
          <UsageCells name={worker.name} isIdle={isIdle} />
        </Box>
      )
    })

    const feedRoom = Math.max(3, rows - shown.length * 2 - workerList.length - 30)
    const activity = entries.slice(-feedRoom).map(entry => (
      <Box>
        <Box width={6} flexShrink={0}>
          <Text dimColor>{hhmm(entry.at)}</Text>
        </Box>
        <Box width={2} flexShrink={0}>
          <Text color={entry.direction === 'in' ? 'cyan' : entry.direction === 'out' ? 'yellow' : 'gray'}>
            {entry.direction === 'out' ? '→' : entry.direction === 'in' ? '←' : '·'}
          </Text>
        </Box>
        <Box width={22} flexShrink={0} marginRight={1}>
          <Text wrap="truncate-end" bold={entry.direction === 'in'}>
            {entry.peer}
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text wrap="truncate-end" dimColor={entry.direction === 'notice'}>
            {entry.text}
          </Text>
        </Box>
      </Box>
    ))

    // The engine paints a pane in ANSI bright black, which some palettes render near white;
    // this theme key is the terminal's own black in dark-ansi (and follows other themes), to the last row.
    return (
      <Box flexDirection="column" backgroundColor={PANE_BACKGROUND} minHeight={e.props.scroll.bodyRows}>
        {header}
        <Section
          title="Tasks"
          right={`1-9 select · ${isDoneShown ? 'a hide' : 'a show'} approved (${count('approved')})`}
        >
          {taskRows.length > 0 ? (
            taskRows
          ) : count('approved') > 0 ? (
            <Text color="green">✔ All done · a shows the {count('approved')} approved</Text>
          ) : (
            <Text dimColor>No task yet: queue one below.</Text>
          )}
          {'Input' in elements ? (
            <Box marginTop={1}>
              <elements.Input
                key={`task-${added}`}
                label="+ "
                placeholder="<repo> <description> [@role] [model:… effort:…]"
                submitLabel="queue"
                onSubmit={value => void serial(() => addTask($, value))}
              />
            </Box>
          ) : (
            <Text dimColor>Queue from a terminal: /orch task {'<repo> <description>'}</Text>
          )}
          <Box display="none">
            <Button key="toggle-done" label="approved" hotkey="a" onPress={() => void update($, showDone, shown => !shown)} />
          </Box>
        </Section>
        {detail}
        <Section title="Sessions" right={`${others.length} other · x stop idle · r refresh`}>
          {sessionColumns}
          {orchestratorRow}
          {workerRows.length === 0 ? <Text dimColor>No worker launched yet.</Text> : workerRows}
          {retired.length > 0 && (
            <Text dimColor>
              + {retired.length} retired session{retired.length === 1 ? '' : 's'} ·{' '}
              {dollars(retired.reduce((sum, [, u]) => sum + u.cost, 0))}
            </Text>
          )}
          <Box display="none">
            <Button key="stop-idle" label="stop idle" hotkey="x" onPress={() => void serial(() => stopIdleWorkers($))} />
            <Button key="refresh" label="refresh" hotkey="r" onPress={() => void refresh($)} />
          </Box>
        </Section>
        <Section title="Activity">{activity.length === 0 ? <Text dimColor>Nothing yet.</Text> : activity}</Section>
      </Box>
    )
  })

  // A one-line summary above the prompt while tasks are open, so the state shows with the pane closed.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, tasks)
    const open = all.filter(t => !['approved', 'dropped'].includes(t.state))
    if (e.props.hasSurvey || open.length === 0) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const count = (state: TaskState) => all.filter(t => t.state === state).length
    const needYou = count('blocked') + count('escalated')

    return (
      <Box gap={2}>
        <Text bold color="cyan">
          ◆ orchestra
        </Text>
        {(['working', 'reviewing', 'queued'] as TaskState[]).map(state =>
          count(state) > 0 ? (
            <Text color={BADGE[state].color}>
              {BADGE[state].icon} {count(state)} {BADGE[state].label}
            </Text>
          ) : null,
        )}
        {needYou > 0 && (
          <Text bold color="red">
            ⚠ {needYou} need{needYou === 1 ? 's' : ''} you
          </Text>
        )}
        <Text dimColor>/orch</Text>
      </Box>
    )
  })
}
