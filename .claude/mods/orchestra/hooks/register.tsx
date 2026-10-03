import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { FeedEntry, Peer, WorkerUsage, Setting, Sizing, Task, TaskState, Worker } from '../types'
import { dollars, fillBar, tokens, toUsage } from './usage'
import type { TranscriptTotals } from './usage'
import { BADGE, STATES, ago, lastFindings, ordered, reportLine, roundDots } from './view'
import { body, oneLine, parseBackgrounded, parseInbound, parseListing } from './parse'
import {
  MAX_ROUNDS,
  ORCHESTRATOR_MODEL,
  REVIEWER,
  SIZING_SYSTEM,
  UPGRADE_SYSTEM,
  WORK_FLOOR,
  agentName,
  atLeast,
  defaultSizing,
  firstLine,
  parseStatus,
  parseNeeds,
  parseOverrides,
  parseSizing,
  parseTask,
  parseUpgrade,
  parseVerdict,
  plan,
  reviewBrief,
  reviewerAgent,
  reworkBrief,
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

async function refresh($: EngineInterface) {
  const ran = await $.tool.call({ tool: 'ListAgents' })
  if (ran.deny !== undefined) {
    await log($, { direction: 'notice', peer: '-', text: `ListAgents refused: ${ran.deny}` })
    return
  }
  const listing = (ran.result as { listing?: string } | undefined)?.listing ?? ran.text ?? ''
  const parsed = parseListing(listing)
  const at = await $.clock.now()
  await update($, self, () => parsed.self)
  await update($, peers, () => parsed.peers)
  await update($, refreshedAt, () => at)
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

async function send($: EngineInterface, to: string, text: string) {
  await log($, { direction: 'out', peer: to, text: oneLine(text) })
  const result = await $.session.send({ to, text })
  if (!result.isDelivered) {
    await notify($, to, `not delivered: ${result.reason}`)
  }

  return result.isDelivered
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
  const why = work.model === asked.model ? sized.why : `${sized.why} (dev raised from ${asked.model} to the ${WORK_FLOOR} floor)`

  return { ...sized, work, why }
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
  const parsed = parseInput(input)
  if (!parsed) {
    return 'Usage: /orch prompt <repo> <request> [@role] [model:… effort:…]'
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

/** Gives every queued task that can start a worker: an idle one of its repo and role, or a new session. */
async function dispatch($: EngineInterface) {
  const me = await read($, self)
  for (const { task, worker } of plan(await read($, tasks), await read($, workers))) {
    // Every task of a repo branches from where the repo stood at its first task, not from
    // whatever task branch the previous worker left checked out.
    const git = (...args: string[]) => exec($, ['git', '-C', `${ROOT}/${task.repo}`, ...args])
    const branchFrom =
      (await read($, tasks)).find(t => t.repo === task.repo && t.branchFrom)?.branchFrom ??
      (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
    const head = await git('rev-parse', branchFrom || 'HEAD')
    if (head.exitCode !== 0) {
      await patchTask($, task.id, { state: 'blocked', report: `not a git repo: ${ROOT}/${task.repo}` })
      await notify($, `#${task.id}`, `blocked: ${ROOT}/${task.repo} is not a git repository`)
      continue
    }
    const started: Task = { ...task, state: 'working', branchFrom, base: head.stdout.trim() }
    const brief = workerBrief(me, started)

    if (worker) {
      await patchTask($, task.id, { state: 'working', branchFrom, base: started.base, worker: worker.name })
      await patchWorker($, worker.name, { task: task.id })
      await send($, worker.name, brief)
      continue
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
    await update($, workers, list => [...list, { name, bgId, repo: task.repo, role: task.role, ...work, task: task.id }])
    await patchTask($, task.id, { state: 'working', branchFrom, base: started.base, worker: name })
  }
}

async function startReview($: EngineInterface, task: Task) {
  const me = await read($, self)
  const name = `orch-review-${task.id}-r${task.round}`
  const { review } = task.sizing
  const bgId = await launch($, name, REVIEWER, reviewerAgent(), review, reviewBrief(me, task))
  if (!bgId) {
    await patchTask($, task.id, { state: 'blocked' })
    return
  }
  await update($, workers, list => [...list, { name, bgId, repo: task.repo, role: 'reviewer', ...review, task: task.id }])
  await patchTask($, task.id, { state: 'reviewing', reviewer: name })
}

async function onWorkerReport($: EngineInterface, worker: Worker, text: string) {
  const task = (await read($, tasks)).find(t => t.id === worker.task)
  const status = parseStatus(text)
  if (!task || task.state !== 'working' || !status) {
    return
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

async function onReviewerReport($: EngineInterface, reviewer: Worker, text: string) {
  const task = (await read($, tasks)).find(t => t.id === reviewer.task)
  const verdict = parseVerdict(text)
  if (!task || task.state !== 'reviewing' || !verdict) {
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
    return
  }
  if (task.round >= MAX_ROUNDS) {
    await patchTask($, task.id, { state: 'escalated', reviews })
    await notify($, `#${task.id}`, `rejected ${MAX_ROUNDS} times: your call (/orch retry ${task.id} <note> or /orch drop ${task.id})`)
    return
  }
  const next = { ...task, round: task.round + 1, reviews }
  await patchTask($, task.id, { state: 'working', round: next.round, reviews, reviewer: '' })
  await send($, task.worker, reworkBrief(await read($, self), next, verdict.findings))
}

/** The person's answer to a blocked or escalated task: back to its worker, an escalated one with fresh rounds. */
async function retryTask($: EngineInterface, id: number, note: string) {
  const task = (await read($, tasks)).find(t => t.id === id)
  if (!task || (task.state !== 'blocked' && task.state !== 'escalated') || !task.worker) {
    $.ui.toast(`Task #${id} is not waiting for you.`)
    return
  }
  const findings = task.reviews.at(-1)?.findings ?? ''
  const next = { ...task, round: task.state === 'escalated' ? 1 : task.round }
  await patchTask($, id, { state: 'working', round: next.round })
  const answer = note ? `The person answered: ${note}` : 'The person asks you to continue.'
  await send($, task.worker, reworkBrief(await read($, self), next, [answer, findings].filter(Boolean).join('\n\n')))
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

/** Logs a delivery and moves the pipeline on; true when it came from one of the orchestrator's own sessions. */
async function onReceive($: EngineInterface, text: string) {
  const inbound = parseInbound(text)
  if (inbound.isIdleNotice) {
    await log($, { direction: 'notice', peer: inbound.peer, text: 'is idle now' })
    return false
  }
  await log($, { direction: 'in', peer: inbound.peer, text: oneLine(text) })
  const sender = (await read($, workers)).find(w => w.name === inbound.peer)
  if (sender?.role === 'reviewer') {
    await onReviewerReport($, sender, text)
  } else if (sender) {
    await onWorkerReport($, sender, text)
  }

  return sender !== undefined
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
        return 'Usage: /orch prompt <repo> <request> [@role] [model:… effort:…] [;; <repo> <request>…]'
      }
      const answers: string[] = []
      for (const part of batch) {
        answers.push(await serial(() => upgradeTask($, part)))
      }
      return answers.join('\n\n')
    }
    case 'retry':
      await serial(() => retryTask($, id, rest.slice(1).join(' ')))
      return `Task #${id} sent back to its worker.`
    case 'drop':
      await serial(() => dropTask($, id))
      return `Task #${id} dropped.`
    case 'stop-idle':
      await serial(() => stopIdleWorkers($))
      return 'Idle workers stopped.'
    default:
      if (rest.length === 0) {
        return 'Usage: /orch [task <repo> <description> [@role] [;; …] | prompt <repo> <request> [@role] [;; …] | retry <id> [note] | drop <id> | stop-idle | <session> <message>]'
      }
      await send($, verb, rest.join(' '))
      return `Sent to ${verb}.`
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'orch',
      description: 'Orchestra: `task <repo> <description> [@role]`, `prompt <repo> <request> [@role]` (brief written by the model first), `retry <id> [note]`, `drop <id>`, `stop-idle`, `<session> <message>`',
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
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    if ((kind === 'peer' || kind === 'peer-send-message') && (await serial(() => onReceive($, e.text)))) {
      return { drop: `orchestra: ${parseInbound(e.text).peer} report handled by the pipeline` }
    }

    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    const isPeer = e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message'
    const inbound = parseInbound(e.text)
    if ((isPeer || inbound.isIdleNotice || inbound.peer !== '?') && (await serial(() => onReceive($, e.text)))) {
      return { consumed: 'orchestra: report handled by the pipeline' }
    }

    return next(e)
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
        <Section title="Sessions" right={`context · tokens · est. cost · ${others.length} other · x stop idle · r refresh`}>
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
