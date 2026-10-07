import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { deliveryFailure, isAutoModeHold, parseBackgrounded, parseListing } from '../hooks/parse'
import { dollars, fillBar, toUsage } from '../hooks/usage'
import { SIZING_SYSTEM, capabilitiesFor, UPGRADE_SYSTEM, atLeast, hasTickets, reviewerAgent, workerAgent, parseRouting, parseNeeds, parseOverrides, parseSizing, parseStatus, parseUpgrade, parseVerdict, plan, reviewBrief, roleFor, upgradePrompt, workerBrief } from '../hooks/pipeline'
import type { HistoryEntry, Task, Worker } from '../types'
import { checksFor, describe, parallelFor, parseWorkspaces, setWorkspaces } from '../hooks/workspace'
import type { Workspace } from '../hooks/workspace'

const LISTING = [
  'This session is app-22 [46a73a] — the name other sessions use to message it.',
  '',
  'Peer sessions (1):',
  '  app-71 [e601b7]  ·  interactive  ·  idle  ·  started 18h ago',
].join('\n')

const PANE_PROPS = {
  title: 'Orchestra',
  isFocused: true,
  bodyColumns: 120,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const SIZING = { work: { model: 'opus', effort: 'high' }, review: { model: 'opus', effort: 'xhigh' }, why: 'routine backend fix' }

/** A workspace as its orchestra.json would set it: the project rules the tests run under. */
const WORKSPACES: Workspace[] = [
  {
    path: 'acme',
    roles: {
      list: { 'lead-backend': 'engineering', 'lead-frontend': 'engineering', dba: 'engineering', 'platform-engineer': 'engineering', 'qa-automation': 'engineering', 'tech-writer': 'communication' },
      byRepo: [['frontend|design', 'lead-frontend'], ['e2e', 'qa-automation'], ['database', 'dba'], ['^utils/acme$|infra', 'platform-engineer']],
      default: 'lead-backend',
      light: ['tech-writer'],
      worker: ['Before your first task, read {workspace}/roles/{folder}/{role}.md.'],
      reviewer: ['Apply {workspace}/review.md.'],
    },
    tickets: {
      name: 'tracker ACME',
      key: 'ACME-\\d+',
      worker: ['Branch named after the ticket key of the task (ACME-<n>), created from {from} (git switch -c <key> {start}), never from another task\'s branch.'],
    },
    integration: { datalodestar: 'make integration' },
    overview: ['agents/project-overview.md'],
    targets: {
      stack: {
        about: 'the running local Acme stack',
        role: 'platform-engineer',
        worker: ['Local stack only: never touch a remote system and never push anything anywhere.'],
        review: ['Read-only checks here: docker ps/inspect/logs, SELECT queries.'],
      },
    },
  },
]
setWorkspaces(WORKSPACES)

/** The workspaces hooks/repos.py answers in the tests; `serve` changes them for one test. */
let served: Workspace[] = WORKSPACES
const serve = (list: Workspace[]) => {
  served = list
  setWorkspaces(list)
}

/** The state badge of task #id as drawn in the pane, or undefined when the task is not listed. */
const stateOf = async (ui: { find: (q: { key: string }) => Promise<{ text?: string } | undefined> }, id: number) =>
  (await ui.find({ key: `state-${id}` }))?.text

const from = (name: string, text: string) =>
  `<cross-session-message from="uds:/tmp/x.sock" from-name="${name}" from-mode="prompting">\n${text}\n</cross-session-message>`

const task = (id: number, repo: string, state: Task['state'], role = 'lead-backend'): Task => ({
  id,
  repo,
  role,
  text: `task ${id}`,
  state,
  round: 1,
  worker: '',
  reviewer: '',
  base: '',
  report: '',
  branchFrom: '',
  sizing: SIZING,
  reviews: [],
  updatedAt: 0,
})

test('reads the ListAgents listing', async () => {
  const { self, peers } = parseListing(LISTING)
  expect(self).toBe('app-22')
  expect(peers.map(p => p.name)).toEqual(['app-71'])
})

test('reads the launcher output, coloured or not', async () => {
  // As captured from a real launch run by the mod.
  const coloured = 'backgrounded · \u001b[36m4bd9dce1\u001b[39m · orch-lead-backend-orch-sandbox\n\u001b[2m  claude agents\u001b[22m\n'
  expect(parseBackgrounded(coloured)).toEqual({ id: '4bd9dce1', name: 'orch-lead-backend-orch-sandbox' })
  expect(parseBackgrounded('backgrounded · ffec4ded · api-tests\n')).toEqual({ id: 'ffec4ded', name: 'api-tests' })
})

test('picks the role from the repo, or from @role', async () => {
  expect(roleFor('acme/core/acme-frontend', 'fix the menu').role).toBe('lead-frontend')
  expect(roleFor('acme/core/acme-backend', 'add an index @dba')).toEqual({ role: 'dba', text: 'add an index' })
  expect(roleFor('acme/core/acme-backend', 'mail @nobody').role).toBe('lead-backend')
  expect(roleFor('acme/utils/acme', 'add a tag').role).toBe('platform-engineer')
  // Outside any workspace: the generic role.
  expect(roleFor('utils/acme', 'add a tag').role).toBe('developer')
})

test('ticket rules apply only when the request names a key', async () => {
  const task = (repo: string, text: string) => ({ id: 7, repo, text, branchFrom: 'main', round: 1, report: '', reviews: [] }) as unknown as Task
  // No key named: no ticket rules, even in a workspace with a tracker.
  expect(hasTickets('acme/core/acme-backend')).toBe(false)
  expect(hasTickets('acme/core/acme-backend', 'fix the export')).toBe(false)
  expect(workerBrief('orch', task('acme/core/acme-backend', 'fix the export'))).not.toContain('ACME-<n>')
  expect(workerBrief('orch', task('acme/core/acme-backend', 'fix the export'))).toContain('git switch -c <branch> main')
  expect(workerBrief('orch', task('acme/core/acme-backend', 'fix the export'))).toContain('never look for or ask for a key')
  expect(reviewBrief('orch', task('acme/core/acme-backend', 'fix'))).toContain('names no ticket key')
  expect(upgradePrompt('acme/core/acme-backend', 'lead-backend', 'x')).toContain('names no ticket key')
  // A key named: the tracker's rules, in the workspace or anywhere else.
  expect(hasTickets('acme/core/acme-backend', 'ACME-7400 fix')).toBe(true)
  expect(hasTickets('mtg', 'ACME-7400 add a deck page')).toBe(true)
  expect(workerBrief('orch', task('mtg', 'ACME-7400 add a deck page'))).toContain('ACME-<n>')
  expect(reviewBrief('orch', task('mtg', 'ACME-7400 x'))).not.toContain('names no ticket key')
  expect(upgradePrompt('mtg', 'lead-backend', 'ACME-7400 x')).toContain('ticket task: tracker ACME')
  // Look-alikes are not keys.
  expect(hasTickets('acme/core/acme-backend', 'UTF-8 names, ORCH-3, XACME-1')).toBe(false)
})

test('without a workspace the mod knows no project: generic role, no tickets, no target', () => {
  setWorkspaces([])
  try {
    const task = { id: 9, repo: 'acme/core/acme-backend', text: 'ACME-1 fix', branchFrom: 'main', round: 1, report: '', reviews: [] } as unknown as Task
    expect(roleFor('acme/core/acme-backend', 'fix @dba').role).toBe('developer')
    expect(hasTickets('acme/core/acme-backend', 'ACME-1 fix')).toBe(false)
    expect(workerBrief('orch', task)).toContain('names no ticket key')
    expect(workerBrief('orch', { ...task, repo: 'stack' })).toContain('Repo: /app/stack')
    expect(workerAgent('developer', 'mtg')).not.toContain('read')
    expect(reviewerAgent('mtg')).toContain('no 🔴 blocking and no 🟠 major')
  } finally {
    setWorkspaces(WORKSPACES)
  }
})

test('the rules of a workspace reach its sessions, placeholders filled', () => {
  expect(workerAgent('dba', 'acme/core/acme-database')).toContain('read /app/acme/roles/engineering/dba.md')
  expect(reviewerAgent('acme/core/acme-backend')).toContain('Apply /app/acme/review.md.')
  expect(reviewerAgent('mtg')).not.toContain('review.md')
  expect(workerBrief('orch', { id: 3, repo: 'acme/core/acme-backend', text: 'ACME-3 x', branchFrom: 'develop', round: 1, report: '', reviews: [] } as unknown as Task)).toContain('git switch -c <key> develop')
})

test('a faulty workspace file is named, its faulty part dropped, the rest kept', () => {
  const read = parseWorkspaces(
    JSON.stringify([
      { path: 'a', file: 'a/orchestra.json', tickets: { name: 'T', key: 'T-(', worker: [] }, parallel: 2 },
      { path: 'b', file: 'b/cfg/orchestra.json', error: 'not readable JSON (line 1)' },
      { roles: {} },
      { path: '', file: 'orchestra.json', newApp: 'compose' },
      { path: 'c', roles: { byRepo: [['front', 'lead-frontend']] }, checks: { '.': 'go test' }, checkTimeout: 900 },
    ]),
  )
  // Path '' is the root's own file.
  expect(read.workspaces.map(w => w.path)).toEqual(['a', '', 'c'])
  expect(read.workspaces[0]).toMatchObject({ parallel: 2 })
  expect(read.workspaces[0]?.tickets).toBeUndefined()
  expect(read.workspaces[2]?.checks).toBeUndefined()
  expect(read.errors).toEqual([
    'a/orchestra.json: tickets key "T-(" is not a valid regex; ignored',
    'b/cfg/orchestra.json: not readable JSON (line 1); the whole file is ignored',
    'orchestra.json: newApp must be a list of lines; ignored',
    'c: checks must map a repo path to a list of commands; ignored',
    'c: checkTimeout must be a whole number of seconds from 1 to 600; ignored',
  ])
  expect(parseWorkspaces('not json')).toEqual({ workspaces: [], errors: [] })
})

test('an inner workspace folder refines the outer one', () => {
  setWorkspaces([
    { ...(WORKSPACES[0] as Workspace), checks: { '*': ['make lint'] } },
    { path: 'acme/core', checks: { 'acme-backend': ['go vet ./...'] }, roles: { default: 'dba' }, parallel: 3 },
  ])
  try {
    expect(checksFor('acme/core/acme-backend')).toEqual(['go vet ./...', 'make lint'])
    expect(checksFor('acme/core/acme-frontend')).toEqual(['make lint'])
    expect(roleFor('acme/core/acme-backend', 'x').role).toBe('dba')
    // The outer roles stay known beside the inner ones.
    expect(roleFor('acme/core/acme-backend', 'x @tech-writer').role).toBe('tech-writer')
    expect(parallelFor('acme/core/acme-backend')).toBe(3)
    expect(parallelFor('acme/datalodestar')).toBe(1)
    expect(describe('acme/core/acme-backend').join('\n')).toContain('Checks before review: go vet ./... && make lint')
  } finally {
    setWorkspaces(WORKSPACES)
  }
})

test('reads a verdict and its findings', async () => {
  expect(parseVerdict(from('r', 'VERDICT: CHANGES_REQUESTED\nFINDINGS:\n- 🔴 a.php:3 — x — y'))).toEqual({
    isApproved: false,
    findings: '- 🔴 a.php:3 — x — y',
  })
  expect(parseVerdict(from('r', 'VERDICT: APPROVED\nFINDINGS:\n'))?.isApproved).toBe(true)
  expect(parseVerdict(from('r', 'looks fine'))).toBeNull()
  // As a real reviewer wrote it on 2026-10-03: the verdict on the same line as its prefix, never repeated.
  expect(parseVerdict(from('r', '[task #2 · round 1] VERDICT: APPROVED\nFINDINGS:\n- ⚪ a.ts:1 — x'))).toEqual({ isApproved: true, findings: '- ⚪ a.ts:1 — x' })
  expect(parseStatus('[task #2 · round 1] STATUS: blocked — no Jira key')).toBe('blocked')
})

test('keeps the question a report leaves for the person', async () => {
  expect(parseNeeds('STATUS: done\nNEEDS: does slugify() need to transliterate œ/æ/ß?')).toBe('does slugify() need to transliterate œ/æ/ß?')
  expect(parseNeeds('STATUS: done\nNEEDS: none. The brief asks for ACME-<n>.')).toBeNull()
  expect(parseNeeds('STATUS: done')).toBeNull()
})

test('one active task per repo, one task per worker', async () => {
  const idle: Worker = { name: 'w1', bgId: 'a', repo: 'acme/core/b', role: 'lead-backend', model: 'opus', effort: 'high', task: null }
  const moves = plan(
    [task(1, 'acme/core/b', 'working'), task(2, 'acme/core/b', 'queued'), task(3, 'core/f', 'queued'), task(4, 'core/f', 'queued')],
    [idle],
  )
  expect(moves.map(m => [m.task.id, m.worker?.name ?? null])).toEqual([[3, null]])
  expect(plan([task(2, 'acme/core/b', 'queued')], [idle]).map(m => m.worker?.name)).toEqual(['w1'])
  // An idle worker set up with another model is not reused.
  expect(plan([task(2, 'acme/core/b', 'queued')], [{ ...idle, model: 'sonnet' }]).map(m => m.worker)).toEqual([null])
})

test('reads the sizing reply and the forced settings', async () => {
  expect(parseSizing('Sure:\n{"work":{"model":"fable","effort":"xhigh"},"review":{"model":"opus","effort":"high"},"why":"risky"}')).toEqual({
    work: { model: 'fable', effort: 'xhigh' },
    review: { model: 'opus', effort: 'high' },
    why: 'risky',
  })
  expect(parseSizing('{"work":{"model":"gpt","effort":"high"},"review":{"model":"opus","effort":"high"}}')).toBeNull()
  expect(parseSizing('no json')).toBeNull()
  expect(parseOverrides('fix it model:sonnet effort:low now')).toEqual({ text: 'fix it now', work: { model: 'sonnet', effort: 'low' }, after: [], from: '' })
  expect(parseOverrides('fix after:#3,4 it after:2 from:main')).toEqual({ text: 'fix it', work: {}, after: [3, 4, 2], from: 'main' })
  expect(parseOverrides('fix model:gpt').work).toEqual({})
})

test('development is floored at opus, effort kept', async () => {
  expect(atLeast({ model: 'haiku', effort: 'low' }, 'opus')).toEqual({ model: 'opus', effort: 'low' })
  expect(atLeast({ model: 'sonnet', effort: 'medium' }, 'opus')).toEqual({ model: 'opus', effort: 'medium' })
  expect(atLeast({ model: 'fable', effort: 'xhigh' }, 'opus')).toEqual({ model: 'fable', effort: 'xhigh' })
})

/** What SendMessage answers for a name it cannot reach, as a plugin's `$.tool.call` saw it on 2026-10-03. */
const unreachable = (name: string) => ({
  success: false,
  message: `No agent named '${name}' is reachable.\nUse ListAgents to see everyone you can message.`,
  display: `Not sent — no agent named '${name}' is reachable.`,
})

/** Answers what the orchestrator runs: git for the base, claude to start and stop sessions. */
const AUTO_MODE_HOLD =
  'The server-side auto mode classifier gave no verdict for SendMessage: the request that produced this action did not ask for one. Issue the action again once, as-is.'

const world = (on: On, sizingReply: string | null = JSON.stringify(SIZING), replyFor: (e: { system?: string; prompt: string }) => string | null = () => sizingReply) => {
  const launched: { name: string; agent: string; model: string; effort: string; prompt: string }[] = []
  const asked: { model: string; prompt: string }[] = []
  const stopped: string[] = []
  const sent: { to: string; text: string }[] = []
  let ids = 0
  let python: (argv: readonly string[]) => string = () => '{}'

  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 3, 10, 0) })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.receive', (_$, e) => ({ text: e.text }))
  // Like the real ones: ListAgents lists the sessions launched and still running, and SendMessage
  // cannot reach the others. `kill` stands for the daemon stopping an idle session.
  const running = new Map<string, string>()
  const others = parseListing(LISTING).peers.map(p => p.name)
  // Every message the orchestrator tried to send, delivered or not.
  const tried: string[] = []
  on('tool.call', { tool: 'ListAgents' }, () => ({
    result: {
      listing: [LISTING, ...[...running].map(([name, id]) => `  ${name} [${id.slice(-6)}]  ·  bg  ·  idle  ·  started 1m ago`)].join('\n'),
    },
  }))
  on('model.complete', (_$, e) => {
    asked.push({ model: e.model, prompt: e.prompt })
    const reply = replyFor(e)
    return {
      value:
        reply === null
          ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' }
          : { isAnswered: true, text: reply, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    } as never
  })
  // Briefs go through the SendMessage tool (the idle subscription rides on it); a call
  // without a message is the subscription alone and is not a delivery.
  const watched: string[] = []
  let refuse: string | null = null
  let holds = 0
  const submitted: string[] = []
  on('prompt.submit', (_$, e) => {
    if (e.origin.kind === 'plugin') {
      submitted.push(e.text)
    }
    return { text: e.text }
  })
  on('tool.call', { tool: 'SendMessage' }, (_$, e) => {
    const to = String(e.to)
    if (e.message) {
      tried.push(to)
    }
    if (e.message && holds > 0) {
      holds -= 1
      return { deny: AUTO_MODE_HOLD } as never
    }
    if (!running.has(to) && !others.includes(to)) {
      return { result: unreachable(to) }
    }
    if (refuse !== null) {
      return { result: { success: false, message: refuse } }
    }
    if (e.notify_when_idle) {
      watched.push(to)
    }
    if (e.message) {
      sent.push({ to, text: String(e.message) })
    }
    return { result: { success: true } }
  })
  // Every command run, and the person's desktop alerts.
  const commands: string[][] = []
  const alerts: string[] = []
  on('tool.call', { tool: 'PushNotification' }, (_$, e) => {
    alerts.push(String(e.message))
    return { result: { sent: true } }
  })
  // Folders: missing ones, ones that are not a repo yet, repos with no commit, repos with no remote.
  const missing = new Set<string>()
  const fresh = new Set<string>()
  const unborn = new Set<string>()
  const noIdentity = new Set<string>()
  const noRemote = new Set<string>()
  // The exit codes the orchestrator's checks get, in order (0 once they run out).
  const checkExits: number[] = []
  const files = new Map<string, string>()
  on('fs.exists', (_$, e) => ({ value: !missing.has(e.path) }) as never)
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    return { value: text } as never
  })
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  const done = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode ? 'fatal: fake failure' : '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) => {
    const [cmd, sub, ...rest] = e.argv
    commands.push([...e.argv])
    let stdout = ''
    const dir = e.argv.includes('-C') ? e.argv[e.argv.indexOf('-C') + 1] ?? '' : ''
    if (cmd === 'git' && fresh.has(dir)) {
      if (e.argv.includes('init')) {
        fresh.delete(dir)
        unborn.add(dir)
        noIdentity.add(dir)
        return done('')
      }
      return done('', 128)
    }
    if (cmd === 'git' && unborn.has(dir) && e.argv.includes('commit')) {
      unborn.delete(dir)
      return done('')
    }
    if (cmd === 'git' && unborn.has(dir) && e.argv.includes('--verify')) {
      return done('', 1)
    }
    if (cmd === 'git' && e.argv.includes('config') && e.argv.includes('user.email')) {
      return done(noIdentity.has(dir) ? '' : 'me@example.com\n', noIdentity.has(dir) ? 1 : 0)
    }
    if (cmd === 'git' && e.argv.includes('remote') && noRemote.has(dir)) {
      return done('', 2)
    }
    if (cmd === 'sh') {
      const exit = checkExits.shift() ?? 0
      return done(exit ? 'lint: 3 problems\nsrc/a.go:4: unused variable x' : 'ok\n', exit)
    }
    if (cmd === 'python3' && e.argv[2] === '--workspaces') {
      stdout = JSON.stringify(served)
    } else if (cmd === 'python3') {
      stdout = python(e.argv)
    } else if (cmd === 'git' && e.argv.includes('--verify') && e.argv.some(a => a.startsWith('nope'))) {
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    } else if (cmd === 'git' && e.argv.includes('--show-toplevel')) {
      // Every repo of the tests is a repo of its own, with commits; a folder under mtg/ is inside mtg.
      stdout = dir.startsWith('/app/mtg/') ? '/app/mtg\n' : `${dir}\n`
    } else if (cmd === 'git') {
      stdout = e.argv.includes('--abbrev-ref') ? 'main\n' : e.argv.includes('--show-current') ? 'main\n' : 'abc123\n'
    } else if (cmd === 'gh') {
      stdout = 'https://github.com/QuentinJost/DataLodestar/pull/7\n'
    } else if (cmd === 'claude' && sub === '--bg') {
      ids += 1
      const flag = (name: string) => rest[rest.indexOf(name) + 1] ?? ''
      const name = flag('-n')
      launched.push({ name, agent: flag('--agent'), model: flag('--model'), effort: flag('--effort'), prompt: rest.at(-1) ?? '' })
      const id = String(ids).padStart(8, '0')
      running.set(name, id)
      stdout = `backgrounded · ${id} · ${name}\n`
    } else if (cmd === 'claude' && sub === 'stop') {
      stopped.push(rest[0] ?? '')
      for (const [name, id] of running) {
        if (id === rest[0]) {
          running.delete(name)
        }
      }
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return {
    launched,
    stopped,
    sent,
    tried,
    watched,
    asked,
    clock,
    submitted,
    commands,
    alerts,
    holdSends: (count: number) => {
      holds = count
    },
    onPython: (answer: typeof python) => {
      python = answer
    },
    refuseSends: (reason: string | null) => {
      refuse = reason
    },
    missing,
    fresh,
    noRemote,
    checkExits,
    files,
    kill: (name: string) => {
      running.delete(name)
    },
  }
}

const orch = async ($: Parameters<TestBody>[0], args: string) =>
  $.command.run({ command: 'orch', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

const receive = async ($: Parameters<TestBody>[0], name: string, text: string) =>
  $.session.receive({ origin: { kind: 'peer' }, text: from(name, text) })

test('dispatches, reviews, reworks, approves and reuses the worker', async ($, on) => {
  const { launched, stopped, sent } = world(on)

  await orch($, 'task acme/core/acme-backend ACME-7300 fix the export')
  await orch($, 'task acme/core/acme-backend ACME-7301 second backend task')
  await orch($, 'task acme/core/acme-frontend ACME-7302 fix the menu')

  // Two repos, two workers launched with their agents; the second backend task waits.
  expect(launched.map(l => [l.name, l.agent])).toEqual([
    ['orch-lead-backend-acme-backend', 'orch-lead-backend'],
    ['orch-lead-frontend-acme-frontend', 'orch-lead-frontend'],
  ])
  expect(launched[0]?.prompt).toMatch(/^\[ORCH app-22 · task #1 · round 1\] ACME-7300 fix the export/)
  expect(launched[0]?.prompt).toContain('created from main (git switch -c <key> main)')

  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 2)).toBe('◌ queued')

  // Worker done → a fresh reviewer session, diffing against the base.
  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: export fixed\nCHANGES: ACME-7300, 1 commit')
  expect(launched[2]?.name).toBe('orch-review-1-r1')
  expect(launched[2]?.agent).toBe('orch-reviewer')
  expect(launched[2]?.prompt).toContain('diff abc123')
  expect(launched[2]?.prompt).toContain('SUMMARY: export fixed')

  // Rejected → reviewer removed, findings back to the same worker, round 2.
  await receive($, 'orch-review-1-r1', 'VERDICT: CHANGES_REQUESTED\nFINDINGS:\n- 🔴 Export.php:12 — no test — add one')
  expect(stopped).toEqual(['00000003'])
  const rework = sent.find(s => s.to === 'orch-lead-backend-acme-backend')
  expect(rework?.text).toMatch(/task #1 · round 2/)
  expect(rework?.text).toContain('Export.php:12')

  // Done again → second reviewer → approved → task 2 goes to the same, now idle, worker.
  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: test added')
  expect(launched[3]?.name).toBe('orch-review-1-r2')
  expect(launched[3]?.prompt).toContain('Round 1:')
  // The approval is the one report the model is handed, as a digest to write up for the person.
  const approved = await receive($, 'orch-review-1-r2', 'VERDICT: APPROVED\nFINDINGS:\n- ⚪ Export.php:40 — long line — optional')
  expect(approved).toMatchObject({ text: expect.stringContaining('[ORCH app-22] Task #1 approved at round 2 in acme/core/acme-backend: ACME-7300 fix the export') })
  expect((approved as { text: string }).text).toContain('SUMMARY: test added')
  expect((approved as { text: string }).text).toContain('Export.php:40')
  expect((approved as { text: string }).text).toContain('Write this up for the person')

  // Approved tasks are folded away until `a` shows them.
  expect(await stateOf(ui, 1)).toBeUndefined()
  await ui.press({ key: 'toggle-done' })
  expect(await stateOf(ui, 1)).toBe('✔ approved')
  expect(await stateOf(ui, 2)).toBe('● working')
  expect(launched).toHaveLength(4)
  expect(sent.at(-1)?.to).toBe('orch-lead-backend-acme-backend')
  expect(sent.at(-1)?.text).toMatch(/task #2 · round 1/)
  expect(sent.at(-1)?.text).toContain('created from main')

  // Reports of its own sessions never reach the model; anyone else's do.
  expect(await receive($, 'orch-lead-frontend-acme-frontend', 'progress note')).toEqual({ consumed: 'orchestra: report handled by the pipeline' })
  expect(await receive($, 'app-71', 'hello')).toMatchObject({ text: expect.any(String) })
})

test('hands the task to the person after three rejections, and retry restarts it', async ($, on) => {
  const { launched, sent } = world(on)
  await orch($, 'task acme/core/acme-backend ACME-7300 fix the export')
  const worker = 'orch-lead-backend-acme-backend'

  for (const round of [1, 2, 3]) {
    await receive($, worker, 'STATUS: done')
    await receive($, `orch-review-1-r${round}`, `VERDICT: CHANGES_REQUESTED\nFINDINGS:\n- 🟠 round ${round}`)
  }
  expect(launched.filter(l => l.agent === 'orch-reviewer')).toHaveLength(3)

  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 1)).toBe('⚠ your call')
  expect(await ui.find({ key: 'retry-1' })).toBeDefined()

  await orch($, 'retry 1 keep the old CSV header')
  expect(sent.at(-1)?.text).toContain('The person answered: keep the old CSV header')
  expect(await stateOf(ui, 1)).toBe('● working')
  expect(await ui.find({ type: 'Text', text: '●○○' })).toBeDefined()
})

test('a blocked report waits for the person', async ($, on) => {
  world(on)
  await orch($, 'task acme/core/acme-backend fix without a key')
  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: blocked\nNEEDS: the Jira key')
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 1)).toBe('⏸ blocked')
  expect(await ui.find({ type: 'Text', text: /1 task needs your decision/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\? the Jira key/ })).toBeDefined()

  await orch($, 'drop 1')
  expect(await stateOf(ui, 1)).toBeUndefined()
})

test('a blocked task whose worker reports done anyway goes to review', async ($, on) => {
  const { launched } = world(on)
  const worker = 'orch-lead-backend-datalodestar'
  await orch($, 'task acme/datalodestar bulk delete')
  await receive($, worker, 'STATUS: blocked\nNEEDS: a Jira key')
  // Unblocked outside the pipeline, the worker reports straight away.
  await receive($, worker, 'STATUS: done\nSUMMARY: bulk delete added')
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 1)).not.toBe('⏸ blocked')
  expect(launched.at(-1)?.name).toBe('orch-review-1-r1')
  expect(launched.at(-1)?.prompt).toContain('SUMMARY: bulk delete added')
})

test('a local peer report, which arrives as a submitted prompt, drives the pipeline and is dropped', async ($, on) => {
  const { launched } = world(on)
  await orch($, 'task acme/core/acme-backend ACME-7300 fix the export')

  // As in the real run: framed by the engine, origin peer.
  const submitted = await $.prompt.submit({
    text: `Another Claude session sent a message:\n${from('orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: fixed')}`,
    origin: { kind: 'peer' },
    wait: false,
  })
  expect(submitted).toEqual({ drop: 'orchestra: orch-lead-backend-acme-backend report handled by the pipeline' })
  const approved = await $.prompt.submit({
    text: `Another Claude session sent a message:\n${from('orch-review-1-r1', '[task #1 · round 1] VERDICT: APPROVED\nFINDINGS:\n')}`,
    origin: { kind: 'peer' },
    wait: false,
  })
  expect(approved).toMatchObject({ text: expect.stringContaining('Task #1 approved at round 1') })
  expect(launched.at(-1)?.name).toBe('orch-review-1-r1')

  // The same report through the other door moves nothing twice.
  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: fixed')
  expect(launched.filter(l => l.agent === 'orch-reviewer')).toHaveLength(1)

  // Someone else's message still reaches the model.
  expect(await $.prompt.submit({ text: from('app-71', 'hello'), origin: { kind: 'peer' }, wait: false })).toMatchObject({ text: expect.any(String) })
})

test('the orchestrator model sizes each session; forced settings and fallback', async ($, on) => {
  const { launched, asked, stopped } = world(on)
  await orch($, 'task acme/core/acme-backend ACME-7300 fix the export')

  expect(asked[0]?.model).toBe('fable')
  expect(asked[0]?.prompt).toContain('Role: lead-backend')
  expect(launched[0]).toMatchObject({ model: 'opus', effort: 'high' })
  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done')
  expect(launched[1]).toMatchObject({ name: 'orch-review-1-r1', model: 'opus', effort: 'xhigh' })
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')

  // Next task on the repo forces another setting: the idle worker makes room for a new one,
  // and a forced model below the floor is raised to opus.
  await orch($, 'task acme/core/acme-backend ACME-7301 rename a constant model:sonnet effort:low')
  expect(stopped).toContain('00000001')
  expect(launched[2]).toMatchObject({ model: 'opus', effort: 'low' })
  expect(launched[2]?.prompt).toContain('ACME-7301 rename a constant')
  expect(launched[2]?.prompt).not.toContain('model:')
})

test('falls back to the role defaults when the orchestrator model does not answer', async ($, on) => {
  const { launched } = world(on, null)
  await orch($, 'task acme/core/acme-backend ACME-7300 fix the export @tech-writer')
  expect(launched[0]).toMatchObject({ model: 'opus', effort: 'medium', agent: 'orch-tech-writer' })
})

test('a light model chosen for development is raised to the floor; the review keeps its choice', async ($, on) => {
  const { launched } = world(on, JSON.stringify({ work: { model: 'sonnet', effort: 'medium' }, review: { model: 'sonnet', effort: 'low' }, why: 'tiny fix' }))
  await orch($, 'task acme/core/acme-backend ACME-7300 fix a typo')
  expect(launched[0]).toMatchObject({ model: 'opus', effort: 'medium' })
  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done')
  expect(launched[1]).toMatchObject({ name: 'orch-review-1-r1', model: 'sonnet', effort: 'low' })
})

test('the band above the prompt sums up open tasks, and steps aside when none is open', async ($, on) => {
  world(on)
  // What the engine draws there when no plugin does.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const band = async () =>
    $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 } } as never })
  const idle = await band()
  expect(await idle.find({ type: 'Text', text: /orchestra/ })).toBeUndefined()
  expect(await idle.find({ type: 'Text', text: 'engine band' })).toBeDefined()

  await orch($, 'task acme/core/acme-backend ACME-7300 fix the export')
  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: blocked\nNEEDS: the key')
  const drawn = await band()
  expect(await drawn.find({ type: 'Text', text: /◆ orchestra/ })).toBeDefined()
  expect(await drawn.find({ type: 'Text', text: /⚠ 1 needs you/ })).toBeDefined()
})

test('queues several tasks in one command', async ($, on) => {
  const { launched } = world(on)
  const ran = await orch($, 'task acme/core/acme-backend ACME-1 a ;; acme/core/acme-frontend ACME-2 b ;; acme/core/acme-backend ACME-3 c')
  expect(ran).toMatchObject({ text: expect.stringContaining('Task #3 queued in acme/core/acme-backend.\nBranch starts from main') })
  expect(launched.map(l => l.name)).toEqual(['orch-lead-backend-acme-backend', 'orch-lead-frontend-acme-frontend'])
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 3)).toBe('◌ queued')
})

test('estimates cost and context fill from transcript totals', async () => {
  // A real reviewer transcript: Sonnet 5.5, 2 turns.
  const reviewer = toUsage(
    { model: 'claude-sonnet-5-5', context: 57_037, turns: 2, input: 4, output: 698, cacheRead: 78_029, cacheWrite5m: 0, cacheWrite1h: 30_292 },
    0,
  )
  // 4×2 + 698×10 + 30 292×4 + 78 029×0.2 = 143 761.8 µ$ → $0.1438
  expect(Math.abs(reviewer.cost - 0.1437618)).toBeLessThan(1e-9)
  expect(dollars(reviewer.cost)).toBe('$0.14')
  expect(fillBar(reviewer.context, reviewer.window)).toBe('▱▱▱▱▱ 6%')
  expect(fillBar(600_000, 1_000_000)).toBe('▰▰▰▱▱ 60%')
  expect(toUsage({ model: 'claude-haiku-4-5-20251001', context: 100_000, turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, 0).window).toBe(200_000)
  expect(toUsage({ model: '', context: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, 0)).toMatchObject({ cost: 0, isPriced: true })
  expect(toUsage({ model: 'some-future-model', context: 1, turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, 0).isPriced).toBe(false)
})

test('the pane shows each session context, tokens and cost, and keeps retired ones', async ($, on) => {
  const { launched, onPython } = world(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self0000-0000' }) as never)
  on('fs.list', () => ({ value: [
    { name: 'self0000-0000.jsonl', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    { name: '00000001-aaaa.jsonl', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    { name: '00000002-bbbb.jsonl', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
  ] }) as never)
  const totals = (model: string, context: number, output: number) => ({ model, context, turns: 3, input: 10, output, cacheRead: 100_000, cacheWrite5m: 0, cacheWrite1h: 20_000 })
  onPython(argv => {
    const dir = '/home/test/.claude/projects/-app'
    const out: Record<string, unknown> = {}
    for (const path of argv.slice(2)) {
      if (path === `${dir}/self0000-0000.jsonl`) out[path] = totals('claude-fable-5-1', 300_000, 5_000)
      if (path === `${dir}/00000001-aaaa.jsonl`) out[path] = totals('claude-opus-5-5', 850_000, 20_000)
      if (path === `${dir}/00000002-bbbb.jsonl`) out[path] = totals('claude-sonnet-5-5', 40_000, 700)
    }
    return JSON.stringify(out)
  })

  await orch($, 'task acme/core/acme-backend ACME-7300 fix the export')
  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done')
  expect(launched.map(l => l.name)).toEqual(['orch-lead-backend-acme-backend', 'orch-review-1-r1'])
  await orch($, '')
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  // The worker is near its window: red bar at 85 %.
  expect(await ui.find({ type: 'Text', text: '▰▰▰▰▱ 85%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▰▰▱▱▱ 30%' })).toBeDefined()

  // The reviewer is retired after its verdict; its cost stays counted.
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')
  expect(await ui.find({ type: 'Text', text: /\+ 1 retired session · \$0\.\d\d/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Σ \$\d+\.\d\d/ })).toBeDefined()
})

test('reads the Prompt Manager reply: a brief, questions, or nothing', async () => {
  expect(parseUpgrade('Sure:\n{"status":"ready","title":"ACME-7300 fix the export","brief":"## Objective\\nExport works."}')).toEqual({
    title: 'ACME-7300 fix the export',
    brief: '## Objective\nExport works.',
  })
  expect(parseUpgrade('{"status":"unclear","questions":["Which export?",""]}')).toEqual({ questions: ['Which export?'] })
  expect(parseUpgrade('{"status":"ready","title":"x","brief":"  "}')).toBeNull()
  expect(parseUpgrade('{"status":"unclear","questions":[]}')).toBeNull()
  expect(parseUpgrade('no json here')).toBeNull()
})

const BRIEF = { status: 'ready', title: 'ACME-7300 fix the CSV export of issues', brief: '## Objective\nThe CSV export of issues must include every column.\n\n## Done when\nphpunit export suite green.' }
const upgradeOrSize = (e: { system?: string; prompt: string }) => (e.system?.includes('Prompt Manager') ? JSON.stringify(BRIEF) : JSON.stringify(SIZING))

test('/orch prompt has the model write the brief, then queues and sizes that brief', async ($, on) => {
  const { launched, asked } = world(on, JSON.stringify(SIZING), upgradeOrSize)
  const ran = await orch($, 'prompt acme/core/acme-backend ACME-7300 fix the export @tech-writer model:sonnet effort:low')

  // 1st call: the upgrade, on the orchestrator model, with the request as typed, role and overrides stripped.
  expect(asked[0]?.model).toBe('fable')
  expect(asked[0]?.prompt).toContain('Request:\nACME-7300 fix the export')
  expect(asked[0]?.prompt).toContain('Developer role: tech-writer')
  expect(asked[0]?.prompt).not.toContain('model:')
  // 2nd call: the sizing, on the brief.
  expect(asked[1]?.prompt).toContain('Role: tech-writer')
  expect(asked[1]?.prompt).toContain('Task: ACME-7300 fix the CSV export of issues')

  // The worker gets the brief, under the forced setting (sonnet raised to the floor) and role.
  expect(launched[0]).toMatchObject({ agent: 'orch-tech-writer', model: 'opus', effort: 'low' })
  expect(launched[0]?.prompt).toContain('round 1] ACME-7300 fix the CSV export of issues')
  expect(launched[0]?.prompt).toContain('## Done when\nphpunit export suite green.')
  expect(launched[0]?.prompt).not.toContain('Task: ACME-7300 fix the export\n')

  // The person sees what was sent.
  expect(ran).toMatchObject({ text: expect.stringContaining('Task #1 queued in acme/core/acme-backend for tech-writer') })
  expect(ran).toMatchObject({ text: expect.stringContaining('## Objective') })
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 1)).toBe('● working')
})

test('/orch prompt on an unclear request asks instead of queuing', async ($, on) => {
  const { launched, asked } = world(on, JSON.stringify(SIZING), e =>
    e.system?.includes('Prompt Manager') ? JSON.stringify({ status: 'unclear', questions: ['Which export: CSV or PDF?', 'Jira key?'] }) : JSON.stringify(SIZING),
  )
  const ran = await orch($, 'prompt acme/core/acme-backend fix the export')
  expect(asked).toHaveLength(1)
  expect(launched).toHaveLength(0)
  expect(ran).toMatchObject({ text: expect.stringContaining('- Which export: CSV or PDF?') })
  expect(ran).toMatchObject({ text: expect.stringContaining('- Jira key?') })
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 1)).toBeUndefined()
})

test('/orch prompt queues nothing when the model does not answer', async ($, on) => {
  const { launched } = world(on, null)
  const ran = await orch($, 'prompt acme/core/acme-backend ACME-7300 fix the export')
  expect(launched).toHaveLength(0)
  expect(ran).toMatchObject({ text: expect.stringContaining('nothing queued') })
})

const REPOS = [
  { repo: 'acme/core/acme-backend', about: 'API REST cœur métier Acme' },
  { repo: 'acme/core/acme-frontend', about: 'PWA Acme' },
  { repo: 'acme/datalodestar', about: 'Graphical database client' },
]

/** The world's python answers the repo listing; the model routes with `route`, then sizes. */
const routedWorld = (on: On, route: unknown) => {
  const w = world(on, JSON.stringify(SIZING), e => (e.system?.includes('pick where the work happens') ? JSON.stringify(route) : JSON.stringify(SIZING)))
  w.onPython(argv => (String(argv[1]).endsWith('/repos.py') ? JSON.stringify(REPOS) : '{}'))
  return w
}

test('reads the routing reply: tasks on listed repos only, or questions', async () => {
  const ok = parseRouting(JSON.stringify({ status: 'ready', tasks: [{ repo: 'acme/datalodestar', title: 'T', brief: 'B' }] }), REPOS)
  expect(ok).toEqual({ tasks: [{ repo: 'acme/datalodestar', title: 'T', brief: 'B', after: [] }] })
  // `after` keeps earlier positions only: no cycle, nothing pointing past the list.
  const chained = parseRouting(JSON.stringify({ status: 'ready', tasks: [{ repo: 'acme/core/acme-backend', brief: 'B', after: [1] }, { repo: 'acme/core/acme-frontend', brief: 'F', after: [0, 5] }] }), REPOS)
  expect(chained).toMatchObject({ tasks: [{ after: [] }, { after: [0] }] })
  // A task on a repo that is not listed spoils the whole answer: nothing half-queued.
  expect(parseRouting(JSON.stringify({ status: 'ready', tasks: [{ repo: 'acme/datalodestar', brief: 'B' }, { repo: 'nowhere', brief: 'B' }] }), REPOS)).toBeNull()
  expect(parseRouting(JSON.stringify({ status: 'unclear', questions: ['Which repo?'] }), REPOS)).toEqual({ questions: ['Which repo?'] })
  expect(parseRouting('no json', REPOS)).toBeNull()
})

test('/orch prompt without a repo: the model picks it, one task per repo', async ($, on) => {
  const { launched, asked } = routedWorld(on, {
    status: 'ready',
    tasks: [
      { repo: 'acme/core/acme-backend', title: 'ACME-7400 add the field to the API', brief: 'back brief' },
      { repo: 'acme/core/acme-frontend', title: 'ACME-7400 show the field', brief: 'front brief' },
    ],
  })
  const ran = await orch($, 'prompt ACME-7400 show the collection day on the issue page model:opus')

  expect(asked[0]?.prompt).toContain('- acme/core/acme-backend — API REST cœur métier Acme')
  expect(asked[0]?.prompt).toContain('- acme/datalodestar — Graphical database client\n')
  expect(asked[0]?.prompt).toContain('Ticket trackers: tracker ACME; a task is a ticket task only when the request names a key.')
  expect(asked[0]?.prompt).toContain('Request:\nACME-7400 show the collection day on the issue page')
  expect(asked[0]?.prompt).not.toContain('model:')
  expect(launched.map(l => [l.name, l.agent])).toEqual([
    ['orch-lead-backend-acme-backend', 'orch-lead-backend'],
    ['orch-lead-frontend-acme-frontend', 'orch-lead-frontend'],
  ])
  expect(launched[1]?.prompt).toContain('Repo: /app/acme/core/acme-frontend')
  expect(ran).toMatchObject({ text: expect.stringContaining('Task #2 queued in acme/core/acme-frontend for lead-frontend') })
})

test('/orch prompt without a repo keeps a role the person named', async ($, on) => {
  const { launched } = routedWorld(on, { status: 'ready', tasks: [{ repo: 'acme/datalodestar', title: 'Document bulk delete', brief: 'doc brief' }] })
  await orch($, 'prompt document the bulk delete @tech-writer')
  expect(launched[0]?.agent).toBe('orch-tech-writer')
})

test('/orch prompt without a repo queues nothing when the model cannot place it', async ($, on) => {
  const { launched } = routedWorld(on, { status: 'unclear', questions: ['This is about the running stack, not a repo: which one?'] })
  const ran = await orch($, 'prompt reindex OpenSearch')
  expect(launched).toHaveLength(0)
  expect(ran).toMatchObject({ text: expect.stringContaining('- This is about the running stack') })
})

test('/orch prompt naming a listed repo is not routed', async ($, on) => {
  const { asked } = routedWorld(on, { status: 'ready', tasks: [] })
  await orch($, 'prompt acme/datalodestar fix the export')
  expect(asked[0]?.prompt).toMatch(/^Repo: \/app\/acme\/datalodestar/)
})

test('/orch prompt naming a folder that is no repo yet is not routed: a new app, made a repo', async ($, on) => {
  const w = world(on, JSON.stringify(SIZING), upgradeOrSize)
  w.onPython(argv => (String(argv[1]).endsWith('/repos.py') ? JSON.stringify(REPOS) : '{}'))
  w.fresh.add('/app/cards')
  on('fs.list', (_$, e) => {
    if (e.path !== '/app/cards') {
      throw new Error(`ENOENT: ${e.path}`)
    }
    return { value: [] } as never
  })
  const ran = await orch($, 'prompt /app/cards a web app to list cards')

  expect(w.asked[0]?.prompt).toMatch(/^Repo: \/app\/cards/)
  expect(ran).toMatchObject({ text: expect.stringContaining('Task #1 queued in cards') })
  expect(w.commands).toContainEqual(['git', '-C', '/app/cards', 'init', '--quiet', '--initial-branch=main'])
})

test('/orch prompt naming a folder that does not exist asks first; yes creates it and goes on', async ($, on) => {
  const w = world(on, JSON.stringify(SIZING), upgradeOrSize)
  w.onPython(argv => (String(argv[1]).endsWith('/repos.py') ? JSON.stringify(REPOS) : '{}'))
  w.missing.add('/app/cards')
  w.fresh.add('/app/cards')
  on('fs.list', (_$, e) => {
    if (e.path !== '/app/cards' || w.missing.has('/app/cards')) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    return { value: [] } as never
  })

  const asked = await orch($, 'prompt /app/cards a web app to list cards')
  expect(asked).toMatchObject({ text: expect.stringContaining('/app/cards does not exist. Create it') })
  expect(w.asked).toHaveLength(0)
  expect(w.commands.some(c => c[0] === 'mkdir')).toBe(false)

  // Anything but yes or no asks again.
  expect(await orch($, 'answer maybe')).toMatchObject({ text: expect.stringContaining('/orch answer yes to create /app/cards') })

  w.missing.delete('/app/cards') // what the mkdir does
  const ran = await orch($, 'answer yes')
  expect(w.commands).toContainEqual(['mkdir', '-p', '/app/cards'])
  expect(ran).toMatchObject({ text: expect.stringContaining('Created /app/cards.') })
  expect(ran).toMatchObject({ text: expect.stringContaining('Task #1 queued in cards') })
})

test('/orch task naming a folder that does not exist: no creates nothing and queues nothing', async ($, on) => {
  const w = world(on)
  w.missing.add('/app/cards')
  expect(await orch($, 'task /app/cards a web app to list cards')).toMatchObject({ text: expect.stringContaining('/app/cards does not exist') })
  expect(await orch($, 'answer no')).toMatchObject({ text: expect.stringContaining('not created; nothing queued') })
  expect(w.commands.some(c => c[0] === 'mkdir')).toBe(false)
  expect(w.launched).toHaveLength(0)
  expect(await orch($, 'answer yes')).toMatchObject({ text: expect.stringContaining('No question is waiting') })
})

test('/orch retry without a task number says how to use it', async ($, on) => {
  world(on)
  const ran = await orch($, 'retry')
  expect(ran).toMatchObject({ text: expect.stringContaining('Usage: /orch retry <id>') })
  expect(JSON.stringify(ran)).not.toContain('NaN')
})

test('a task on the stack runs without git, and its review checks the stack', async ($, on) => {
  const { launched, sent } = world(on)
  await orch($, 'task stack reindex the dev_container alias in OpenSearch')

  const worker = 'orch-platform-engineer-stack'
  expect(launched[0]).toMatchObject({ name: worker, agent: 'orch-platform-engineer' })
  expect(launched[0]?.prompt).toContain('Target: stack, the running local Acme stack, working from /app/acme')
  expect(launched[0]?.prompt).toContain('no branch, no commit')
  expect(launched[0]?.prompt).toContain('how to undo it')
  expect(launched[0]?.prompt).not.toContain('git switch')
  expect(launched[0]?.prompt).toContain('- Local stack only: never touch a remote system')
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 1)).toBe('● working')

  await receive($, worker, 'STATUS: done\nSUMMARY: reindexed\nCHANGES: populate run\nTESTS: _count = 773k')
  const review = launched.at(-1)
  expect(review?.name).toBe('orch-review-1-r1')
  expect(review?.prompt).toContain('there is no diff')
  expect(review?.prompt).toContain('read-only commands only')
  expect(review?.prompt).not.toContain('git -C')
  // The target's own rules come from its workspace.
  expect(review?.prompt).toContain('Read-only checks here: docker ps/inspect/logs')

  // A rejection goes back with the stack's rules, not the branch's.
  await receive($, 'orch-review-1-r1', 'VERDICT: CHANGES_REQUESTED\nFINDINGS:\n- 🔴 _count — 12 docs, not 773k — reindex again')
  expect(sent.at(-1)?.text).toContain('Target: stack, from /app/acme')
  expect(sent.at(-1)?.text).toContain("the target's rules as first briefed")
  expect(sent.at(-1)?.text).not.toContain('task branch')
})

test('an approved stack task tells the person what changed, not a branch', async ($, on) => {
  world(on)
  const worker = 'orch-platform-engineer-stack'
  await orch($, 'task stack restart the php-back container')
  await receive($, worker, 'STATUS: done\nSUMMARY: restarted')
  const digest = await $.prompt.submit({
    text: `Another Claude session sent a message:\n${from('orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')}`,
    origin: { kind: 'peer' },
    wait: false,
  })
  expect(digest).toMatchObject({ text: expect.stringContaining('no branch, no commit') })
  expect(digest).toMatchObject({ text: expect.stringContaining('how to undo it') })
})

test('/orch prompt without a repo may route to the stack', async ($, on) => {
  const { launched, asked } = routedWorld(on, { status: 'ready', tasks: [{ repo: 'stack', title: 'Reindex OpenSearch locally', brief: 'ops brief' }] })
  await orch($, 'prompt réindexe OpenSearch en local')
  expect(asked[0]?.prompt).toContain('- stack — the running local Acme stack, no git')
  expect(launched[0]?.name).toBe('orch-platform-engineer-stack')
  expect(launched[0]?.prompt).toContain('Target: stack, the running local Acme stack')
})

test('a task waits for the ones it is after, then builds on their branch', async ($, on) => {
  const { launched } = world(on)
  await orch($, 'task acme/core/acme-backend ACME-7400 expose the day')
  const ran = await orch($, 'task acme/core/acme-frontend ACME-7400 show the day after:#1')
  expect(ran).toMatchObject({ text: expect.stringContaining('Waits for #1 to be approved.') })
  // Its repo is free, but #1 is not approved: only the backend runs.
  expect(launched.map(l => l.name)).toEqual(['orch-lead-backend-acme-backend'])

  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: day exposed\nBRANCH: ACME-7400')
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')
  const front = launched.find(l => l.name === 'orch-lead-frontend-acme-frontend')
  expect(front?.prompt).toContain('This task runs after these approved tasks')
  expect(front?.prompt).toContain('#1 (acme/core/acme-backend) ACME-7400 expose the day: its work is on branch ACME-7400 in /app/acme/core/acme-backend')
  expect(front?.prompt).toContain('SUMMARY: day exposed')
})

test('after a task of the same repo, the branch starts from that task branch; from: overrides', async ($, on) => {
  const { launched, sent } = world(on)
  await orch($, 'task acme/datalodestar first part')
  const queued = await orch($, 'task acme/datalodestar second part after:#1')
  expect(queued).toMatchObject({ text: expect.stringContaining('Branch starts from the branch of the task it waits for in this repo') })
  await receive($, 'orch-lead-backend-datalodestar', 'STATUS: done\nSUMMARY: ok\nBRANCH: feat/first-part')
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')
  // The idle worker of the repo takes #2, briefed to branch from #1's branch.
  const brief = [...sent.map(m => m.text), ...launched.map(l => l.prompt)].find(t => t.includes('task #2 · round 1'))
  expect(brief).toContain('created from feat/first-part (git switch -c <branch> feat/first-part)')
  const second = (await orch($, 'task acme/datalodestar third part from:release'))
  expect(second).toMatchObject({ text: expect.stringContaining('Branch starts from release (asked).') })
})

test('a start branch that does not exist, or a task to wait for that does not, queues nothing', async ($, on) => {
  const { launched } = world(on)
  expect(await orch($, 'task acme/datalodestar x from:nope')).toMatchObject({ text: 'Not queued: no branch or commit "nope" in acme/datalodestar.' })
  expect(await orch($, 'task acme/datalodestar x after:#9')).toMatchObject({ text: 'Not queued: no task #9 to wait for.' })
  expect(await orch($, 'task stack x from:main')).toMatchObject({ text: expect.stringContaining('does not apply to stack, which is not a git repo') })
  expect(launched).toHaveLength(0)
})

test('a task after a dropped one is blocked and the person alerted', async ($, on) => {
  const { alerts } = world(on)
  await orch($, 'task acme/core/acme-backend ACME-1 a')
  await orch($, 'task acme/core/acme-frontend ACME-1 b after:#1')
  await orch($, 'drop 1')
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 2)).toBe('⏸ blocked')
  expect(alerts).toContain('Task #2 blocked: it waits for #1, which was dropped')
})

test('a routed request chains its tasks by position', async ($, on) => {
  const { launched } = routedWorld(on, {
    status: 'ready',
    tasks: [
      { repo: 'acme/core/acme-backend', title: 'ACME-7400 API', brief: 'back' },
      { repo: 'acme/core/acme-frontend', title: 'ACME-7400 page', brief: 'front', after: [0] },
    ],
  })
  const ran = await orch($, 'prompt ACME-7400 show the collection day')
  expect(ran).toMatchObject({ text: expect.stringContaining('Task #2 queued in acme/core/acme-frontend for lead-frontend with this brief:\nWaits for #1 to be approved.') })
  expect(launched.map(l => l.name)).toEqual(['orch-lead-backend-acme-backend'])
})

test('a worker without a key gets no ticket rules; a repo with an integration suite runs it', async ($, on) => {
  const { launched } = world(on)
  await orch($, 'task acme/core/acme-backend fix the export')
  expect(launched[0]?.prompt).toContain('never look for or ask for a key')
  expect(launched[0]?.prompt).not.toContain('ACME-<n>')
  expect(launched[0]?.prompt).toContain('BRANCH: <the task branch')
  expect(launched[0]?.prompt).not.toContain('integration suite')

  await orch($, 'task acme/datalodestar bulk delete')
  const worker = launched.find(l => l.name === 'orch-lead-backend-datalodestar')
  expect(worker?.prompt).toContain('Run the integration suite too, from the repo: make integration')
  await receive($, 'orch-lead-backend-datalodestar', 'STATUS: done\nSUMMARY: ok')
  expect(launched.at(-1)?.prompt).toContain('integration suite (make integration)')
  expect(launched.at(-1)?.prompt).toContain('a report whose TESTS does not show it is a 🔴 finding')
})

test('the person is alerted when a task needs them or is approved, not on progress', async ($, on) => {
  const { alerts } = world(on)
  await orch($, 'task acme/datalodestar a')
  expect(alerts).toEqual([])
  await receive($, 'orch-lead-backend-datalodestar', 'STATUS: blocked\nSUMMARY: stuck\nNEEDS: which table?')
  expect(alerts).toEqual(['Task #1 blocked in acme/datalodestar: which table?'])
  await receive($, 'orch-lead-backend-datalodestar', 'STATUS: done\nSUMMARY: ok')
  expect(alerts).toHaveLength(1)
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')
  expect(alerts.at(-1)).toBe('Task #1 approved in acme/datalodestar')
})

test('/orch pr drafts first, sends only on confirm', async ($, on) => {
  const { commands } = world(on, JSON.stringify(SIZING), e =>
    e.system?.includes('pull request') ? JSON.stringify({ title: 'Bulk delete of databases', body: '## Summary\nDelete several.' }) : JSON.stringify(SIZING),
  )
  await orch($, 'task acme/datalodestar bulk delete')
  expect(await orch($, 'pr 1')).toMatchObject({ text: 'Task #1 is working: only an approved task gets a pull request.' })
  await receive($, 'orch-lead-backend-datalodestar', 'STATUS: done\nSUMMARY: ok\nBRANCH: feat/bulk-delete')
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')

  expect(await orch($, 'pr 1 confirm')).toMatchObject({ text: expect.stringContaining('draft the pull request first') })
  const draft = await orch($, 'pr 1')
  expect(draft).toMatchObject({ text: expect.stringContaining('not sent yet') })
  expect(draft).toMatchObject({ text: expect.stringContaining('Push feat/bulk-delete to origin, into main.') })
  expect(draft).toMatchObject({ text: expect.stringContaining('🤖 Generated with [Claude Code]') })
  expect(commands.some(c => c.includes('push') || c[0] === 'gh')).toBe(false)

  const sent = await orch($, 'pr 1 confirm')
  expect(sent).toMatchObject({ text: 'Task #1: feat/bulk-delete pushed and pull request opened: https://github.com/QuentinJost/DataLodestar/pull/7' })
  expect(commands).toContainEqual(['git', '-C', '/app/acme/datalodestar', 'push', '-u', 'origin', 'feat/bulk-delete'])
  const gh = commands.find(c => c[0] === 'gh')
  expect(gh?.slice(0, 7)).toEqual(['gh', 'pr', 'create', '--base', 'main', '--head', 'feat/bulk-delete'])
  expect(await orch($, 'pr 1')).toMatchObject({ text: expect.stringContaining('already has its pull request') })
})

test('the first queued task of a session reminds the person of Remote Control, once', async ($, on) => {
  world(on)
  expect(await orch($, 'drop 9')).not.toMatchObject({ text: expect.stringContaining('remote-control') })
  expect(await orch($, 'task acme/datalodestar a')).toMatchObject({ text: expect.stringContaining('run /remote-control in this session') })
  expect(await orch($, 'task acme/orch-sandbox b')).not.toMatchObject({ text: expect.stringContaining('remote-control') })
})

test('no Remote Control reminder once a prompt came in through it', async ($, on) => {
  world(on)
  await $.prompt.submit({ text: 'hello from the phone', origin: { kind: 'bridge' }, wait: false } as never)
  expect(await orch($, 'task acme/datalodestar a')).not.toMatchObject({ text: expect.stringContaining('remote-control') })
})

test('retry answers a blocked worker and tells whether it was delivered', async ($, on) => {
  const { sent, watched, refuseSends } = world(on)
  await orch($, 'task acme/datalodestar delete a database from the listing')
  const worker = 'orch-lead-backend-datalodestar'
  expect(watched).toEqual([worker])
  await receive($, worker, 'STATUS: blocked\nNEEDS: the Jira key')

  // Not waiting: said so, nothing sent.
  const before = sent.length
  expect(await orch($, 'retry 7 x')).toMatchObject({ text: expect.stringContaining('no such task') })
  expect(sent).toHaveLength(before)

  // A delivery that fails leaves the task blocked and says why.
  refuseSends('held for approval')
  expect(await orch($, 'retry 1 no Jira key here')).toMatchObject({ text: expect.stringContaining('not sent back to orch-lead-backend-datalodestar: held for approval') })
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 1)).toBe('⏸ blocked')

  // Delivered: the answer goes as its own brief, watched, and the task works again.
  refuseSends(null)
  expect(await orch($, 'retry 1 no Jira key, branch feat/delete-db')).toMatchObject({ text: `Task #1 sent back to ${worker}.` })
  expect(sent.at(-1)?.to).toBe(worker)
  expect(sent.at(-1)?.text).toContain('The person answered: no Jira key, branch feat/delete-db')
  expect(sent.at(-1)?.text).not.toContain('Review rejected')
  expect(watched.at(-1)).toBe(worker)
  expect(await stateOf(ui, 1)).toBe('● working')
  expect(await orch($, 'retry 1 again')).toMatchObject({ text: expect.stringContaining('it is working, not waiting for you') })
})

test('a free-form message goes only to a session that exists, and reports its delivery', async ($, on) => {
  const { sent, refuseSends } = world(on)
  expect(await orch($, 'dont use jira keys')).toMatchObject({ text: expect.stringContaining('No session named "dont"') })
  expect(sent).toHaveLength(0)
  expect(await orch($, 'app-71 hello')).toMatchObject({ text: 'Sent to app-71.' })
  expect(sent.at(-1)).toEqual({ to: 'app-71', text: 'hello' })
  refuseSends('nobody by that name')
  expect(await orch($, 'app-71 hello again')).toMatchObject({ text: 'Not delivered to app-71: nobody by that name' })
})

test('a session idle without its report gets its brief again, then the person decides', async ($, on) => {
  const { sent, clock, launched } = world(on)
  await orch($, 'task acme/datalodestar ACME-7400 delete a database')
  const worker = 'orch-lead-backend-datalodestar'
  const idle = (name: string) =>
    $.session.receive({ origin: { kind: 'peer' }, text: `[Cross-session idle notice] "${name}", which you asked to be notified about, is idle now.` })

  // Idle, no report within the grace: the launch brief goes again, in full.
  await idle(worker)
  expect(sent).toHaveLength(0)
  await clock.advance(20_000)
  expect(sent).toHaveLength(1)
  expect(sent[0]?.to).toBe(worker)
  expect(sent[0]?.text).toContain('You went idle without reporting')
  expect(sent[0]?.text).toContain(launched[0]?.prompt ?? 'x')

  // Idle again, still silent: blocked for the person.
  await idle(worker)
  await clock.advance(20_000)
  expect(sent).toHaveLength(1)
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 1)).toBe('⏸ blocked')
  expect(await ui.find({ type: 'Text', text: /idle twice without reporting/ })).toBeDefined()

  // A report that arrives before the grace ends is the normal case: nothing is resent.
  await orch($, 'retry 1 go on')
  expect(sent).toHaveLength(2)
  await idle(worker)
  await receive($, worker, 'STATUS: done\nSUMMARY: done')
  await clock.advance(20_000)
  expect(sent).toHaveLength(2)
  expect(launched.filter(l => l.agent === 'orch-reviewer')).toHaveLength(1)
})

test('reads what SendMessage answers: success false, a refusal or an error delivers nothing', async () => {
  // As a plugin's $.tool.call saw an unreachable name on 2026-10-03: neither deny nor isError.
  const seen = { result: unreachable('orch-x'), text: JSON.stringify({ success: false, message: unreachable('orch-x').message }) }
  expect(deliveryFailure(seen)).toBe("No agent named 'orch-x' is reachable.")
  expect(deliveryFailure({ text: seen.text })).toBe("No agent named 'orch-x' is reachable.")
  expect(deliveryFailure({ result: { success: false } })).toBe('not delivered')
  expect(deliveryFailure({ result: { success: true, message: 'sent' } })).toBeNull()
  expect(deliveryFailure({ deny: 'held for approval' })).toBe('held for approval')
  expect(deliveryFailure({ isError: true, text: 'boom' })).toBe('boom')
})

test('tells an auto-mode hold from a refusal', async () => {
  expect(isAutoModeHold(AUTO_MODE_HOLD)).toBe(true)
  expect(isAutoModeHold("No agent named 'orch-x' is reachable.")).toBe(false)
  expect(isAutoModeHold('held for approval')).toBe(false)
})

test('a retry the classifier holds once goes out on the second try', async ($, on) => {
  const { sent, submitted, holdSends } = world(on)
  const worker = 'orch-lead-backend-datalodestar'
  await orch($, 'task acme/datalodestar bulk delete')
  await receive($, worker, 'STATUS: blocked\nNEEDS: a Jira key')
  holdSends(1)
  expect((await orch($, 'retry 1 no jira ticket')).text).toBe(`Task #1 sent back to ${worker}.`)
  expect(sent.at(-1)?.text).toContain('The person answered: no jira ticket')
  expect(submitted).toEqual([])
})

test('a retry the classifier holds twice is handed to Claude, framed as the plugin\'s', async ($, on) => {
  const { sent, submitted, holdSends, clock } = world(on)
  const worker = 'orch-lead-backend-datalodestar'
  await orch($, 'task acme/datalodestar bulk delete')
  await receive($, worker, 'STATUS: blocked\nNEEDS: a Jira key')
  const before = sent.length
  holdSends(2)
  expect((await orch($, 'retry 1 no jira ticket')).text).toBe(`Task #1 sent back to ${worker}.`)
  expect(sent.length).toBe(before)
  expect(submitted).toEqual([])
  await clock.advance(100)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain(`Send it with SendMessage to "${worker}", with notify_when_idle: true,`)
  expect(submitted[0]).toContain('The person answered: no jira ticket')
})

test('an idle worker the daemon stopped is not reused: a fresh session takes the next task', async ($, on) => {
  const { launched, stopped, sent, tried, kill } = world(on)
  const worker = 'orch-lead-backend-datalodestar'
  await orch($, 'task acme/datalodestar ACME-7401 first')
  await receive($, worker, 'STATUS: done\nSUMMARY: done')
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')
  expect(launched).toHaveLength(2)

  // An hour later the daemon has stopped the idle worker, which the orchestrator still lists.
  kill(worker)
  expect(await orch($, `${worker} are you there`)).toMatchObject({ text: `Not delivered to ${worker}: No agent named '${worker}' is reachable.` })

  const before = tried.length
  await orch($, 'task acme/datalodestar ACME-7402 second')
  // Checked before use: no brief is even tried on the gone session.
  expect(tried.slice(before)).toEqual([])
  expect(stopped).toContain('00000001')
  expect(launched).toHaveLength(3)
  expect(launched[2]?.name).toBe(worker)
  expect(launched[2]?.prompt).toMatch(/task #2 · round 1\] ACME-7402 second/)
  expect(sent.filter(s => s.text.includes('task #2'))).toHaveLength(0)
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 2)).toBe('● working')
})

test('a reused worker that turns the brief down is replaced by a fresh session', async ($, on) => {
  const { launched, stopped, refuseSends } = world(on)
  const worker = 'orch-lead-backend-datalodestar'
  await orch($, 'task acme/datalodestar ACME-7404 first')
  await receive($, worker, 'STATUS: done')
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')

  refuseSends('this session takes no messages from other sessions')
  await orch($, 'task acme/datalodestar ACME-7405 second')
  refuseSends(null)
  expect(stopped).toContain('00000001')
  expect(launched).toHaveLength(3)
  expect(launched[2]?.name).toMatch(/^orch-lead-backend-datalodestar(-2)?$/)
  expect(launched[2]?.prompt).toMatch(/task #2 · round 1\] ACME-7405 second/)
})

test('retry to a worker the daemon stopped hands the task to a fresh session, briefed in full', async ($, on) => {
  const { launched, stopped, kill } = world(on)
  const worker = 'orch-lead-backend-datalodestar'
  await orch($, 'task acme/datalodestar delete several databases')
  await receive($, worker, 'STATUS: blocked\nNEEDS: the Jira key')
  kill(worker)

  expect(await orch($, 'retry 1 no Jira key, branch feat/multi-delete')).toMatchObject({
    text: `Task #1 handed to a fresh session, ${worker}, briefed in full: the previous one was gone.`,
  })
  expect(stopped).toContain('00000001')
  expect(launched).toHaveLength(2)
  const fresh = launched[1]?.prompt ?? ''
  expect(fresh).toContain(`You take over this task: ${worker}, the session that worked on it, is gone.`)
  expect(fresh).toContain('Rules:')
  expect(fresh).toContain('The person answered: no Jira key, branch feat/multi-delete')
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 1)).toBe('● working')

  // The fresh session's report moves the task on as any worker's does.
  await receive($, worker, 'STATUS: done\nSUMMARY: done')
  expect(launched.at(-1)?.name).toBe('orch-review-1-r1')
})

test("a rejected review's findings reach a fresh session when the worker is gone", async ($, on) => {
  const { launched, kill } = world(on)
  const worker = 'orch-lead-backend-datalodestar'
  await orch($, 'task acme/datalodestar ACME-7403 delete several databases')
  await receive($, worker, 'STATUS: done\nSUMMARY: done')
  kill(worker)
  await receive($, 'orch-review-1-r1', 'VERDICT: CHANGES_REQUESTED\nFINDINGS:\n- 🟠 tree.ts:9 — no test — add one')

  const fresh = launched.at(-1)
  expect(fresh?.name).toBe(worker)
  expect(fresh?.prompt).toContain('You take over this task')
  expect(fresh?.prompt).toMatch(/task #1 · round 2\] Review rejected/)
  expect(fresh?.prompt).toContain('tree.ts:9')
  await receive($, worker, 'STATUS: done\nSUMMARY: test added')
  expect(launched.at(-1)?.name).toBe('orch-review-1-r2')
})

test('no session runs on haiku: a review sized to haiku is raised to sonnet, effort kept', async ($, on) => {
  const { launched } = world(on, JSON.stringify({ work: { model: 'haiku', effort: 'low' }, review: { model: 'haiku', effort: 'low' }, why: 'typo' }))
  await orch($, 'task acme/core/acme-backend ACME-7310 fix a typo')
  expect(launched[0]).toMatchObject({ model: 'opus', effort: 'low' })
  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: typo fixed')
  expect(launched[1]).toMatchObject({ name: 'orch-review-1-r1', model: 'sonnet', effort: 'low' })
  expect(launched.map(l => l.model)).not.toContain('haiku')
  expect(SIZING_SYSTEM).toContain('Haiku is never used.')
})

/** Lets the checks, started from a timer, run to their end: each step of theirs waits on the engine. */
const drain = async (clock: { advance: (ms: number) => Promise<unknown> }) => {
  for (let i = 0; i < 30; i += 1) {
    await clock.advance(10)
  }
}

const pane = ($: Parameters<TestBody>[0]) =>
  $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })


test('a folder that is not a git repo gets git init and an empty first commit, local only', async ($, on) => {
  const { launched, commands, fresh, missing } = world(on)
  fresh.add('/app/newapp')
  await orch($, 'task newapp build the app')
  expect(commands).toContainEqual(['git', '-C', '/app/newapp', 'init', '--quiet', '--initial-branch=main'])
  // No identity in the new repo: the first commit says it is the orchestrator's.
  expect(commands).toContainEqual(['git', '-C', '/app/newapp', '-c', 'user.name=Orchestra', '-c', 'user.email=orchestra@localhost', 'commit', '--allow-empty', '--quiet', '-m', 'chore: initial commit'])
  expect(commands.some(c => c[0] === 'git' && c.includes('remote'))).toBe(false)
  expect(launched).toHaveLength(1)
  expect(launched[0]?.prompt).toContain('Repo: /app/newapp')

  // A folder that does not exist is not created: a typo would make a stray repo.
  missing.add('/app/typo')
  await orch($, 'task typo do it')
  expect(launched).toHaveLength(1)
  const ui = await pane($)
  expect(await stateOf(ui, 2)).toBe('⏸ blocked')
  expect(commands.some(c => c.includes('/app/typo') && c.includes('init'))).toBe(false)

  // Nor is a subfolder of another repo: no repo nested in a repo.
  await orch($, 'task mtg/backend add an endpoint')
  expect(await stateOf(ui, 3)).toBe('⏸ blocked')
  expect(commands.some(c => c.includes('/app/mtg/backend') && c.includes('init'))).toBe(false)
})

test('an approved task in a repo with no remote gets no pull request', async ($, on) => {
  const { noRemote } = world(on)
  noRemote.add('/app/mtg')
  await orch($, 'task mtg add the deck page')
  await receive($, 'orch-developer-mtg', 'STATUS: done\nSUMMARY: ok\nBRANCH: feat/deck-page')
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')
  expect((await orch($, 'pr 1')).text).toContain('local repo with no remote (origin): nothing to push')
})

test('the orchestrator runs the checks before a review: a failure goes back to the worker, no review spent', async ($, on) => {
  const { launched, sent, checkExits, commands, clock } = world(on)
  serve([{ ...(WORKSPACES[0] as Workspace), checks: { '*': ['make lint'] } }])
  try {
    checkExits.push(1)
    await orch($, 'task acme/core/acme-backend fix the export')
    await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: ok\nBRANCH: feat/export')
    // The checks start from a timer, outside the queue's turn.
    await drain(clock)
    expect(commands).toContainEqual(['sh', '-c', 'make lint'])
    expect(launched.filter(l => l.name.startsWith('orch-review-'))).toHaveLength(0)
    expect(sent.at(-1)?.to).toBe('orch-lead-backend-acme-backend')
    expect(sent.at(-1)?.text).toContain('Checks failed before review')
    expect(sent.at(-1)?.text).toContain('src/a.go:4: unused variable x')

    await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: fixed\nBRANCH: feat/export')
    await drain(clock)
    const review = launched.find(l => l.name === 'orch-review-1-r1')
    expect(review?.prompt).toContain('already ran the repo\'s checks on this code, green: make lint')
  } finally {
    serve(WORKSPACES)
  }
})

test('checks that keep failing hand the task to the person', async ($, on) => {
  const { launched, checkExits, alerts, clock } = world(on)
  serve([{ ...(WORKSPACES[0] as Workspace), checks: { '*': ['make lint'] } }])
  try {
    checkExits.push(1, 1, 1)
    await orch($, 'task acme/core/acme-backend fix the export')
    for (let i = 0; i < 3; i += 1) {
      await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: ok\nBRANCH: feat/export')
      await drain(clock)
    }
    expect(launched.filter(l => l.name.startsWith('orch-review-'))).toHaveLength(0)
    expect(await stateOf(await pane($), 1)).toBe('⏸ blocked')
    expect(alerts.at(-1)).toBe('Task #1 blocked: its checks still fail after 2 fixes')
  } finally {
    serve(WORKSPACES)
  }
})

test('/orch followup queues the remaining remarks of an approved task, from its branch', async ($, on) => {
  const { launched, sent } = world(on)
  await orch($, 'task acme/core/acme-backend fix the export')
  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: ok\nBRANCH: feat/export')
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n- ⚪ Export.php:40 — long line — split it')
  const ran = await orch($, 'followup 1 keep it short')
  expect(ran.text).toContain('Follow-up of #1 queued as #2')
  expect(ran.text).toContain('Branch starts from feat/export (asked).')
  // The idle worker of #1 takes it.
  expect(launched).toHaveLength(2)
  const brief = sent.at(-1)?.text ?? ''
  expect(brief).toContain('Export.php:40 — long line — split it')
  expect(brief).toContain('The person adds: keep it short')
  expect(brief).toContain('git switch -c <branch> feat/export')
  expect((await orch($, 'followup 2')).text).toContain('only an approved task gets a follow-up')
})

test('/orch answer settles the questions of an unclear request, then queues it', async ($, on) => {
  let questions = true
  const { launched, asked } = world(on, JSON.stringify(SIZING), e =>
    e.system?.includes('Prompt Manager')
      ? JSON.stringify(questions ? { status: 'unclear', questions: ['CSV or PDF?'] } : { status: 'ready', title: 'Fix the CSV export', brief: '## Objective\nCSV.' })
      : JSON.stringify(SIZING),
  )
  expect((await orch($, 'answer csv')).text).toBe('No question is waiting for an answer.')
  expect((await orch($, 'prompt acme/core/acme-backend fix the export')).text).toContain('Answer with /orch answer')
  questions = false
  const ran = await orch($, 'answer CSV only')
  expect(ran.text).toContain('Task #1 queued in acme/core/acme-backend')
  expect(asked.at(-2)?.prompt).toContain('- CSV or PDF?\n→ CSV only')
  expect(launched).toHaveLength(1)
  expect((await orch($, 'answer again')).text).toBe('No question is waiting for an answer.')
})

test('a faulty workspace file is said in every /orch answer and in /orch config', async ($, on) => {
  const { onPython } = world(on)
  onPython(argv => (argv[2] === '--workspaces' ? '' : '{}'))
  // The world answers the workspaces itself; a faulty file comes as an error entry.
  const ran = await orch($, 'config acme/core/acme-backend')
  expect(ran.text).toContain('acme/core/acme-backend: workspace acme')
  expect(ran.text).toContain('Tickets: only when the request names a key (tracker ACME')
  expect(ran.text).not.toContain('⚠ Workspace config')
})

test('a second task in a repo that allows two runs in a local clone, brought back on approval', async ($, on) => {
  const { launched, commands } = world(on)
  serve([{ ...(WORKSPACES[0] as Workspace), parallel: 2 }])
  try {
    await orch($, 'task acme/core/acme-backend first')
    await orch($, 'task acme/core/acme-backend second')
    await orch($, 'task acme/core/acme-backend third')
    expect(launched.map(l => l.name)).toEqual(['orch-lead-backend-acme-backend', 'orch-lead-backend-acme-backend-2'])
    const clone = '/app/.orchestra/clones/acme-core-acme-backend-2'
    expect(commands).toContainEqual(['git', 'clone', '--quiet', '--no-checkout', '/app/acme/core/acme-backend', clone])
    expect(launched[1]?.prompt).toContain(`Repo: ${clone} (work only there)`)
    expect(launched[1]?.prompt).toContain('This is a local clone of /app/acme/core/acme-backend')
    await receive($, 'orch-lead-backend-acme-backend-2', 'STATUS: done\nSUMMARY: ok\nBRANCH: feat/second')
    expect(launched.at(-1)?.prompt).toContain(`git -C ${clone} log`)
    await receive($, 'orch-review-2-r1', 'VERDICT: APPROVED\nFINDINGS:\n')
    expect(commands).toContainEqual(['git', '-C', '/app/acme/core/acme-backend', 'fetch', '--quiet', clone, 'feat/second:feat/second'])
    expect(commands).toContainEqual(['rm', '-rf', clone])
    // The third waited for a place, and takes the freed one.
    expect(launched.at(-1)?.prompt).toContain('third')
  } finally {
    serve(WORKSPACES)
  }
})

test('finished tasks are kept, and the sizing sees them; the orchestrator calls count in the cost', async ($, on) => {
  const { asked, files } = world(on)
  await orch($, 'task acme/core/acme-backend fix the export')
  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: ok\nBRANCH: feat/export')
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')
  const kept = [...files].find(([path]) => path.endsWith('/orchestra/history.json'))
  const history = JSON.parse(kept?.[1] ?? '[]') as HistoryEntry[]
  expect(history).toHaveLength(1)
  expect(history[0]).toMatchObject({ repo: 'acme/core/acme-backend', role: 'lead-backend', outcome: 'approved', rounds: 1, checkFixes: 0 })
  // One sizing call on fable: 1000 in × $10/M + 200 out × $50/M.
  expect(Math.abs((history[0]?.cost ?? 0) - 0.02)).toBeLessThan(1e-9)

  await orch($, 'task acme/core/acme-backend second fix')
  expect(asked.at(-1)?.prompt).toContain('Past tasks (setting → outcome, cost):')
  expect(asked.at(-1)?.prompt).toContain('- acme/core/acme-backend · lead-backend · dev opus·high · review opus·xhigh → approved after 1 round(s), ≈$0.02 · fix the export')
})

test('a new app made by the orchestrator gets the rules of every new app; an existing repo does not', async ($, on) => {
  const { launched, fresh } = world(on)
  const ROOT_RULES: Workspace = { path: '', newApp: ['It runs under Docker Compose: a compose.yaml at the repo root starts it with docker compose up.'] }
  serve([...WORKSPACES, ROOT_RULES])
  try {
    fresh.add('/app/newapp')
    await orch($, 'task newapp build the app')
    expect(launched[0]?.prompt).toContain('This is a new app. Every new app must meet these rules, as part of this task:\n  - It runs under Docker Compose')
    await receive($, 'orch-developer-newapp', 'STATUS: done\nSUMMARY: ok\nBRANCH: feat/app')
    expect(launched[1]?.prompt).toContain('This is a new app: it must meet these rules, and one not met is a 🔴 finding:\n- It runs under Docker Compose')

    // A repo that already has commits is no new app, even under the same root rules.
    await orch($, 'task acme/core/acme-backend fix the export')
    expect(launched.at(-1)?.prompt).not.toContain('new app')
    expect((await orch($, 'config newapp')).text).toContain('Rules for a new app: It runs under Docker Compose')
  } finally {
    serve(WORKSPACES)
  }
})

/** Roles every repo under the root knows, as /app/orchestra.json declares them. */
const ROOT_ROLES: Workspace = { path: '', roles: { list: { 'lead-backend': 'engineering', 'lead-frontend': 'engineering', dba: 'engineering' }, default: 'developer' } }

test('/orch prompt splits a request by domain: one task per role, the UI after the API it calls', async ($, on) => {
  const split = {
    status: 'ready',
    tasks: [
      { role: 'lead-backend', title: 'Deck API', brief: 'Add the deck endpoints.' },
      { role: 'lead-frontend', after: [0], title: 'Deck page', brief: 'Show the decks, from the new endpoints.' },
    ],
  }
  const { launched, asked } = world(on, JSON.stringify(SIZING), e => (e.system?.includes('Prompt Manager') ? JSON.stringify(split) : JSON.stringify(SIZING)))
  serve([...WORKSPACES, ROOT_ROLES])
  try {
    const ran = await orch($, 'prompt mtg add decks, API and page')
    expect(asked[0]?.prompt).toContain('Roles for a split: lead-backend, lead-frontend, dba')
    expect(ran.text).toContain('Task #1 queued in mtg for lead-backend')
    expect(ran.text).toContain('Task #2 queued in mtg for lead-frontend')
    expect(ran.text).toContain('Waits for #1 to be approved.')
    expect(launched.map(l => l.agent)).toEqual(['orch-lead-backend'])

    await receive($, 'orch-lead-backend-mtg', 'STATUS: done\nSUMMARY: endpoints added\nBRANCH: feat/deck-api')
    await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')
    const front = launched.find(l => l.agent === 'orch-lead-frontend')
    expect(front?.name).toBe('orch-lead-frontend-mtg')
    // The UI builds on the API's branch.
    expect(front?.prompt).toContain('git switch -c <branch> feat/deck-api')
    expect(front?.prompt).toContain('#1 (mtg) Deck API: its work is on branch feat/deck-api')
  } finally {
    serve(WORKSPACES)
  }
})

test('a role the person names wins over the split; a role the repo does not know falls back to the repo', async ($, on) => {
  let reply: unknown = { status: 'ready', role: 'wizard', title: 'Fix', brief: 'Fix it.' }
  const { launched } = world(on, JSON.stringify(SIZING), e => (e.system?.includes('Prompt Manager') ? JSON.stringify(reply) : JSON.stringify(SIZING)))
  serve([...WORKSPACES, ROOT_ROLES])
  try {
    expect((await orch($, 'prompt mtg fix it')).text).toContain('queued in mtg for developer')
    reply = { status: 'ready', tasks: [{ role: 'lead-frontend', title: 'A', brief: 'a' }, { role: 'lead-backend', title: 'B', brief: 'b' }] }
    const ran = await orch($, 'prompt mtg do both @dba')
    expect(ran.text).toContain('Task #2 queued in mtg for dba')
    expect(ran.text).toContain('Task #3 queued in mtg for dba')
    expect(launched[0]?.agent).toBe('orch-developer')
  } finally {
    serve(WORKSPACES)
  }
})

test('routing may give one repo several tasks, by domain, each with its role', () => {
  const routed = parseRouting(
    JSON.stringify({
      status: 'ready',
      tasks: [
        { repo: 'acme/datalodestar', role: 'dba', title: 'Schema', brief: 'S' },
        { repo: 'acme/datalodestar', role: 'lead-frontend', after: [0], title: 'UI', brief: 'U' },
      ],
    }),
    [{ repo: 'acme/datalodestar', about: '' }],
  )
  expect(routed).toEqual({
    tasks: [
      { repo: 'acme/datalodestar', role: 'dba', title: 'Schema', brief: 'S', after: [] },
      { repo: 'acme/datalodestar', role: 'lead-frontend', title: 'UI', brief: 'U', after: [0] },
    ],
  })
})

const CARD = { title: 'Lead UI/UX & Frontend Developer', prompt: '# Lead UI/UX & Frontend Developer\n\nYou are the Lead UI/UX Designer and Frontend Developer of the project team.', file: '/opt/cortex/versions/1.1.1/agents/roles/engineering/lead-frontend.md' }

test('a role card is the whole instructions of its agent; a workspace with no cards of its own keeps its cascade', () => {
  setWorkspaces([
    { path: '', roles: { list: { 'lead-frontend': 'engineering' }, cards: { 'lead-frontend': CARD }, worker: ["Before your first task, read the target repo's README."] } },
    { ...(WORKSPACES[0] as Workspace), roles: { ...(WORKSPACES[0] as Workspace).roles, cards: {} } },
  ])
  try {
    const agent = JSON.parse(workerAgent('lead-frontend', 'mtg'))['orch-lead-frontend'].prompt as string
    expect(agent).toContain('----- role card -----\n# Lead UI/UX & Frontend Developer\n\nYou are the Lead UI/UX Designer')
    expect(agent).toContain("read the target repo's own when they exist")
    expect(agent).toContain("Before your first task, read the target repo's README.")
    // The Acme workspace said it has no cards: its sessions read its own cascade.
    const acme = JSON.parse(workerAgent('lead-frontend', 'acme/core/acme-frontend'))['orch-lead-frontend'].prompt as string
    expect(acme).not.toContain('role card')
    expect(acme).toContain('read /app/acme/roles/engineering/lead-frontend.md')
    // The choice of a role sees what each card says it is.
    expect(upgradePrompt('mtg', 'developer', 'x')).toContain('Roles for a split: lead-frontend (Lead UI/UX & Frontend Developer)')
    expect(describe('mtg').join('\n')).toContain('Role cards: 1\n')
  } finally {
    setWorkspaces(WORKSPACES)
  }
})

test('what the role cards folder could not give is said like any fault of the file', () => {
  const read = parseWorkspaces(JSON.stringify([{ path: '', file: 'orchestra.json', roles: { from: ['/nope'] }, problems: ['roles.from: no folder of role cards at /nope'] }]))
  expect(read.workspaces.map(w => w.path)).toEqual([''])
  expect(read.errors).toEqual(['orchestra.json: roles.from: no folder of role cards at /nope'])
})

const THEME: Workspace['personality'] = {
  from: '/claude-code/cortex/personalities/the-boys',
  reviewerAs: 'qa-automation',
  theme: '# The Boys Theme — Rules & Tone\n\nDark deadpan humour. NEVER sacrifice technical quality for humour.',
  characters: {
    'lead-frontend': { name: 'Hughie Campbell', alias: '@Hughie', card: "# Hughie Campbell\n\n\"Let's make it work for the person who never reads the manual.\"" },
    'qa-automation': { name: 'Kimiko', alias: '@Kimiko', card: '# Kimiko\n\n"[signs] I break it first. Then nobody else can."' },
  },
}

test('workers play their role\'s character, the reviewer the one of reviewerAs; the briefs stay neutral', () => {
  setWorkspaces([{ path: '', roles: { list: { 'lead-frontend': 'engineering', 'qa-automation': 'engineering' } }, personality: THEME }, ...WORKSPACES])
  try {
    const worker = JSON.parse(workerAgent('lead-frontend', 'mtg'))['orch-lead-frontend'].prompt as string
    expect(worker).toContain('You play Hughie Campbell')
    expect(worker).toContain('----- theme -----\n# The Boys Theme')
    expect(worker).toContain("----- character card -----\n# Hughie Campbell")
    expect(worker).toContain('(STATUS:, SUMMARY:, BRANCH:, CHANGES:, TESTS:, NEEDS:, VERDICT:, FINDINGS:) keeps its exact form')
    const reviewer = JSON.parse(reviewerAgent('mtg'))['orch-reviewer'].prompt as string
    expect(reviewer).toContain('You play Kimiko')
    // An inner workspace with no personality of its own plays the root's.
    expect(JSON.parse(reviewerAgent('acme/core/acme-backend'))['orch-reviewer'].prompt).toContain('You play Kimiko')
    // A role the theme does not cast plays no one.
    expect(JSON.parse(workerAgent('developer', 'mtg'))['orch-developer'].prompt).not.toContain('You play')
    // What the orchestrator writes for the sessions and its own model stays neutral.
    const task = { id: 1, repo: 'mtg', role: 'lead-frontend', text: 'x', branchFrom: 'main', round: 1, report: '', reviews: [] } as unknown as Task
    for (const text of [workerBrief('o', task), reviewBrief('o', task), upgradePrompt('mtg', 'lead-frontend', 'x'), UPGRADE_SYSTEM]) {
      expect(text).not.toContain('Hughie')
      expect(text).not.toContain('The Boys')
    }
    expect(describe('mtg').join('\n')).toContain('Personality: /claude-code/cortex/personalities/the-boys · lead-frontend = Hughie Campbell, qa-automation = Kimiko · reviewer = Kimiko')
  } finally {
    setWorkspaces(WORKSPACES)
  }
})

test('without a personality, no session plays anyone', () => {
  expect(JSON.parse(workerAgent('lead-frontend', 'acme/core/acme-frontend'))['orch-lead-frontend'].prompt).not.toContain('You play')
  expect(JSON.parse(reviewerAgent('acme/core/acme-frontend'))['orch-reviewer'].prompt).not.toContain('You play')
  expect(parseWorkspaces(JSON.stringify([{ path: 'x', personality: { reviewerAs: 3 } }])).errors).toEqual(['x: personality must be {from, reviewerAs?}; ignored'])
})

test('a card\'s workspace overlay follows the card; the reviewer gets its rules whole, base first, as a local review', () => {
  setWorkspaces([
    {
      path: 'acme',
      roles: {
        list: { 'regulatory-compliance-writer': 'security-compliance' },
        cards: { 'regulatory-compliance-writer': { title: 'Regulatory writer', prompt: '# Regulatory writer\n\nBase card.', file: 'x', overlay: '<!-- OVERLAY\n Semantic: additive -->\nTeam rule: French public law.', semantic: 'additive' } },
      },
      review: {
        texts: [
          { file: '/opt/cortex/…/code-review.md', text: '# Code review\n\nRule 1: verify every finding.', semantic: 'base' },
          { file: '/app/acme/agents/…/code-review.md', text: '<!-- OVERLAY -->\n# Revue Acme\n\n🔴 Bloquant', semantic: 'replacement' },
        ],
      },
    },
  ])
  try {
    const worker = JSON.parse(workerAgent('regulatory-compliance-writer', 'acme/docs'))['orch-regulatory-compliance-writer'].prompt as string
    expect(worker.indexOf('Base card.')).toBeLessThan(worker.indexOf('Team rule: French public law.'))
    expect(worker).toContain("The workspace's overlay of that card follows (it adds to the card; where they differ, the overlay wins).")
    const reviewer = JSON.parse(reviewerAgent('acme/docs'))['orch-reviewer'].prompt as string
    expect(reviewer).toContain('This review is local: you publish nothing')
    expect(reviewer.indexOf('Rule 1: verify every finding.')).toBeLessThan(reviewer.indexOf('# Revue Acme'))
    expect(reviewer).toContain('----- overlay (replacement): /app/acme/agents/…/code-review.md -----')
    expect(JSON.parse(reviewerAgent('mtg'))['orch-reviewer'].prompt).not.toContain('review rules')
  } finally {
    setWorkspaces(WORKSPACES)
  }
})

test('a worker is pointed at the capability cards of its repo\'s stack', () => {
  const index = Object.fromEntries(
    ['languages/php', 'frameworks/symfony', 'frameworks/vue', 'languages/typescript', 'infrastructure/docker', 'databases/mysql', 'security/owasp', 'practices/code-comments', 'testing/e2e-testing', 'compliance/data-protection-fr'].map(n => [n, { files: [`/cards/${n}.md`] }]),
  )
  const backend = capabilitiesFor({ 'composer.json': '{"require":{"symfony/framework-bundle":"6.4.*"}}', 'compose.yaml': 'services:\n  db:\n    image: mysql:8' }, 'lead-backend', index)
  expect(backend.sort()).toEqual(['/cards/databases/mysql.md', '/cards/frameworks/symfony.md', '/cards/infrastructure/docker.md', '/cards/languages/php.md', '/cards/practices/code-comments.md', '/cards/security/owasp.md'])
  const front = capabilitiesFor({ 'package.json': '{"dependencies":{"nuxt":"4"},"devDependencies":{"typescript":"5","@playwright/test":"1"}}' }, 'lead-frontend', index)
  expect(front).toContain('/cards/frameworks/vue.md')
  expect(front).toContain('/cards/languages/typescript.md')
  expect(front).toContain('/cards/testing/e2e-testing.md')
  expect(front).not.toContain('/cards/languages/php.md')
  expect(capabilitiesFor({}, 'compliance-officer', index)).toContain('/cards/compliance/data-protection-fr.md')
  expect(capabilitiesFor({}, 'lead-backend', {})).toEqual([])
})

test('a task may follow a workflow its workspace offers; the reviewer\'s is never offered, an unknown one is dropped', async ($, on) => {
  let reply: unknown = { status: 'ready', role: 'lead-backend', workflow: 'engineering/feature-development', title: 'Decks', brief: 'b' }
  const { launched, asked } = world(on, JSON.stringify(SIZING), e => (e.system?.includes('Prompt Manager') ? JSON.stringify(reply) : JSON.stringify(SIZING)))
  const flows = { index: { 'engineering/feature-development': { title: 'Workflow: Developing a new feature', files: ['/wf/feature-development.md'] }, 'engineering/code-review': { title: 'Review', files: ['/wf/code-review.md'] } } }
  serve([{ path: '', roles: { list: { 'lead-backend': 'engineering' } }, workflows: flows }, ...WORKSPACES])
  try {
    await orch($, 'prompt mtg add decks')
    expect(asked[0]?.prompt).toContain('Workflows: engineering/feature-development (Workflow: Developing a new feature)')
    expect(asked[0]?.prompt).not.toContain('engineering/code-review')
    expect(launched[0]?.prompt).toContain('- Follow the workflow engineering/feature-development for your part (/wf/feature-development.md)')
    reply = { status: 'ready', workflow: 'made/up', title: 'X', brief: 'x' }
    await orch($, 'prompt mtg other thing')
    expect((await orch($, 'drop 1')).text).toContain('dropped')
    expect(launched.at(-1)?.prompt).not.toContain('Follow the workflow')
  } finally {
    serve(WORKSPACES)
  }
})

test('the queue outlives its session: a new orchestrator takes over a gone one\'s open tasks', async ($, on) => {
  const { files, sent } = world(on)
  on('session.id', () => ({ value: 'new-session' }) as never)
  const task = (id: number, state: string, worker: string, reviewer = '') =>
    ({ id, repo: 'acme/core/acme-backend', role: 'lead-backend', text: `task ${id}`, state, round: 1, worker, reviewer, base: 'abc', report: '', branchFrom: 'main', sizing: SIZING, reviews: [], updatedAt: 0 }) as unknown as Task
  const saved = {
    owner: 'orch-old',
    sessionId: 'old-session',
    savedAt: 0,
    tasks: [task(1, 'working', 'app-71'), task(2, 'reviewing', 'w2', 'orch-review-2-r1'), task(3, 'approved', 'w3')],
    workers: [{ name: 'app-71', bgId: '1', repo: 'acme/core/acme-backend', role: 'lead-backend', model: 'opus', effort: 'high', task: 1 }],
  }
  files.set('/.claude/orchestra/queues/old-session.json', JSON.stringify(saved))
  on('fs.list', () => ({ value: [{ name: 'old-session.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }) as never)
  const ran = await orch($, '')
  expect(ran.text).toContain('Took over the queue of orch-old, which is gone: 2 open task(s).')
  // The live worker reports here now; the task whose reviewer is gone waits for the person.
  expect(sent.find(m => m.to === 'app-71')?.text).toContain('The orchestrator of task #1 is now "app-22" (it was "orch-old")')
  expect(ran.text).toContain('#2: its session is gone: /orch retry 2 hands it to a fresh one.')
  const ui = await pane($)
  expect(await stateOf(ui, 1)).toBe('● working')
  expect(await stateOf(ui, 2)).toBe('⏸ blocked')
  // The old file is emptied, so no other session takes the same queue again; this one keeps its own.
  expect(JSON.parse(files.get('/.claude/orchestra/queues/old-session.json') ?? '{}').tasks).toEqual([])
  expect(JSON.parse(files.get('/.claude/orchestra/queues/new-session.json') ?? '{}').tasks).toHaveLength(3)
})

test('the usage reading carries each session\'s last action', () => {
  const u = toUsage({ model: 'claude-opus-5', context: 1, turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, last: 'Bash: run the tests', lastAt: '2026-10-06T11:56:20.218Z' }, 0)
  expect(u).toMatchObject({ last: 'Bash: run the tests', lastAt: Date.parse('2026-10-06T11:56:20.218Z'), isPriced: true })
})

test('a queue whose orchestrator still runs is not taken over', async ($, on) => {
  const { files } = world(on)
  on('session.id', () => ({ value: 'new-session' }) as never)
  const saved = {
    owner: 'app-71',
    sessionId: 'other-session',
    savedAt: 0,
    tasks: [{ id: 1, repo: 'mtg', role: 'developer', text: 'x', state: 'working', round: 1, worker: 'w', reviewer: '', base: '', report: '', branchFrom: 'main', sizing: SIZING, reviews: [], updatedAt: 0 }],
    workers: [],
  }
  files.set('/.claude/orchestra/queues/other-session.json', JSON.stringify(saved))
  on('fs.list', () => ({ value: [{ name: 'other-session.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }) as never)
  expect((await orch($, '')).text).not.toContain('Took over')
  expect(JSON.parse(files.get('/.claude/orchestra/queues/other-session.json') ?? '{}').tasks).toHaveLength(1)
})

test('a check sees the commit the task started from as {base}', async ($, on) => {
  const { commands, clock } = world(on)
  serve([{ ...(WORKSPACES[0] as Workspace), checks: { '*': ['git diff --name-only {base}'] } }])
  try {
    await orch($, 'task acme/core/acme-backend fix the export')
    await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: ok\nBRANCH: feat/export')
    await drain(clock)
    expect(commands).toContainEqual(['sh', '-c', 'git diff --name-only abc123'])
  } finally {
    serve(WORKSPACES)
  }
})

test('the workspace practices reach every worker and reviewer; an inner workspace with none of its own opts out', () => {
  const texts = [{ file: '/claude-code/cortex/practices/engineering.md', text: '# Engineering practices\n\n| **Commits** | gitmoji |', semantic: 'base' }]
  setWorkspaces([{ path: '', practices: { texts } }, { ...(WORKSPACES[0] as Workspace), practices: { docs: [], texts: [] } }])
  try {
    const worker = JSON.parse(workerAgent('developer', 'mtg'))['orch-developer'].prompt as string
    expect(worker).toContain("Follow these conventions in everything you write and commit; a repo's own written conventions win over them.")
    expect(worker).toContain('----- conventions: /claude-code/cortex/practices/engineering.md -----\n# Engineering practices')
    expect(JSON.parse(reviewerAgent('mtg'))['orch-reviewer'].prompt).toContain('one not followed is a finding')
    expect(JSON.parse(workerAgent('lead-backend', 'acme/core/acme-backend'))['orch-lead-backend'].prompt).not.toContain('Engineering practices')
  } finally {
    setWorkspaces(WORKSPACES)
  }
})

test('the report format and the orchestrator\'s name live in the agent definition, which no compaction summarises', () => {
  const worker = JSON.parse(workerAgent('lead-backend', 'acme/core/acme-backend', 'app-22'))['orch-lead-backend'].prompt as string
  expect(worker).toContain('also after your context was compacted: with SendMessage to the orchestrator, "app-22" (or the session a later [ORCH <name> …] message names)')
  expect(worker).toContain('BRANCH: <the task branch, exactly as git names it>')
  const stack = JSON.parse(workerAgent('platform-engineer', 'stack', 'app-22'))['orch-platform-engineer'].prompt as string
  expect(stack).toContain('CHANGES: <every change made to the target')
  expect(stack).not.toContain('BRANCH:')
  const reviewer = JSON.parse(reviewerAgent('mtg', 'app-22'))['orch-reviewer'].prompt as string
  expect(reviewer).toContain('VERDICT: APPROVED | CHANGES_REQUESTED')
})

test('an idle worker past half its context gets no new task', () => {
  const idle: Worker = { name: 'w1', bgId: 'a', repo: 'acme/core/b', role: 'lead-backend', model: 'opus', effort: 'high', task: null }
  const queued = [task(2, 'acme/core/b', 'queued')]
  expect(plan(queued, [idle]).map(m => m.worker?.name)).toEqual(['w1'])
  expect(plan(queued, [idle], new Set(['w1'])).map(m => m.worker)).toEqual([null])
})

test('dispatch reads the context of the idle workers before reusing one', async ($, on) => {
  const { launched, onPython } = world(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self0000-0000' }) as never)
  on('fs.list', () => ({ value: [{ name: '00000001-aaaa.jsonl', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }) as never)
  let context = 100_000
  onPython(argv =>
    String(argv[1]).endsWith('/usage.py')
      ? JSON.stringify({ '/home/test/.claude/projects/-app/00000001-aaaa.jsonl': { model: 'claude-opus-5-5', context, turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } })
      : '{}',
  )
  await orch($, 'task acme/core/acme-backend first')
  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: ok\nBRANCH: feat/a')
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')
  // A light worker is reused for the next task of its repo.
  await orch($, 'task acme/core/acme-backend second')
  expect(launched.filter(l => !l.name.startsWith('orch-review'))).toHaveLength(1)
  await receive($, 'orch-lead-backend-acme-backend', 'STATUS: done\nSUMMARY: ok\nBRANCH: feat/b')
  await receive($, 'orch-review-2-r1', 'VERDICT: APPROVED\nFINDINGS:\n')
  // Past half its window, it is not: a fresh session takes the third task.
  context = 600_000
  await orch($, 'task acme/core/acme-backend third')
  expect(launched.filter(l => !l.name.startsWith('orch-review')).map(l => l.name)).toEqual(['orch-lead-backend-acme-backend', 'orch-lead-backend-acme-backend-2'])
})
