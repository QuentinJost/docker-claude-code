import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { RepoInfo, RoutedTask } from './pipeline'
import type { FeedEntry, HistoryEntry, Peer, WorkerUsage, Setting, Sizing, Task, TaskState, Worker } from '../types'
import { callCost, dollars, fillBar, tokens, toUsage } from './usage'
import type { TranscriptTotals } from './usage'
import { BADGE, STATES, ago, lastFindings, ordered, reportLine, roundDots } from './view'
import { body, deliveryFailure, isAutoModeHold, oneLine, parseBackgrounded, parseInbound, parseListing } from './parse'
import {
  MAX_ROUNDS,
  REUSE_CONTEXT_MAX,
  MAX_ROUTED,
  ORCHESTRATOR_MODEL,
  ROUTE_SYSTEM,
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
  PR_FOOTER,
  parsePr,
  prPrompt,
  PR_SYSTEM,
  parseBranch,
  priorNote,
  deadDependency,
  reviewBrief,
  routePrompt,
  reviewerAgent,
  reworkBrief,
  answerBrief,
  checksBrief,
  capabilitiesFor,
  STACK_MARKERS,
  followupText,
  taskDir,
  doneDigest,
  takeoverBrief,
  roleFor,
  sizingPrompt,
  upgradePrompt,
  workerAgent,
  workerBrief,
  workerName,
} from './pipeline'
import { ROOT, allWorkspaces, capabilityIndex, fill, checkTimeoutMs, checksFor, describe, isKnownRole, isTarget, workflowIndex, parseWorkspaces, setWorkspaces, targetNames, workspaceDir, workspaceErrors } from './workspace'

const PANE = 'orchestra'
const PANE_BACKGROUND = 'bashMessageBackgroundColor'
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
const remoteSeen = atom({ plugin: 'orchestra', key: 'remoteSeen' } as const, false)
const reminded = atom({ plugin: 'orchestra', key: 'reminded' } as const, false)
/** What waits for `/orch answer`: questions on a request, or whether to create the folder it names. */
const pending = atom(
  { plugin: 'orchestra', key: 'pending' } as const,
  null as { input: string; questions: string[]; create?: { repo: string; via: 'task' | 'prompt' } } | null,
)

/** The checks start this long after the report, from a timer. */
const CHECK_START_MS = 10
/** Times a task's own checks may send it back before the person is asked. */
const MAX_CHECK_FIXES = 2
/** Lines of a failing check's output the worker is shown. */
const CHECK_OUTPUT_LINES = 60
/** Past tasks kept for sizing. */
const HISTORY_MAX = 300
/** Where the parallel tasks' clones live: hidden, so the repo listing skips them. */
const CLONES = `${ROOT}/.orchestra/clones`
/** The identity of the first commit the orchestrator makes in a folder it turns into a repo, when git has none. */
const INIT_IDENTITY = ['-c', 'user.name=Orchestra', '-c', 'user.email=orchestra@localhost']

/**
 * Said once per session, when the first task is queued, unless a prompt already came in through
 * Remote Control: no API says whether it is connected, so a bridge prompt is the only proof.
 */
export const REMOTE_TIP =
  'Tip: these tasks run without you. To get their alerts (blocked, rejected, approved) on your phone, run /remote-control in this session, or start the orchestrator with claude --remote-control.'

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

/**
 * Tells the person, on their desktop (and phone with Remote Control), that a task needs them or
 * is done: only those moments, never routine progress. The tool skips it when they are watching.
 */
async function alertPerson($: EngineInterface, message: string) {
  await $.tool.call({ tool: 'PushNotification', message: message.slice(0, 190), status: 'proactive' }).catch(() => undefined)
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
  const live = await listSessions($)
  // Best effort: usage is shown when it can be read, and never stops the rest.
  await refreshUsage($).catch(() => undefined)
  // Like a report, it changes tasks: in turn with the rest. refresh itself never runs inside serial.
  await serial(() => recoverReports($, live)).catch(() => undefined)
  await saveQueue($).catch(() => undefined)
}

/** A session's report must have waited this long in its transcript: one it sent may still be on its way. */
const RECOVER_GRACE_MS = IDLE_GRACE_MS
/** A task's holder unlisted for this long after the task last moved is gone, not still starting. */
const GONE_GRACE_MS = 120_000

/** The last turn of a session, read from its transcript (hooks/lastturn.py); null when there is none to read. */
async function lastTurn($: EngineInterface, bgId: string): Promise<{ text: string; at: number; ended: boolean } | null> {
  const dir = await transcriptsDir($)
  const file = (await $.fs.list(dir).catch(() => [])).find(f => f.name.startsWith(bgId) && f.name.endsWith('.jsonl'))?.name
  if (!file) {
    return null
  }
  const ran = await exec($, ['python3', `${$.plugin.root}/hooks/lastturn.py`, `${dir}/${file}`])
  try {
    const turn = JSON.parse(ran.stdout) as { text?: unknown; at?: unknown; ended?: unknown }
    return { text: String(turn.text ?? ''), at: Number(turn.at) || 0, ended: turn.ended === true }
  } catch {
    return null
  }
}

/**
 * Catches what the idle watchdog misses: a worker or reviewer that wrote its report as the text of
 * its turn instead of sending it (seen 2026-10-09: "SendMessage to app-b5: … VERDICT: APPROVED"),
 * or whose session is gone without a word. The report is read from its transcript and handled as
 * if it had come in; a holder gone with nothing to read blocks its task for the person, instead of
 * a task that waits forever. Runs inside serial().
 */
async function recoverReports($: EngineInterface, live: Set<string> | null) {
  const now = await $.clock.now()
  for (const task of (await read($, tasks)).filter(t => t.state === 'working' || t.state === 'reviewing')) {
    const name = task.state === 'reviewing' ? task.reviewer : task.worker
    const holder = (await read($, workers)).find(w => w.name === name && w.task === task.id)
    if (!holder) {
      continue
    }
    const isReviewer = holder.role === 'reviewer'
    // A worker's transcript holds its reports of every round: only one written after its current
    // brief is this round's. A reviewer is a fresh session per round, so all its text is. A worker
    // briefed before briefedAt existed is never salvaged.
    const since = isReviewer ? 0 : holder.briefedAt
    const turn = since === undefined ? null : await lastTurn($, holder.bgId)
    const hasReport =
      turn !== null &&
      turn.ended &&
      turn.at >= (since ?? 0) &&
      (isReviewer ? parseVerdict(turn.text) !== null : parseStatus(turn.text) !== null)
    if (turn && hasReport && now - turn.at < RECOVER_GRACE_MS) {
      // Written just now: the send, if any, is on its way. The next refresh looks again.
      continue
    }
    if (turn && hasReport) {
      await notify($, `#${task.id}`, `${name} wrote its report without sending it: read from its transcript`)
      const { digest } = await onReceive($, `<cross-session-message from-name="${name}">\n${turn.text}\n</cross-session-message>`)
      if (digest) {
        // The approval's write-up goes to the model as for a report that came in; from a timer,
        // as a hook-held turn may not submit.
        $.clock.after(HANDOFF_DELAY_MS, () => void $.prompt.submit({ text: digest }))
      }
      continue
    }
    // A session launched a moment ago may not be listed yet.
    if (isGone(name, live) && now - task.updatedAt >= GONE_GRACE_MS) {
      await patchTask($, task.id, { state: 'blocked', report: blockedReport(`${name} is gone and left no report`) })
      await notify($, `#${task.id}`, `${name} is gone without a report: your call (/orch retry ${task.id} or /orch drop ${task.id})`)
      await alertPerson($, `Task #${task.id} blocked: ${name} is gone without a report`)
    }
  }
}

/** What a session's queue file holds: enough for another session to take the queue over. */
type Saved = { owner: string; sessionId: string; savedAt: number; tasks: Task[]; workers: Worker[] }

const isOpen = (task: Task): boolean => task.state !== 'approved' && task.state !== 'dropped'

/** Where the queues are kept, one file per orchestrator session: the session's state dies with it. */
async function queuesDir($: EngineInterface) {
  const config =
    (await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) ?? `${(await $.env.get('HOME').catch(() => undefined)) ?? ''}/.claude`
  return `${config}/orchestra/queues`
}

/**
 * Keeps this session's queue in a file, so that it outlives the session (a restart, an image
 * rebuild). A session that never queued a task writes nothing.
 */
async function saveQueue($: EngineInterface) {
  const list = await read($, tasks)
  if (list.length === 0) {
    return
  }
  const sessionId = await $.session.id()
  const saved: Saved = { owner: await read($, self), sessionId, savedAt: await $.clock.now(), tasks: list, workers: await read($, workers) }
  await $.fs.write(`${await queuesDir($)}/${sessionId}.json`, JSON.stringify(saved))
}

/**
 * On the first /orch of a session with no queue of its own: takes over the open queue of an
 * orchestrator session that is gone. Its live workers are told whom to report to now; a task
 * whose session is gone waits for the person. What it says, or '' when there was nothing to take.
 */
async function adoptQueue($: EngineInterface): Promise<string> {
  if ((await read($, tasks)).length > 0) {
    return ''
  }
  const dir = await queuesDir($)
  const mine = await $.session.id()
  const live = await listSessions($)
  if (live === null) {
    return ''
  }
  const me = await read($, self)
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    if (!entry.name.endsWith('.json') || entry.name === `${mine}.json`) {
      continue
    }
    const saved = await $.fs
      .read(`${dir}/${entry.name}`)
      .then(text => JSON.parse(String(text)) as Saved)
      .catch(() => null)
    // Its owner still runs it, or nothing is left open there.
    if (!saved || live.has(saved.owner) || !saved.tasks.some(isOpen)) {
      continue
    }
    await update($, tasks, () => saved.tasks)
    await update($, workers, () => saved.workers.filter(w => live.has(w.name)))
    const lines: string[] = []
    for (const task of saved.tasks.filter(t => ['working', 'checking', 'reviewing'].includes(t.state))) {
      const holder = task.state === 'reviewing' ? task.reviewer : task.worker
      if (live.has(holder)) {
        await send($, holder, `[ORCH ${me}] The orchestrator of task #${task.id} is now "${me}" (it was "${saved.owner}"): send your report or verdict to "${me}" with SendMessage, in the same format.`, true)
        lines.push(`#${task.id}: ${holder} is still at it and now reports here.`)
      } else {
        await patchTask($, task.id, { state: 'blocked', report: blockedReport(`the orchestrator restarted and ${holder || 'its session'} is gone`) })
        lines.push(`#${task.id}: its session is gone: /orch retry ${task.id} hands it to a fresh one.`)
      }
    }
    await $.fs.write(`${dir}/${entry.name}`, JSON.stringify({ ...saved, tasks: [], adoptedBy: me })).catch(() => undefined)
    await saveQueue($)
    await log($, { direction: 'notice', peer: 'queue', text: `taken over from ${saved.owner}: ${saved.tasks.filter(isOpen).length} open task(s)` })
    return [`Took over the queue of ${saved.owner}, which is gone: ${saved.tasks.filter(isOpen).length} open task(s).`, ...lines].join('\n')
  }
  return ''
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

async function exec($: EngineInterface, argv: string[], cwd = ROOT, timeoutMs = 60_000) {
  return $.process
    .run(argv, { cwd, env: { NO_COLOR: '1' }, timeoutMs })
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
    .complete({ model: ORCHESTRATOR_MODEL, system: SIZING_SYSTEM, prompt: sizingPrompt(repo, role, text, await readHistory($)), maxTokens: 400, effort: 'medium' })
    .catch(() => null)
  const spent = reply ? callCost(ORCHESTRATOR_MODEL, reply.usage) : 0
  const sized: Sizing = (reply?.isAnswered ? parseSizing(reply.text) : null) ?? defaultSizing(role, repo)
  const asked = { ...sized.work, ...forced }
  const work = atLeast(asked, WORK_FLOOR)
  const review = atLeast(sized.review, SESSION_FLOOR)
  const raised = [
    work.model === asked.model ? '' : `dev raised from ${asked.model} to the ${WORK_FLOOR} floor`,
    review.model === sized.review.model ? '' : `review raised from ${sized.review.model} to the ${SESSION_FLOOR} floor`,
  ].filter(Boolean)
  const why = raised.length > 0 ? `${sized.why} (${raised.join('; ')})` : sized.why

  return { sizing: { work, review, why }, spent }
}

/** Where the past tasks are kept, across sessions. */
async function historyFile($: EngineInterface) {
  const config =
    (await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) ?? `${(await $.env.get('HOME').catch(() => undefined)) ?? ''}/.claude`
  return `${config}/orchestra/history.json`
}

async function readHistory($: EngineInterface): Promise<HistoryEntry[]> {
  try {
    const list = JSON.parse(await $.fs.read(await historyFile($))) as unknown
    return Array.isArray(list) ? (list as HistoryEntry[]) : []
  } catch {
    return []
  }
}

/** What a task cost so far: its sessions (live or retired) and the orchestrator's calls for it. */
async function costOf($: EngineInterface, task: Task): Promise<number> {
  const used = await read($, usage)
  return (
    Object.entries(used)
      .filter(([name, u]) => u.task === task.id || name === task.worker || name.startsWith(`orch-review-${task.id}-`))
      .reduce((sum, [, u]) => sum + u.cost, 0) + (task.callCost ?? 0)
  )
}

/** Keeps a finished task for the sizing of the next ones. Best effort: a failure loses one entry, never the task. */
async function remember($: EngineInterface, task: Task, outcome: HistoryEntry['outcome']) {
  await keep($, task, outcome).catch(() => undefined)
}

async function keep($: EngineInterface, task: Task, outcome: HistoryEntry['outcome']) {
  await refreshUsage($).catch(() => undefined)
  const entry: HistoryEntry = {
    at: await $.clock.now(),
    repo: task.repo,
    role: task.role,
    title: firstLine(task.text),
    work: task.sizing.work,
    review: task.sizing.review,
    outcome,
    rounds: task.round,
    checkFixes: task.checkFixes ?? 0,
    cost: await costOf($, task),
  }
  const history = [...(await readHistory($)), entry].slice(-HISTORY_MAX)
  await $.fs.write(await historyFile($), JSON.stringify(history, null, 1)).catch(() => undefined)
}

/** Adds the cost of an orchestrator model call to a task. */
async function charge($: EngineInterface, id: number, cost: number) {
  if (cost > 0) {
    const task = (await read($, tasks)).find(t => t.id === id)
    await patchTask($, id, { callCost: (task?.callCost ?? 0) + cost })
  }
}

/** What a typed task holds: `<repo> <description> [@role] [model:… effort:…] [after:#n] [from:<branch>]`. */
type Input = { repo: string; role: string; text: string; work: Partial<Setting>; after: number[]; from: string; spent?: number; workflow?: string }

const parseInput = (input: string): Input | null => {
  const parsed = parseTask(input)
  if (!parsed) {
    return null
  }
  const overrides = parseOverrides(parsed.text)
  const { role, text } = roleFor(parsed.repo, overrides.text)

  return { repo: parsed.repo, role, text, work: overrides.work, after: overrides.after, from: overrides.from }
}

/** Why a task cannot be queued as asked (an unknown task to wait for, a start branch that does not exist), or null. */
async function refusal($: EngineInterface, { repo, after, from }: Input): Promise<string | null> {
  const list = await read($, tasks)
  const unknown = after.filter(id => !list.some(t => t.id === id))
  if (unknown.length > 0) {
    return `no task ${unknown.map(id => `#${id}`).join(', ')} to wait for`
  }
  if (from && isTarget(repo)) {
    return `from: does not apply to ${repo}, which is not a git repo`
  }
  if (from && (await exec($, ['git', '-C', `${ROOT}/${repo}`, 'rev-parse', '--verify', '--quiet', `${from}^{commit}`])).exitCode !== 0) {
    return `no branch or commit "${from}" in ${repo}`
  }
  return null
}

/** Where a task's branch will start, as the person is told when it is queued. */
async function startLine($: EngineInterface, task: Task): Promise<string> {
  if (isTarget(task.repo)) {
    return `Runs on ${task.repo}, not a git repo: no branch.`
  }
  if (task.from) {
    return `Branch starts from ${task.from} (asked).`
  }
  const all = await read($, tasks)
  const sameRepoDep = (task.after ?? []).some(id => all.find(t => t.id === id)?.repo === task.repo)
  if (sameRepoDep) {
    return 'Branch starts from the branch of the task it waits for in this repo (add from:<branch> to choose).'
  }
  const earlier = (await read($, tasks)).find(t => t.repo === task.repo && t.branchFrom && t.id !== task.id)?.branchFrom
  const current = earlier || (await exec($, ['git', '-C', `${ROOT}/${task.repo}`, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  return `Branch starts from ${current || 'the repo\'s current branch'} (add from:<branch> to choose).`
}

/** Queues a task; the lines the person reads, or the reason it was not queued. */
async function queueTask($: EngineInterface, input: Input): Promise<{ id: number; lines: string } | { error: string }> {
  const refused = await refusal($, input)
  if (refused) {
    return { error: refused }
  }
  const { repo, role, text, work, after, from } = input
  const { sizing, spent } = await size($, repo, role, text, work)
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
    callCost: spent + (input.spent ?? 0),
    // Only a workflow the repo's workspace offers: a name the model made up leads nowhere.
    ...(input.workflow && workflowIndex(repo)[input.workflow] ? { workflow: input.workflow } : {}),
    ...(after.length > 0 ? { after } : {}),
    ...(from ? { from } : {}),
  }
  const start = await startLine($, task)
  const waits = after.length > 0 ? ` · waits for ${after.map(n => `#${n}`).join(', ')}` : ''
  added += 1
  await update($, tasks, all => [...all, task])
  await log($, {
    direction: 'notice',
    peer: `#${id}`,
    text: `queued for ${role} in ${repo}${waits} · dev ${setting(sizing.work)} · review ${setting(sizing.review)} · ${sizing.why}`,
  })
  await dispatch($)

  return { id, lines: [after.length > 0 ? `Waits for ${after.map(n => `#${n}`).join(', ')} to be approved.` : '', start].filter(Boolean).join('\n') }
}

/** A plain folder name or path under the root, never a word of a request. */
const FOLDER = /^[\w.-]+(\/[\w.-]+)*$/

/**
 * The folder a request names as a path under the root (`/app/<folder> …`) when it does not exist,
 * or null. Only a path the person typed as such counts: a first word that merely is no repo is a
 * request to route.
 */
async function missingFolder($: EngineInterface, input: string): Promise<string | null> {
  if (!input.trim().startsWith(`${ROOT}/`)) {
    return null
  }
  const repo = parseTask(input)?.repo ?? ''
  if (!FOLDER.test(repo)) {
    return null
  }
  return (await $.fs.exists(`${ROOT}/${repo}`).catch(() => false)) ? null : repo
}

/** Asks whether to create the folder a request names; nothing is queued until the person says. */
async function askCreate($: EngineInterface, input: string, repo: string, via: 'task' | 'prompt'): Promise<string> {
  const question = `${ROOT}/${repo} does not exist. Create it (an empty folder, made a new app's repo at dispatch)?`
  await update($, pending, () => ({ input, questions: [question], create: { repo, via } }))
  await log($, { direction: 'notice', peer: repo, text: 'folder missing: asked whether to create it; nothing queued' })
  return ['Not queued yet:', `- ${question}`, '', 'Answer /orch answer yes to create it and go on, or /orch answer no.'].join('\n')
}

/** `/orch answer` to the folder question: creates it and goes on with the request, or drops it. */
async function answerCreate($: EngineInterface, asked: { input: string; create: { repo: string; via: 'task' | 'prompt' } }, answer: string): Promise<string> {
  const { repo, via } = asked.create
  if (/^(n|no|non)\b/i.test(answer)) {
    await update($, pending, () => null)
    return `${ROOT}/${repo} not created; nothing queued.`
  }
  if (!/^(y|yes|o|oui|ok|create)\b/i.test(answer)) {
    return `Answer /orch answer yes to create ${ROOT}/${repo}, or /orch answer no.`
  }
  const made = await exec($, ['mkdir', '-p', `${ROOT}/${repo}`])
  if (made.exitCode !== 0) {
    return `Could not create ${ROOT}/${repo}: ${oneLine(made.stderr).slice(0, 200)}. Nothing queued.`
  }
  await update($, pending, () => null)
  await log($, { direction: 'notice', peer: repo, text: 'folder created at the person\'s word' })
  const next = via === 'task' ? await addTask($, asked.input) : await upgradeTask($, asked.input)
  return [`Created ${ROOT}/${repo}.`, next].join('\n')
}

async function addTask($: EngineInterface, input: string): Promise<string> {
  const missing = await missingFolder($, input)
  if (missing) {
    return askCreate($, input, missing, 'task')
  }
  const parsed = parseInput(input)
  if (!parsed) {
    $.ui.toast('Usage: <repo> <description> [@role]')
    return 'Usage: <repo> <description> [@role] [after:#n] [from:<branch>]'
  }
  const queued = await queueTask($, parsed)
  return 'error' in queued ? `Not queued: ${queued.error}.` : `Task #${queued.id} queued in ${parsed.repo}.\n${queued.lines}`
}

/**
 * `/orch prompt`: the orchestrator's model, as Prompt Manager, rewrites the request into a brief
 * (objective, context, task, constraints, done-when) before it is queued; a request it cannot
 * make sense of comes back as questions, and nothing is queued.
 */
/**
 * The reply cap of the Prompt Manager and the router: a split into a few tasks, each with its
 * whole brief, in JSON. 2000 tokens cut such a reply short (seen 2026-10-07 on a new app split
 * back/front), which then reads as no brief at all. Only what is written is billed.
 */
const BRIEF_MAX_TOKENS = 16000

/** Why a Prompt Manager or router call gave nothing to queue, in a few words for the person. */
function whyUnusable(reply: Awaited<ReturnType<EngineInterface['model']['complete']>> | null): string {
  if (!reply) {
    return 'the call was refused'
  }
  if (!reply.isAnswered) {
    return `no reply (${reply.reason})`
  }
  const out = reply.usage?.output_tokens ?? 0
  return out >= BRIEF_MAX_TOKENS ? `the reply was cut at ${out} tokens` : `the reply was not the expected JSON (${reply.text.length} characters)`
}

async function upgradeTask($: EngineInterface, input: string): Promise<string> {
  const missing = await missingFolder($, input)
  if (missing) {
    return askCreate($, input, missing, 'prompt')
  }
  const repos = await listRepos($)
  const first = parseTask(input)?.repo
  // A folder under the root that is no repo yet is named all the same: a new app, which the
  // dispatch makes a repo (git init). Only a plain folder name or path, never a word of the request.
  const isNewFolder =
    !!first && FOLDER.test(first) && (await $.fs.list(`${ROOT}/${first}`).then(() => true).catch(() => false))
  // A request that does not start with a repo of the workspace is routed: the model picks where.
  if (repos.length > 0 && !isTarget(first ?? '') && !repos.some(r => r.repo === first) && !isNewFolder) {
    return routeTask($, input, repos)
  }
  const parsed = parseInput(input)
  if (!parsed) {
    return 'Usage: /orch prompt [<repo>] <request> [@role] [model:… effort:…]'
  }
  const reply = await $.model
    .complete({ model: ORCHESTRATOR_MODEL, system: UPGRADE_SYSTEM, prompt: upgradePrompt(parsed.repo, parsed.role, parsed.text), maxTokens: BRIEF_MAX_TOKENS, effort: 'high' })
    .catch(() => null)
  const spent = reply ? callCost(ORCHESTRATOR_MODEL, reply.usage) : 0
  const upgrade = reply?.isAnswered ? parseUpgrade(reply.text, parsed.repo) : null
  if (!upgrade) {
    const why = whyUnusable(reply)
    await log($, { direction: 'notice', peer: 'prompt', text: `no usable brief from ${ORCHESTRATOR_MODEL}: ${why}; nothing queued` })
    return `The orchestrator model gave no usable brief (${why}); nothing queued. Retry (an answer waiting can be sent again with /orch answer), or queue it as typed with /orch task.`
  }
  if ('questions' in upgrade) {
    await log($, { direction: 'notice', peer: 'prompt', text: `unclear request, ${upgrade.questions.length} question(s) for you; nothing queued` })
    await update($, pending, () => ({ input, questions: upgrade.questions }))
    return ['Not queued: the request needs settling first.', ...upgrade.questions.map(q => `- ${q}`), '', 'Answer with /orch answer <your answers>.'].join('\n')
  }
  await update($, pending, () => null)
  // The role the person named (one other than the repo's own) wins; else the one the model picked, when the repo knows it.
  const isNamed = parsed.role !== roleFor(parsed.repo, '').role
  const pick = (role?: string) => (isNamed || !role || !isKnownRole(role, parsed.repo) ? parsed.role : role)
  if ('tasks' in upgrade) {
    return queueRouted($, upgrade.tasks.map(t => ({ ...t, role: pick(t.role) })), { work: parsed.work, after: parsed.after }, spent, parsed.text)
  }
  const text = `${upgrade.title}\n\n${upgrade.brief}`
  const role = pick(upgrade.role)
  const queued = await queueTask($, { ...parsed, role, text, spent, ...(upgrade.workflow ? { workflow: upgrade.workflow } : {}) })
  if ('error' in queued) {
    return `Not queued: ${queued.error}.`
  }
  await log($, { direction: 'notice', peer: `#${queued.id}`, text: `brief written by the Prompt Manager from: ${oneLine(parsed.text)}` })

  return [`Task #${queued.id} queued in ${parsed.repo} for ${role} with this brief:`, queued.lines, '', text].join('\n')
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

/**
 * Reads every workspace's orchestra.json under the root (hooks/repos.py --workspaces) and puts
 * their rules in force; none readable leaves the generic defaults. Read again on every entry
 * into the pipeline: an edited workspace file applies from the next step, no reload needed.
 */
async function loadWorkspaces($: EngineInterface) {
  const ran = await exec($, ['python3', `${$.plugin.root}/hooks/repos.py`, '--workspaces', ROOT]).catch(() => null)
  const parsed = parseWorkspaces(ran?.stdout ?? '')
  setWorkspaces(parsed.workspaces, parsed.errors)
  // Each fault once in the feed: a broken file changes what the orchestra does, silently otherwise.
  const seen = new Set((await read($, feed)).filter(f => f.peer === 'config').map(f => f.text))
  for (const error of parsed.errors.filter(e => !seen.has(e))) {
    await notify($, 'config', error)
  }
}

/** What /orch adds to every answer while a workspace file is faulty. */
const configWarning = (): string =>
  workspaceErrors().length ? ['', '⚠ Workspace config:', ...workspaceErrors().map(e => `- ${e}`), 'See /orch config.'].join('\n') : ''

/** The overviews the router reads beside the repo list: the files each workspace names. */
async function workspaceOverview($: EngineInterface): Promise<string> {
  const parts: string[] = []
  for (const ws of allWorkspaces()) {
    for (const file of ws.overview ?? []) {
      const text = await $.fs.read(`${workspaceDir(ws)}/${file}`).catch(() => '')
      if (text.trim()) {
        parts.push(text.slice(0, 8000))
      }
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
    .complete({ model: ORCHESTRATOR_MODEL, system: ROUTE_SYSTEM, prompt: routePrompt(repos, await workspaceOverview($), role, request), maxTokens: BRIEF_MAX_TOKENS, effort: 'high' })
    .catch(() => null)
  const spent = reply ? callCost(ORCHESTRATOR_MODEL, reply.usage) : 0
  const routed = reply?.isAnswered ? parseRouting(reply.text, repos) : null
  if (!routed) {
    const why = whyUnusable(reply)
    await log($, { direction: 'notice', peer: 'prompt', text: `no usable routing from ${ORCHESTRATOR_MODEL}: ${why}; nothing queued` })
    return `The orchestrator model could not place the request in a repo (${why}); nothing queued. Retry, or name the repo: /orch prompt <repo> <request>.`
  }
  if ('questions' in routed) {
    await log($, { direction: 'notice', peer: 'prompt', text: `request not placed, ${routed.questions.length} question(s) for you; nothing queued` })
    await update($, pending, () => ({ input, questions: routed.questions }))
    return ['Not queued: the request needs settling first.', ...routed.questions.map(q => `- ${q}`), '', 'Answer with /orch answer <your answers>, or name the repo: /orch prompt <repo> <request>.'].join('\n')
  }
  await update($, pending, () => null)
  // The role the person named wins; else the one the model picked, when the repo knows it; else the repo's.
  const tasksWithRoles = routed.tasks.map(t => ({
    ...t,
    role: role ?? (t.role && isKnownRole(t.role, t.repo) ? t.role : roleFor(t.repo, '').role),
  }))
  return queueRouted($, tasksWithRoles, overrides, spent, request)
}

/**
 * Queues the tasks the model made of one request (several repos, or several domains of one repo),
 * in its order: its `after` positions become the ids queued so far.
 */
async function queueRouted(
  $: EngineInterface,
  list: (RoutedTask & { role: string })[],
  overrides: { work: Partial<Setting>; after: number[] },
  spent: number,
  request: string,
): Promise<string> {
  const answers: string[] = []
  const ids: (number | undefined)[] = []
  for (const [index, { repo, title, brief, after, role, workflow }] of list.entries()) {
    const text = `${title}\n\n${brief}`
    const waits = [...new Set([...overrides.after, ...after.map(i => ids[i]).filter((n): n is number => n !== undefined)])]
    const queued = await queueTask($, { repo, role, text, work: overrides.work, after: waits, from: '', spent: spent / list.length, ...(workflow ? { workflow } : {}) })
    if ('error' in queued) {
      answers.push(`Not queued in ${repo}: ${queued.error}.`)
      ids[index] = undefined
      continue
    }
    ids[index] = queued.id
    await log($, { direction: 'notice', peer: `#${queued.id}`, text: `${role} task in ${repo}, from: ${oneLine(request)}` })
    answers.push([`Task #${queued.id} queued in ${repo} for ${role} with this brief:`, queued.lines, '', text].join('\n'))
  }
  if (list.length === MAX_ROUTED) {
    answers.push(`(${MAX_ROUTED} tasks at most per request.)`)
  }

  return answers.join('\n\n')
}

/**
 * Makes a task's folder a repo it can branch from: a folder that is not a git repo gets `git init`
 * and an empty first commit, a repo with no commit yet the empty commit. Local only: no remote, no
 * hosting. The reason it cannot, or whether the folder just became a repo: a new app, with its rules.
 */
async function ensureRepo($: EngineInterface, repo: string): Promise<string | { isNew: boolean }> {
  const dir = `${ROOT}/${repo}`
  if (!(await $.fs.exists(dir).catch(() => false))) {
    return `${dir} does not exist: create the folder (or fix the name), then /orch retry`
  }
  const git = (...args: string[]) => exec($, ['git', '-C', dir, ...args])
  const top = (await git('rev-parse', '--show-toplevel')).stdout.trim()
  // A subfolder of another repo is not made a repo of its own: the task belongs to that repo.
  if (top !== '' && top !== dir) {
    return `${dir} is inside the repo ${top}: queue the task on that repo instead`
  }
  let isNew = false
  if (top === '') {
    isNew = true
    const init = await git('init', '--quiet', '--initial-branch=main')
    if (init.exitCode !== 0) {
      return `${dir} is not a git repo and git init failed: ${oneLine(init.stderr).slice(0, 200)}`
    }
    await log($, { direction: 'notice', peer: repo, text: 'not a git repo: git init (local only, no remote)' })
  }
  if ((await git('rev-parse', '--verify', '--quiet', 'HEAD')).exitCode !== 0) {
    const hasIdentity = (await git('config', 'user.email')).stdout.trim() !== ''
    const commit = await exec($, ['git', '-C', dir, ...(hasIdentity ? [] : INIT_IDENTITY), 'commit', '--allow-empty', '--quiet', '-m', 'chore: initial commit'])
    if (commit.exitCode !== 0) {
      return `${dir} has no commit and the first one failed: ${oneLine(commit.stderr).slice(0, 200)}`
    }
    await log($, { direction: 'notice', peer: repo, text: 'no commit yet: empty first commit made, for the task branch to start from' })
    isNew = true
  }
  return { isNew }
}

/** The capability cards of a task's repo stack, read from its marker files; none for a non-git target or a workspace without cards. */
async function stackCapabilities($: EngineInterface, task: Task): Promise<string[]> {
  const index = capabilityIndex(task.repo)
  if (isTarget(task.repo) || Object.keys(index).length === 0) {
    return []
  }
  const files: Partial<Record<(typeof STACK_MARKERS)[number], string>> = {}
  for (const marker of STACK_MARKERS) {
    const text = await $.fs.read(`${ROOT}/${task.repo}/${marker}`).catch(() => null)
    if (typeof text === 'string') {
      files[marker] = text.slice(0, 200_000)
    }
  }
  return capabilitiesFor(files, task.role, index)
}

/** A local clone of a task's repo for it alone, on its start branch; its path, or null. */
async function cloneFor($: EngineInterface, task: Task, branchFrom: string, base: string): Promise<string | null> {
  const dir = `${CLONES}/${task.repo.replace(/[^A-Za-z0-9._-]/g, '-')}-${task.id}`
  await exec($, ['rm', '-rf', dir])
  const cloned = await exec($, ['git', 'clone', '--quiet', '--no-checkout', `${ROOT}/${task.repo}`, dir], ROOT, 600_000)
  if (cloned.exitCode !== 0) {
    await log($, { direction: 'notice', peer: `#${task.id}`, text: `clone failed: ${oneLine(cloned.stderr).slice(0, 200)}` })
    return null
  }
  const placed = await exec($, ['git', '-C', dir, 'switch', '--quiet', '-C', branchFrom || 'main', base])
  if (placed.exitCode !== 0) {
    return null
  }
  await log($, { direction: 'notice', peer: `#${task.id}`, text: `works in a local clone: ${dir}` })
  return dir
}

/** Brings an approved clone task's branch back into the repo, then removes the clone. The reason it could not, or null. */
async function bringBack($: EngineInterface, task: Task): Promise<string | null> {
  if (!task.dir || !task.branch) {
    return task.dir ? 'its report named no branch: the clone is kept' : null
  }
  const fetched = await exec($, ['git', '-C', `${ROOT}/${task.repo}`, 'fetch', '--quiet', task.dir, `${task.branch}:${task.branch}`])
  if (fetched.exitCode !== 0) {
    return `the branch could not be fetched back (${oneLine(fetched.stderr).slice(0, 200)}): the clone is kept at ${task.dir}`
  }
  await exec($, ['rm', '-rf', task.dir])
  return null
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
  // A task waiting for a dropped one would wait forever: the person decides.
  for (const task of (await read($, tasks)).filter(t => t.state === 'queued')) {
    const dead = deadDependency(task, await read($, tasks))
    if (dead !== null) {
      const why = `it waits for #${dead}, which was dropped`
      await patchTask($, task.id, { state: 'blocked', report: blockedReport(why) })
      await notify($, `#${task.id}`, `blocked: ${why}`)
      await alertPerson($, `Task #${task.id} blocked: it waits for #${dead}, which was dropped`)
    }
  }
  // An idle worker whose context is already half full takes no new task: a compaction in the middle
  // of one could summarise its brief away. A fresh session does, and the full one makes room.
  const readings = await read($, usage)
  const full = new Set(Object.entries(readings).filter(([, u]) => u.window > 0 && u.context / u.window > REUSE_CONTEXT_MAX).map(([name]) => name))
  for (const { task, worker, inClone } of plan(await read($, tasks), await read($, workers), full)) {
    // The branch starts from: the one the person asked; else, after a task of the same repo,
    // that task's branch; else where the repo stood at its first task, not whatever task
    // branch the previous worker left checked out. A non-git target: no branch, no base.
    const all = await read($, tasks)
    const git = (...args: string[]) => exec($, ['git', '-C', `${ROOT}/${task.repo}`, ...args])
    let isNewApp = task.isNewApp ?? false
    if (!isTarget(task.repo)) {
      const ready = await ensureRepo($, task.repo)
      if (typeof ready === 'string') {
        await patchTask($, task.id, { state: 'blocked', report: blockedReport(ready) })
        await notify($, `#${task.id}`, `blocked: ${ready}`)
        continue
      }
      isNewApp ||= ready.isNew
    }
    const sameRepoDep = (task.after ?? []).map(id => all.find(t => t.id === id)).find(t => t?.repo === task.repo && t.branch)
    const branchFrom = isTarget(task.repo)
      ? ''
      : task.from ||
        sameRepoDep?.branch ||
        (all.find(t => t.repo === task.repo && t.branchFrom && !t.from && !(t.after ?? []).length)?.branchFrom ??
          (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim())
    const head = isTarget(task.repo) ? { exitCode: 0, stdout: '' } : await git('rev-parse', branchFrom || 'HEAD')
    if (head.exitCode !== 0) {
      const why = `${ROOT}/${task.repo}: no branch or commit "${branchFrom || 'HEAD'}" to start from`
      await patchTask($, task.id, { state: 'blocked', report: blockedReport(why) })
      await notify($, `#${task.id}`, `blocked: ${why}`)
      continue
    }
    const base = head.stdout.trim()
    // Beside another task of the same repo: a local clone of its own, on the start branch.
    const dir = inClone ? await cloneFor($, task, branchFrom, base) : ''
    if (dir === null) {
      const why = `${ROOT}/${task.repo}: the local clone for a parallel task could not be made`
      await patchTask($, task.id, { state: 'blocked', report: blockedReport(why) })
      await notify($, `#${task.id}`, `blocked: ${why}`)
      continue
    }
    const prior = priorNote(task, all)
    const capabilities = await stackCapabilities($, task)
    const started: Task = {
      ...task,
      state: 'working',
      branchFrom,
      base,
      ...(dir ? { dir } : {}),
      ...(prior ? { prior } : {}),
      ...(isNewApp ? { isNewApp } : {}),
      ...(capabilities.length ? { capabilities } : {}),
    }
    const brief = workerBrief(me, started)
    await patchTask($, task.id, { ...(prior ? { prior } : {}), ...(dir ? { dir } : {}), ...(isNewApp ? { isNewApp } : {}), ...(capabilities.length ? { capabilities } : {}) })

    if (worker) {
      await patchTask($, task.id, { state: 'working', branchFrom, base: started.base, worker: worker.name })
      await patchWorker($, worker.name, { task: task.id, brief, nudges: 0, briefedAt: await $.clock.now() })
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
    const bgId = await launch($, name, agentName(task.role), workerAgent(task.role, task.repo, await read($, self)), work, brief)
    if (!bgId) {
      await patchTask($, task.id, { state: 'blocked', report: 'worker launch failed' })
      await alertPerson($, `Task #${task.id} blocked: its worker session could not be launched`)
      continue
    }
    const briefedAt = await $.clock.now()
    await update($, workers, list => [...list, { name, bgId, repo: task.repo, role: task.role, ...work, task: task.id, brief, nudges: 0, briefedAt }])
    await patchTask($, task.id, { state: 'working', branchFrom, base: started.base, worker: name })
    // The brief went with the launch; the idle subscription alone goes now.
    await subscribeIdle($, name)
  }
}

/**
 * Subscribes to a session's next idle notice without sending it anything. A subscription that
 * did not take is said in the feed: without it the idle watchdog never fires for that session,
 * and only the transcript sweep (recoverReports) catches a report it fails to send.
 */
async function subscribeIdle($: EngineInterface, name: string) {
  const call = async () =>
    deliveryFailure(
      // An empty message is the tool's own spelling of "subscribe only".
      await $.tool
        .call({ tool: 'SendMessage', to: name, message: '', notify_when_idle: true })
        .catch((error: unknown) => ({ deny: String(error), isError: undefined, result: undefined, text: undefined })),
    )
  let reason = await call()
  // As for a message: the classifier's own advice on a hold is to try once more, as is.
  if (reason !== null && isAutoModeHold(reason)) {
    reason = await call()
  }
  if (reason !== null) {
    await notify($, name, `idle watch not set: ${oneLine(reason).slice(0, 200)}`)
  }
}

async function startReview($: EngineInterface, task: Task) {
  const me = await read($, self)
  const name = `orch-review-${task.id}-r${task.round}`
  // Also for a task sized before the floor existed.
  const review = atLeast(task.sizing.review, SESSION_FLOOR)
  const brief = reviewBrief(me, task)
  const bgId = await launch($, name, REVIEWER, reviewerAgent(task.repo, await read($, self)), review, brief)
  if (!bgId) {
    await patchTask($, task.id, { state: 'blocked', report: 'reviewer launch failed' })
    await alertPerson($, `Task #${task.id} blocked: its reviewer session could not be launched`)
    return
  }
  const briefedAt = await $.clock.now()
  await update($, workers, list => [...list, { name, bgId, repo: task.repo, role: 'reviewer', ...review, task: task.id, brief, nudges: 0, briefedAt }])
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
    // The task branch, for the next task that builds on it and for /orch pr: the report's
    // BRANCH line, else the branch the repo is on when it differs from the start.
    const current = isTarget(task.repo) ? '' : (await exec($, ['git', '-C', taskDir(task), 'branch', '--show-current'])).stdout.trim()
    const branch = parseBranch(text) || (current !== task.branchFrom ? current : '')
    const reported = { ...task, report: body(text), ...(branch ? { branch } : {}) }
    await patchTask($, task.id, { report: reported.report, ...(branch ? { branch } : {}) })
    const checks = isTarget(task.repo) ? [] : checksFor(task.repo)
    if (checks.length > 0) {
      // Long: run from a timer, outside the queue's turn, so other tasks keep moving; the outcome comes back in it.
      await patchTask($, task.id, { state: 'checking' })
      await notify($, `#${task.id}`, `running ${checks.length} check(s) before review`)
      $.clock.after(CHECK_START_MS, () => runChecks($, reported, checks).then(outcome => serial(() => onChecksDone($, task.id, checks, outcome))))
      return
    }
    await startReview($, reported)
    return
  }
  await patchTask($, task.id, { state: 'blocked', report: body(text) })
  await notify($, `#${task.id}`, `${status}: needs you (/orch retry ${task.id} <answer> or /orch drop ${task.id})`)
  const needs = parseNeeds(body(text))
  await alertPerson($, `Task #${task.id} ${status} in ${task.repo}${needs ? `: ${needs}` : ''}`)
}

type CheckOutcome = { failed: string; output: string } | null

/**
 * Runs a repo's checks in the task's folder, on its branch, one after the other, stopping at the
 * first failure: the failing command and the end of its output, or null when all pass.
 */
async function runChecks($: EngineInterface, task: Task, checks: string[]): Promise<CheckOutcome> {
  const dir = taskDir(task)
  if (task.branch) {
    const on = (await exec($, ['git', '-C', dir, 'branch', '--show-current'])).stdout.trim()
    if (on !== task.branch) {
      const switched = await exec($, ['git', '-C', dir, 'switch', '--quiet', task.branch])
      if (switched.exitCode !== 0) {
        return { failed: `git switch ${task.branch}`, output: `The repo is on ${on || 'a detached HEAD'}, and the task branch could not be checked out:\n${switched.stderr}` }
      }
    }
  }
  for (const command of checks) {
    // {base}: the commit the task branch started from, so a check can look at the task's own changes.
    const ran = await exec($, ['sh', '-c', fill(command, { base: task.base || 'HEAD' })], dir, checkTimeoutMs(task.repo))
    if (ran.exitCode !== 0) {
      const output = `${ran.stdout}\n${ran.stderr}`.trim().split('\n').slice(-CHECK_OUTPUT_LINES).join('\n').slice(-6000)
      return { failed: command, output: output || `exit code ${ran.exitCode}, no output` }
    }
  }
  return null
}

/** The checks' outcome: on to the review, or back to the worker, or, after too many tries, to the person. */
async function onChecksDone($: EngineInterface, id: number, checks: string[], outcome: CheckOutcome) {
  const task = (await read($, tasks)).find(t => t.id === id)
  if (!task || task.state !== 'checking') {
    return
  }
  if (outcome === null) {
    const passed = { ...task, checks: checks.join(' && ') }
    await patchTask($, id, { checks: passed.checks })
    await notify($, `#${id}`, 'checks passed: on to review')
    await startReview($, passed)
    return
  }
  const fixes = task.checkFixes ?? 0
  if (fixes >= MAX_CHECK_FIXES) {
    await patchTask($, id, {
      state: 'blocked',
      report: blockedReport(`\`${outcome.failed}\` still fails after ${fixes} fix(es) by the worker:\n${outcome.output.split('\n').slice(-15).join('\n')}`),
    })
    await notify($, `#${id}`, `checks still fail after ${fixes} fixes: your call`)
    await alertPerson($, `Task #${id} blocked: its checks still fail after ${fixes} fixes`)
    return
  }
  await patchTask($, id, { state: 'working', checkFixes: fixes + 1 })
  await notify($, `#${id}`, `check failed (${outcome.failed}): back to the worker, no review spent`)
  const { reason } = await briefWorker($, task, checksBrief(await read($, self), task, outcome.failed, outcome.output))
  if (reason !== null) {
    await patchTask($, id, { state: 'blocked', report: blockedReport(`the failed checks reached no worker: ${reason}`) })
    await alertPerson($, `Task #${id} blocked: the failed checks reached no worker`)
  }
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
    const kept = await bringBack($, task)
    if (kept) {
      await notify($, `#${task.id}`, kept)
    }
    await remember($, { ...task, reviews }, 'approved')
    const needs = parseNeeds(task.report)
    await notify($, `#${task.id}`, needs ? `approved at round ${task.round}; open question for you: ${needs}` : `approved at round ${task.round}`)
    await alertPerson($, `Task #${task.id} approved in ${task.repo}${needs ? `; open question: ${needs}` : ''}`)
    await dispatch($)
    return doneDigest(await read($, self), { ...task, reviews })
  }
  if (task.round >= MAX_ROUNDS) {
    await patchTask($, task.id, { state: 'escalated', reviews })
    await remember($, { ...task, reviews }, 'escalated')
    await notify($, `#${task.id}`, `rejected ${MAX_ROUNDS} times: your call (/orch retry ${task.id} <note> or /orch drop ${task.id})`)
    await alertPerson($, `Task #${task.id} rejected ${MAX_ROUNDS} times in review: your call`)
    return
  }
  const next = { ...task, round: task.round + 1, reviews }
  await patchTask($, task.id, { state: 'working', round: next.round, reviews, reviewer: '' })
  const { reason } = await briefWorker($, next, reworkBrief(await read($, self), next, verdict.findings))
  if (reason !== null) {
    await patchTask($, task.id, { state: 'blocked', report: blockedReport(`the review's findings reached no worker: ${reason}`) })
    await notify($, `#${task.id}`, `blocked: the review's findings reached no worker (${reason})`)
    await alertPerson($, `Task #${task.id} blocked: the review's findings reached no worker`)
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
  const bgId = await launch($, name, agentName(task.role), workerAgent(task.role, task.repo, await read($, self)), work, brief)
  if (!bgId) {
    return { worker: task.worker, isFresh: false, reason: `${task.worker} is gone and no new session could be launched` }
  }
  const briefedAt = await $.clock.now()
  await update($, workers, list => [...list, { name, bgId, repo: task.repo, role: task.role, ...work, task: task.id, brief, nudges: 0, briefedAt }])
  await patchTask($, task.id, { worker: name })
  await subscribeIdle($, name)

  return { worker: name, isFresh: true, reason: null }
}

/** Sends a worker its (new) brief, kept for a resend, with the idle subscription. */
async function sendBrief($: EngineInterface, name: string, text: string): Promise<string | null> {
  await patchWorker($, name, { brief: text, nudges: 0, briefedAt: await $.clock.now() })
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
  if (task.state !== 'queued') {
    await remember($, task, 'dropped')
  }
  if (task.dir) {
    await notify($, `#${id}`, `its clone is kept at ${task.dir}; remove it when done`)
  }
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
  if (sender) {
    await loadWorkspaces($)
  }
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
  if (worker) {
    await loadWorkspaces($)
  }
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
    await alertPerson($, `Task #${task.id}: ${name} went idle twice without reporting`)
    return
  }
  await patchWorker($, name, { nudges: (worker.nudges ?? 0) + 1 })
  await notify($, `#${task.id}`, `${name} went idle without reporting; its brief is sent again`)
  const reason = await send($, name, `${RESENT_HEADER}\n\n${worker.brief}`, true)
  if (reason !== null) {
    await patchTask($, task.id, { state: 'blocked', report: blockedReport(`${name} went idle without reporting and its brief could not be sent again: ${reason}`) })
    await alertPerson($, `Task #${task.id} blocked: ${name} went idle and could not be reached`)
  }
}

/**
 * `/orch pr <id>`: drafts the pull request of an approved task and shows it; nothing leaves the
 * machine. `/orch pr <id> confirm`: pushes the task branch and opens that pull request with gh.
 */
async function prTask($: EngineInterface, id: number, isConfirmed: boolean): Promise<string> {
  const task = (await read($, tasks)).find(t => t.id === id)
  if (!task) {
    return `No task #${id}.`
  }
  if (task.state !== 'approved') {
    return `Task #${id} is ${task.state}: only an approved task gets a pull request.`
  }
  if (isTarget(task.repo)) {
    return `Task #${id} ran on ${task.repo}, not a git repo: there is no branch to open a pull request from.`
  }
  if (task.pr) {
    return `Task #${id} already has its pull request: ${task.pr}`
  }
  if (!task.branch) {
    return `Task #${id}: its report named no branch, so there is nothing to push. Open the pull request by hand.`
  }
  const dir = `${ROOT}/${task.repo}`
  if ((await exec($, ['git', '-C', dir, 'remote', 'get-url', 'origin'])).exitCode !== 0) {
    return `Task #${id}: ${task.repo} is a local repo with no remote (origin): nothing to push, no pull request. Its work is on branch ${task.branch || '(see the report)'}.`
  }
  if (!isConfirmed) {
    const commits = (await exec($, ['git', '-C', dir, 'log', '--oneline', `${task.base || task.branchFrom}..${task.branch}`])).stdout.trim()
    if (!commits) {
      return `Task #${id}: no commit on ${task.branch} since ${task.branchFrom}; nothing to open.`
    }
    const reply = await $.model
      .complete({ model: ORCHESTRATOR_MODEL, system: PR_SYSTEM, prompt: prPrompt(task, commits), maxTokens: 2000, effort: 'medium' })
      .catch(() => null)
    await charge($, id, reply ? callCost(ORCHESTRATOR_MODEL, reply.usage) : 0)
    const draft = (reply?.isAnswered ? parsePr(reply.text) : null) ?? { title: firstLine(task.text).slice(0, 72), body: `${task.report}\n\n${PR_FOOTER}` }
    await patchTask($, id, { prDraft: draft })
    return [
      `Pull request for task #${id}, not sent yet:`,
      `Push ${task.branch} to origin, into ${task.branchFrom}.`,
      '',
      `Title: ${draft.title}`,
      '',
      draft.body,
      '',
      `Send it with /orch pr ${id} confirm.`,
    ].join('\n')
  }
  if (!task.prDraft) {
    return `Task #${id}: draft the pull request first with /orch pr ${id}, then confirm it.`
  }
  const base = await exec($, ['git', '-C', dir, 'ls-remote', '--exit-code', '--heads', 'origin', task.branchFrom])
  if (base.exitCode !== 0) {
    return `Not sent: ${task.branchFrom}, the branch it goes into, is not on origin. Push or merge it first, or open the pull request by hand.`
  }
  const pushed = await exec($, ['git', '-C', dir, 'push', '-u', 'origin', task.branch], ROOT, 180_000)
  if (pushed.exitCode !== 0) {
    return `Not sent: git push failed: ${oneLine(pushed.stderr).slice(0, 300)}`
  }
  const created = await exec(
    $,
    ['gh', 'pr', 'create', '--base', task.branchFrom, '--head', task.branch, '--title', task.prDraft.title, '--body', task.prDraft.body],
    dir,
    120_000,
  )
  const url = /https:\/\/\S+\/pull\/\d+/.exec(created.stdout)?.[0]
  if (created.exitCode !== 0 || !url) {
    return `${task.branch} was pushed, but gh could not open the pull request: ${oneLine(created.stderr || created.stdout).slice(0, 300)}`
  }
  await patchTask($, id, { pr: url })
  await notify($, `#${id}`, `pull request opened: ${url}`)
  return `Task #${id}: ${task.branch} pushed and pull request opened: ${url}`
}

/** `/orch followup <id> [note]`: a new task on an approved one's remaining review remarks, from its branch. */
async function followupTask($: EngineInterface, id: number, note: string): Promise<string> {
  const task = (await read($, tasks)).find(t => t.id === id)
  if (!task || task.state !== 'approved') {
    return `Task #${id} ${task ? `is ${task.state}` : 'does not exist'}: only an approved task gets a follow-up.`
  }
  const from = isTarget(task.repo) ? '' : task.branch ?? ''
  const queued = await queueTask($, { repo: task.repo, role: task.role, text: followupText(task, note), work: {}, after: [], from })
  return 'error' in queued ? `Not queued: ${queued.error}.` : `Follow-up of #${id} queued as #${queued.id} in ${task.repo}.\n${queued.lines}`
}

/** `/orch config [<repo>]`: the workspace files found, their faults, and what applies to a repo. */
async function configReport($: EngineInterface, repo: string): Promise<string> {
  const files = allWorkspaces().map(ws => `- ${ws.path} (${ws.file ?? 'orchestra.json'})`)
  return [
    `Workspaces under ${ROOT}: ${files.length ? '' : 'none, every repo gets the generic rules'}`,
    ...files,
    ...(workspaceErrors().length ? ['', 'Faults (the faulty part is ignored):', ...workspaceErrors().map(e => `- ${e}`)] : []),
    ...(repo ? ['', ...describe(repo.replace(new RegExp(`^${ROOT}/`), '').replace(/\/$/, ''))] : ['', 'Add a repo to see what applies to it: /orch config <repo>.']),
  ].join('\n')
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
      const answers: string[] = []
      for (const part of batch) {
        answers.push(await serial(() => addTask($, part)))
      }
      return answers.join('\n\n')
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
      if (!Number.isInteger(id)) {
        return 'Usage: /orch retry <id> [note]. A request that was not queued (questions asked) is answered with /orch answer <your answers>.'
      }
      return serial(() => retryTask($, id, rest.slice(1).join(' ')))
    case 'followup':
      return serial(() => followupTask($, id, rest.slice(1).join(' ')))
    case 'answer': {
      const asked = await read($, pending)
      if (!asked) {
        return 'No question is waiting for an answer.'
      }
      if (rest.length === 0) {
        return 'Usage: /orch answer <your answers>'
      }
      if (asked.create) {
        const create = asked.create
        return serial(() => answerCreate($, { input: asked.input, create }, rest.join(' ')))
      }
      const input = [asked.input, '', 'Answers to the questions asked about this request:', ...asked.questions.map(q => `- ${q}`), `→ ${rest.join(' ')}`].join('\n')
      return serial(() => upgradeTask($, input))
    }
    case 'config':
      return configReport($, rest[0] ?? '')
    case 'pr':
      return serial(() => prTask($, id, rest[1] === 'confirm'))
    case 'drop':
      await serial(() => dropTask($, id))
      return `Task #${id} dropped.`
    case 'stop-idle':
      await serial(() => stopIdleWorkers($))
      return 'Idle workers stopped.'
    default:
      if (rest.length === 0) {
        return 'Usage: /orch [task <repo> <description> [@role] [;; …] | prompt [<repo>] <request> [@role] [;; …] | answer <answers> | retry <id> [note] | followup <id> [note] | pr <id> [confirm] | drop <id> | config [<repo>] | stop-idle | <session> <message>]'
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
      description: 'Orchestra: `task <repo> <description> [@role]`, `prompt [<repo>] <request> [@role]` (brief written by the model first; without a repo it picks the repo; a workspace non-git target by its name), `answer <answers>`, `retry <id> [note]`, `followup <id> [note]`, `pr <id> [confirm]`, `drop <id>`, `config [<repo>]`, `stop-idle`, `<session> <message>`',
    })
    $.clock.every(REFRESH_MS, () => void refresh($))
    void refresh($)

    return next(e)
  })

  on('command.run', { command: 'orch' }, async ($, e) => {
    await loadWorkspaces($)
    await refresh($)
    const adopted = await serial(() => adoptQueue($)).catch(() => '')
    const before = added
    let text = `${adopted ? `${adopted}\n\n` : ''}${await runCommand($, e.args)}${configWarning()}`
    await saveQueue($).catch(() => undefined)
    if (added > before && !(await read($, remoteSeen)) && !(await read($, reminded))) {
      await update($, reminded, () => true)
      await log($, { direction: 'notice', peer: 'remote', text: 'reminder given: /remote-control to get the alerts on the phone' })
      text = `${text}\n\n${REMOTE_TIP}`
    }
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
    if (kind === 'bridge') {
      await update($, remoteSeen, () => true)
    }
    if (kind !== 'peer' && kind !== 'peer-send-message') {
      return next(e)
    }
    const { isOwn, digest } = await serial(() => onReceive($, e.text))
    if (isOwn) {
      await saveQueue($).catch(() => undefined)
    }
    if (digest) {
      return next({ ...e, text: digest })
    }

    return isOwn ? { drop: `orchestra: ${parseInbound(e.text).peer} report handled by the pipeline` } : next(e)
  })

  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'bridge') {
      await update($, remoteSeen, () => true)
    }
    const isPeer = e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message'
    const inbound = parseInbound(e.text)
    if (!isPeer && !inbound.isIdleNotice && inbound.peer === '?') {
      return next(e)
    }
    const { isOwn, digest } = await serial(() => onReceive($, e.text))
    if (isOwn) {
      await saveQueue($).catch(() => undefined)
    }
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
    const totalCost = Object.values(used).reduce((sum, u) => sum + u.cost, 0) + all.reduce((sum, t) => sum + (t.callCost ?? 0), 0)
    const taskCost = (task: Task) =>
      Object.entries(used)
        .filter(([name]) => name === task.worker || name.startsWith(`orch-review-${task.id}-`))
        .reduce((sum, [, u]) => sum + u.cost, 0) + (task.callCost ?? 0)
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
        {workspaceErrors().length > 0 && (
          <Text color="yellow">
            ⚠ workspace config: {workspaceErrors().length} fault{workspaceErrors().length === 1 ? '' : 's'}, see /orch config
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
    // What each busy session did last, under its row: the pane shows the work moving, not only its state.
    const lastActions = workerList
      .filter(w => w.task !== null && used[w.name]?.last)
      .map(w => (
        <Box key={`last-${w.name}`} paddingLeft={2}>
          <Text dimColor wrap="truncate-end">
            ↳ {w.name}: {used[w.name]?.last} · {ago(used[w.name]?.lastAt ?? now, now)} ago
          </Text>
        </Box>
      ))

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
          {lastActions}
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
