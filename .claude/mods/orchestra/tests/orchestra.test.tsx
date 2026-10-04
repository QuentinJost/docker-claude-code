import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { deliveryFailure, isAutoModeHold, parseBackgrounded, parseListing } from '../hooks/parse'
import { dollars, fillBar, toUsage } from '../hooks/usage'
import { SIZING_SYSTEM, atLeast, hasJira, parseRouting, parseNeeds, parseOverrides, parseSizing, parseStatus, parseUpgrade, parseVerdict, plan, reviewBrief, roleFor, upgradePrompt, workerBrief } from '../hooks/pipeline'
import type { Task, Worker } from '../types'

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
  expect(roleFor('core/bluspark-frontend', 'fix the menu').role).toBe('lead-frontend')
  expect(roleFor('core/bluspark-backend', 'add an index @dba')).toEqual({ role: 'dba', text: 'add an index' })
  expect(roleFor('core/bluspark-backend', 'mail @nobody').role).toBe('lead-backend')
})

test('a repo without Jira never asks for a key', async () => {
  const task = { id: 7, repo: 'datalodestar', text: 'bulk delete', branchFrom: 'main', round: 1, report: '', reviews: [] } as unknown as Task
  expect(hasJira('datalodestar')).toBe(false)
  expect(workerBrief('orch', task)).not.toContain('BLUSPARK')
  expect(workerBrief('orch', task)).toContain('git switch -c <branch> main')
  expect(reviewBrief('orch', task)).toContain('no Jira project')
  expect(upgradePrompt('datalodestar', 'lead-backend', 'x')).toContain('no Jira project')

  const bluspark = { ...task, repo: 'core/bluspark' } as Task
  expect(hasJira('core/bluspark')).toBe(true)
  expect(workerBrief('orch', bluspark)).toContain('BLUSPARK-<n>')
  expect(reviewBrief('orch', bluspark)).not.toContain('no Jira project')
  expect(upgradePrompt('core/bluspark', 'lead-backend', 'x')).not.toContain('no Jira project')
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
  expect(parseNeeds('STATUS: done\nNEEDS: none. The brief asks for BLUSPARK-<n>.')).toBeNull()
  expect(parseNeeds('STATUS: done')).toBeNull()
})

test('one active task per repo, one task per worker', async () => {
  const idle: Worker = { name: 'w1', bgId: 'a', repo: 'core/b', role: 'lead-backend', model: 'opus', effort: 'high', task: null }
  const moves = plan(
    [task(1, 'core/b', 'working'), task(2, 'core/b', 'queued'), task(3, 'core/f', 'queued'), task(4, 'core/f', 'queued')],
    [idle],
  )
  expect(moves.map(m => [m.task.id, m.worker?.name ?? null])).toEqual([[3, null]])
  expect(plan([task(2, 'core/b', 'queued')], [idle]).map(m => m.worker?.name)).toEqual(['w1'])
  // An idle worker set up with another model is not reused.
  expect(plan([task(2, 'core/b', 'queued')], [{ ...idle, model: 'sonnet' }]).map(m => m.worker)).toEqual([null])
})

test('reads the sizing reply and the forced settings', async () => {
  expect(parseSizing('Sure:\n{"work":{"model":"fable","effort":"xhigh"},"review":{"model":"opus","effort":"high"},"why":"risky"}')).toEqual({
    work: { model: 'fable', effort: 'xhigh' },
    review: { model: 'opus', effort: 'high' },
    why: 'risky',
  })
  expect(parseSizing('{"work":{"model":"gpt","effort":"high"},"review":{"model":"opus","effort":"high"}}')).toBeNull()
  expect(parseSizing('no json')).toBeNull()
  expect(parseOverrides('fix it model:sonnet effort:low now')).toEqual({ text: 'fix it now', work: { model: 'sonnet', effort: 'low' } })
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
          : { isAnswered: true, text: reply, usage: { input_tokens: 1, output_tokens: 1 } },
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
  on('process.run', (_$, e) => {
    const [cmd, sub, ...rest] = e.argv
    let stdout = ''
    if (cmd === 'python3') {
      stdout = python(e.argv)
    } else if (cmd === 'git') {
      stdout = e.argv.includes('--abbrev-ref') ? 'main\n' : 'abc123\n'
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
    holdSends: (count: number) => {
      holds = count
    },
    onPython: (answer: typeof python) => {
      python = answer
    },
    refuseSends: (reason: string | null) => {
      refuse = reason
    },
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

  await orch($, 'task core/bluspark-backend BLUSPARK-7300 fix the export')
  await orch($, 'task core/bluspark-backend BLUSPARK-7301 second backend task')
  await orch($, 'task core/bluspark-frontend BLUSPARK-7302 fix the menu')

  // Two repos, two workers launched with their agents; the second backend task waits.
  expect(launched.map(l => [l.name, l.agent])).toEqual([
    ['orch-lead-backend-bluspark-backend', 'orch-lead-backend'],
    ['orch-lead-frontend-bluspark-frontend', 'orch-lead-frontend'],
  ])
  expect(launched[0]?.prompt).toMatch(/^\[ORCH app-22 · task #1 · round 1\] BLUSPARK-7300 fix the export/)
  expect(launched[0]?.prompt).toContain('created from main (git switch -c <key> main)')

  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 2)).toBe('◌ queued')

  // Worker done → a fresh reviewer session, diffing against the base.
  await receive($, 'orch-lead-backend-bluspark-backend', 'STATUS: done\nSUMMARY: export fixed\nCHANGES: BLUSPARK-7300, 1 commit')
  expect(launched[2]?.name).toBe('orch-review-1-r1')
  expect(launched[2]?.agent).toBe('orch-reviewer')
  expect(launched[2]?.prompt).toContain('diff abc123')
  expect(launched[2]?.prompt).toContain('SUMMARY: export fixed')

  // Rejected → reviewer removed, findings back to the same worker, round 2.
  await receive($, 'orch-review-1-r1', 'VERDICT: CHANGES_REQUESTED\nFINDINGS:\n- 🔴 Export.php:12 — no test — add one')
  expect(stopped).toEqual(['00000003'])
  const rework = sent.find(s => s.to === 'orch-lead-backend-bluspark-backend')
  expect(rework?.text).toMatch(/task #1 · round 2/)
  expect(rework?.text).toContain('Export.php:12')

  // Done again → second reviewer → approved → task 2 goes to the same, now idle, worker.
  await receive($, 'orch-lead-backend-bluspark-backend', 'STATUS: done\nSUMMARY: test added')
  expect(launched[3]?.name).toBe('orch-review-1-r2')
  expect(launched[3]?.prompt).toContain('Round 1:')
  // The approval is the one report the model is handed, as a digest to write up for the person.
  const approved = await receive($, 'orch-review-1-r2', 'VERDICT: APPROVED\nFINDINGS:\n- ⚪ Export.php:40 — long line — optional')
  expect(approved).toMatchObject({ text: expect.stringContaining('[ORCH app-22] Task #1 approved at round 2 in core/bluspark-backend: BLUSPARK-7300 fix the export') })
  expect((approved as { text: string }).text).toContain('SUMMARY: test added')
  expect((approved as { text: string }).text).toContain('Export.php:40')
  expect((approved as { text: string }).text).toContain('Write this up for the person')

  // Approved tasks are folded away until `a` shows them.
  expect(await stateOf(ui, 1)).toBeUndefined()
  await ui.press({ key: 'toggle-done' })
  expect(await stateOf(ui, 1)).toBe('✔ approved')
  expect(await stateOf(ui, 2)).toBe('● working')
  expect(launched).toHaveLength(4)
  expect(sent.at(-1)?.to).toBe('orch-lead-backend-bluspark-backend')
  expect(sent.at(-1)?.text).toMatch(/task #2 · round 1/)
  expect(sent.at(-1)?.text).toContain('created from main')

  // Reports of its own sessions never reach the model; anyone else's do.
  expect(await receive($, 'orch-lead-frontend-bluspark-frontend', 'progress note')).toEqual({ consumed: 'orchestra: report handled by the pipeline' })
  expect(await receive($, 'app-71', 'hello')).toMatchObject({ text: expect.any(String) })
})

test('hands the task to the person after three rejections, and retry restarts it', async ($, on) => {
  const { launched, sent } = world(on)
  await orch($, 'task core/bluspark-backend BLUSPARK-7300 fix the export')
  const worker = 'orch-lead-backend-bluspark-backend'

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
  await orch($, 'task core/bluspark-backend fix without a key')
  await receive($, 'orch-lead-backend-bluspark-backend', 'STATUS: blocked\nNEEDS: the Jira key')
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
  await orch($, 'task datalodestar bulk delete')
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
  await orch($, 'task core/bluspark-backend BLUSPARK-7300 fix the export')

  // As in the real run: framed by the engine, origin peer.
  const submitted = await $.prompt.submit({
    text: `Another Claude session sent a message:\n${from('orch-lead-backend-bluspark-backend', 'STATUS: done\nSUMMARY: fixed')}`,
    origin: { kind: 'peer' },
    wait: false,
  })
  expect(submitted).toEqual({ drop: 'orchestra: orch-lead-backend-bluspark-backend report handled by the pipeline' })
  const approved = await $.prompt.submit({
    text: `Another Claude session sent a message:\n${from('orch-review-1-r1', '[task #1 · round 1] VERDICT: APPROVED\nFINDINGS:\n')}`,
    origin: { kind: 'peer' },
    wait: false,
  })
  expect(approved).toMatchObject({ text: expect.stringContaining('Task #1 approved at round 1') })
  expect(launched.at(-1)?.name).toBe('orch-review-1-r1')

  // The same report through the other door moves nothing twice.
  await receive($, 'orch-lead-backend-bluspark-backend', 'STATUS: done\nSUMMARY: fixed')
  expect(launched.filter(l => l.agent === 'orch-reviewer')).toHaveLength(1)

  // Someone else's message still reaches the model.
  expect(await $.prompt.submit({ text: from('app-71', 'hello'), origin: { kind: 'peer' }, wait: false })).toMatchObject({ text: expect.any(String) })
})

test('the orchestrator model sizes each session; forced settings and fallback', async ($, on) => {
  const { launched, asked, stopped } = world(on)
  await orch($, 'task core/bluspark-backend BLUSPARK-7300 fix the export')

  expect(asked[0]?.model).toBe('fable')
  expect(asked[0]?.prompt).toContain('Role: lead-backend')
  expect(launched[0]).toMatchObject({ model: 'opus', effort: 'high' })
  await receive($, 'orch-lead-backend-bluspark-backend', 'STATUS: done')
  expect(launched[1]).toMatchObject({ name: 'orch-review-1-r1', model: 'opus', effort: 'xhigh' })
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')

  // Next task on the repo forces another setting: the idle worker makes room for a new one,
  // and a forced model below the floor is raised to opus.
  await orch($, 'task core/bluspark-backend BLUSPARK-7301 rename a constant model:sonnet effort:low')
  expect(stopped).toContain('00000001')
  expect(launched[2]).toMatchObject({ model: 'opus', effort: 'low' })
  expect(launched[2]?.prompt).toContain('BLUSPARK-7301 rename a constant')
  expect(launched[2]?.prompt).not.toContain('model:')
})

test('falls back to the role defaults when the orchestrator model does not answer', async ($, on) => {
  const { launched } = world(on, null)
  await orch($, 'task core/bluspark-backend BLUSPARK-7300 fix the export @tech-writer')
  expect(launched[0]).toMatchObject({ model: 'opus', effort: 'medium', agent: 'orch-tech-writer' })
})

test('a light model chosen for development is raised to the floor; the review keeps its choice', async ($, on) => {
  const { launched } = world(on, JSON.stringify({ work: { model: 'sonnet', effort: 'medium' }, review: { model: 'sonnet', effort: 'low' }, why: 'tiny fix' }))
  await orch($, 'task core/bluspark-backend BLUSPARK-7300 fix a typo')
  expect(launched[0]).toMatchObject({ model: 'opus', effort: 'medium' })
  await receive($, 'orch-lead-backend-bluspark-backend', 'STATUS: done')
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

  await orch($, 'task core/bluspark-backend BLUSPARK-7300 fix the export')
  await receive($, 'orch-lead-backend-bluspark-backend', 'STATUS: blocked\nNEEDS: the key')
  const drawn = await band()
  expect(await drawn.find({ type: 'Text', text: /◆ orchestra/ })).toBeDefined()
  expect(await drawn.find({ type: 'Text', text: /⚠ 1 needs you/ })).toBeDefined()
})

test('queues several tasks in one command', async ($, on) => {
  const { launched } = world(on)
  const ran = await orch($, 'task core/bluspark-backend BLUSPARK-1 a ;; core/bluspark-frontend BLUSPARK-2 b ;; core/bluspark-backend BLUSPARK-3 c')
  expect(ran).toMatchObject({ text: '3 tasks queued.' })
  expect(launched.map(l => l.name)).toEqual(['orch-lead-backend-bluspark-backend', 'orch-lead-frontend-bluspark-frontend'])
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

  await orch($, 'task core/bluspark-backend BLUSPARK-7300 fix the export')
  await receive($, 'orch-lead-backend-bluspark-backend', 'STATUS: done')
  expect(launched.map(l => l.name)).toEqual(['orch-lead-backend-bluspark-backend', 'orch-review-1-r1'])
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
  expect(parseUpgrade('Sure:\n{"status":"ready","title":"BLUSPARK-7300 fix the export","brief":"## Objective\\nExport works."}')).toEqual({
    title: 'BLUSPARK-7300 fix the export',
    brief: '## Objective\nExport works.',
  })
  expect(parseUpgrade('{"status":"unclear","questions":["Which export?",""]}')).toEqual({ questions: ['Which export?'] })
  expect(parseUpgrade('{"status":"ready","title":"x","brief":"  "}')).toBeNull()
  expect(parseUpgrade('{"status":"unclear","questions":[]}')).toBeNull()
  expect(parseUpgrade('no json here')).toBeNull()
})

const BRIEF = { status: 'ready', title: 'BLUSPARK-7300 fix the CSV export of issues', brief: '## Objective\nThe CSV export of issues must include every column.\n\n## Done when\nphpunit export suite green.' }
const upgradeOrSize = (e: { system?: string; prompt: string }) => (e.system?.includes('Prompt Manager') ? JSON.stringify(BRIEF) : JSON.stringify(SIZING))

test('/orch prompt has the model write the brief, then queues and sizes that brief', async ($, on) => {
  const { launched, asked } = world(on, JSON.stringify(SIZING), upgradeOrSize)
  const ran = await orch($, 'prompt core/bluspark-backend BLUSPARK-7300 fix the export @tech-writer model:sonnet effort:low')

  // 1st call: the upgrade, on the orchestrator model, with the request as typed, role and overrides stripped.
  expect(asked[0]?.model).toBe('fable')
  expect(asked[0]?.prompt).toContain('Request:\nBLUSPARK-7300 fix the export')
  expect(asked[0]?.prompt).toContain('Developer role: tech-writer')
  expect(asked[0]?.prompt).not.toContain('model:')
  // 2nd call: the sizing, on the brief.
  expect(asked[1]?.prompt).toContain('Role: tech-writer')
  expect(asked[1]?.prompt).toContain('Task: BLUSPARK-7300 fix the CSV export of issues')

  // The worker gets the brief, under the forced setting (sonnet raised to the floor) and role.
  expect(launched[0]).toMatchObject({ agent: 'orch-tech-writer', model: 'opus', effort: 'low' })
  expect(launched[0]?.prompt).toContain('round 1] BLUSPARK-7300 fix the CSV export of issues')
  expect(launched[0]?.prompt).toContain('## Done when\nphpunit export suite green.')
  expect(launched[0]?.prompt).not.toContain('Task: BLUSPARK-7300 fix the export\n')

  // The person sees what was sent.
  expect(ran).toMatchObject({ text: expect.stringContaining('Task #1 queued in core/bluspark-backend for tech-writer') })
  expect(ran).toMatchObject({ text: expect.stringContaining('## Objective') })
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 1)).toBe('● working')
})

test('/orch prompt on an unclear request asks instead of queuing', async ($, on) => {
  const { launched, asked } = world(on, JSON.stringify(SIZING), e =>
    e.system?.includes('Prompt Manager') ? JSON.stringify({ status: 'unclear', questions: ['Which export: CSV or PDF?', 'Jira key?'] }) : JSON.stringify(SIZING),
  )
  const ran = await orch($, 'prompt core/bluspark-backend fix the export')
  expect(asked).toHaveLength(1)
  expect(launched).toHaveLength(0)
  expect(ran).toMatchObject({ text: expect.stringContaining('- Which export: CSV or PDF?') })
  expect(ran).toMatchObject({ text: expect.stringContaining('- Jira key?') })
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 1)).toBeUndefined()
})

test('/orch prompt queues nothing when the model does not answer', async ($, on) => {
  const { launched } = world(on, null)
  const ran = await orch($, 'prompt core/bluspark-backend BLUSPARK-7300 fix the export')
  expect(launched).toHaveLength(0)
  expect(ran).toMatchObject({ text: expect.stringContaining('nothing queued') })
})

const REPOS = [
  { repo: 'core/bluspark-backend', about: 'API REST cœur métier Bluspark' },
  { repo: 'core/bluspark-frontend', about: 'PWA Bluspark' },
  { repo: 'datalodestar', about: 'Graphical database client' },
]

/** The world's python answers the repo listing; the model routes with `route`, then sizes. */
const routedWorld = (on: On, route: unknown) => {
  const w = world(on, JSON.stringify(SIZING), e => (e.system?.includes('pick where the work happens') ? JSON.stringify(route) : JSON.stringify(SIZING)))
  w.onPython(argv => (String(argv[1]).endsWith('/repos.py') ? JSON.stringify(REPOS) : '{}'))
  return w
}

test('reads the routing reply: tasks on listed repos only, or questions', async () => {
  const ok = parseRouting(JSON.stringify({ status: 'ready', tasks: [{ repo: 'datalodestar', title: 'T', brief: 'B' }] }), REPOS)
  expect(ok).toEqual({ tasks: [{ repo: 'datalodestar', title: 'T', brief: 'B' }] })
  // A task on a repo that is not listed spoils the whole answer: nothing half-queued.
  expect(parseRouting(JSON.stringify({ status: 'ready', tasks: [{ repo: 'datalodestar', brief: 'B' }, { repo: 'nowhere', brief: 'B' }] }), REPOS)).toBeNull()
  expect(parseRouting(JSON.stringify({ status: 'unclear', questions: ['Which repo?'] }), REPOS)).toEqual({ questions: ['Which repo?'] })
  expect(parseRouting('no json', REPOS)).toBeNull()
})

test('/orch prompt without a repo: the model picks it, one task per repo', async ($, on) => {
  const { launched, asked } = routedWorld(on, {
    status: 'ready',
    tasks: [
      { repo: 'core/bluspark-backend', title: 'BLUSPARK-7400 add the field to the API', brief: 'back brief' },
      { repo: 'core/bluspark-frontend', title: 'BLUSPARK-7400 show the field', brief: 'front brief' },
    ],
  })
  const ran = await orch($, 'prompt BLUSPARK-7400 show the collection day on the issue page model:opus')

  expect(asked[0]?.prompt).toContain('- core/bluspark-backend — API REST cœur métier Bluspark')
  expect(asked[0]?.prompt).toContain('- datalodestar — Graphical database client (no Jira project)')
  expect(asked[0]?.prompt).toContain('Request:\nBLUSPARK-7400 show the collection day on the issue page')
  expect(asked[0]?.prompt).not.toContain('model:')
  expect(launched.map(l => [l.name, l.agent])).toEqual([
    ['orch-lead-backend-bluspark-backend', 'orch-lead-backend'],
    ['orch-lead-frontend-bluspark-frontend', 'orch-lead-frontend'],
  ])
  expect(launched[1]?.prompt).toContain('Repo: /app/core/bluspark-frontend')
  expect(ran).toMatchObject({ text: expect.stringContaining('Task #2 queued in core/bluspark-frontend for lead-frontend') })
})

test('/orch prompt without a repo keeps a role the person named', async ($, on) => {
  const { launched } = routedWorld(on, { status: 'ready', tasks: [{ repo: 'datalodestar', title: 'Document bulk delete', brief: 'doc brief' }] })
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
  await orch($, 'prompt datalodestar fix the export')
  expect(asked[0]?.prompt).toMatch(/^Repo: \/app\/datalodestar/)
})

test('a task on the stack runs without git, and its review checks the stack', async ($, on) => {
  const { launched, sent } = world(on)
  await orch($, 'task stack reindex the dev_container alias in OpenSearch')

  const worker = 'orch-platform-engineer-stack'
  expect(launched[0]).toMatchObject({ name: worker, agent: 'orch-platform-engineer' })
  expect(launched[0]?.prompt).toContain('Target: the running local Bluspark stack, working from /app')
  expect(launched[0]?.prompt).toContain('no branch, no commit')
  expect(launched[0]?.prompt).toContain('how to undo it')
  expect(launched[0]?.prompt).not.toContain('git switch')
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 1)).toBe('● working')

  await receive($, worker, 'STATUS: done\nSUMMARY: reindexed\nCHANGES: populate run\nTESTS: _count = 773k')
  const review = launched.at(-1)
  expect(review?.name).toBe('orch-review-1-r1')
  expect(review?.prompt).toContain('there is no diff')
  expect(review?.prompt).toContain('read-only commands only')
  expect(review?.prompt).not.toContain('git -C')

  // A rejection goes back with the stack's rules, not the branch's.
  await receive($, 'orch-review-1-r1', 'VERDICT: CHANGES_REQUESTED\nFINDINGS:\n- 🔴 _count — 12 docs, not 773k — reindex again')
  expect(sent.at(-1)?.text).toContain('Target: the running local stack, from /app')
  expect(sent.at(-1)?.text).toContain('local stack only')
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
  expect(asked[0]?.prompt).toContain('- stack — the running local Bluspark stack, no git')
  expect(launched[0]?.name).toBe('orch-platform-engineer-stack')
  expect(launched[0]?.prompt).toContain('Target: the running local Bluspark stack')
})

test('retry answers a blocked worker and tells whether it was delivered', async ($, on) => {
  const { sent, watched, refuseSends } = world(on)
  await orch($, 'task datalodestar delete a database from the listing')
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
  await orch($, 'task datalodestar BLUSPARK-7400 delete a database')
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
  await orch($, 'task datalodestar bulk delete')
  await receive($, worker, 'STATUS: blocked\nNEEDS: a Jira key')
  holdSends(1)
  expect((await orch($, 'retry 1 no jira ticket')).text).toBe(`Task #1 sent back to ${worker}.`)
  expect(sent.at(-1)?.text).toContain('The person answered: no jira ticket')
  expect(submitted).toEqual([])
})

test('a retry the classifier holds twice is handed to Claude, framed as the plugin\'s', async ($, on) => {
  const { sent, submitted, holdSends, clock } = world(on)
  const worker = 'orch-lead-backend-datalodestar'
  await orch($, 'task datalodestar bulk delete')
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
  await orch($, 'task datalodestar BLUSPARK-7401 first')
  await receive($, worker, 'STATUS: done\nSUMMARY: done')
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')
  expect(launched).toHaveLength(2)

  // An hour later the daemon has stopped the idle worker, which the orchestrator still lists.
  kill(worker)
  expect(await orch($, `${worker} are you there`)).toMatchObject({ text: `Not delivered to ${worker}: No agent named '${worker}' is reachable.` })

  const before = tried.length
  await orch($, 'task datalodestar BLUSPARK-7402 second')
  // Checked before use: no brief is even tried on the gone session.
  expect(tried.slice(before)).toEqual([])
  expect(stopped).toContain('00000001')
  expect(launched).toHaveLength(3)
  expect(launched[2]?.name).toBe(worker)
  expect(launched[2]?.prompt).toMatch(/task #2 · round 1\] BLUSPARK-7402 second/)
  expect(sent.filter(s => s.text.includes('task #2'))).toHaveLength(0)
  const ui = await $.ui.mount({ plugin: 'orchestra', surface: 'terminal', component: 'Pane', requestId: 'orchestra', props: PANE_PROPS })
  expect(await stateOf(ui, 2)).toBe('● working')
})

test('a reused worker that turns the brief down is replaced by a fresh session', async ($, on) => {
  const { launched, stopped, refuseSends } = world(on)
  const worker = 'orch-lead-backend-datalodestar'
  await orch($, 'task datalodestar BLUSPARK-7404 first')
  await receive($, worker, 'STATUS: done')
  await receive($, 'orch-review-1-r1', 'VERDICT: APPROVED\nFINDINGS:\n')

  refuseSends('this session takes no messages from other sessions')
  await orch($, 'task datalodestar BLUSPARK-7405 second')
  refuseSends(null)
  expect(stopped).toContain('00000001')
  expect(launched).toHaveLength(3)
  expect(launched[2]?.name).toMatch(/^orch-lead-backend-datalodestar(-2)?$/)
  expect(launched[2]?.prompt).toMatch(/task #2 · round 1\] BLUSPARK-7405 second/)
})

test('retry to a worker the daemon stopped hands the task to a fresh session, briefed in full', async ($, on) => {
  const { launched, stopped, kill } = world(on)
  const worker = 'orch-lead-backend-datalodestar'
  await orch($, 'task datalodestar delete several databases')
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
  await orch($, 'task datalodestar BLUSPARK-7403 delete several databases')
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
  await orch($, 'task core/bluspark-backend BLUSPARK-7310 fix a typo')
  expect(launched[0]).toMatchObject({ model: 'opus', effort: 'low' })
  await receive($, 'orch-lead-backend-bluspark-backend', 'STATUS: done\nSUMMARY: typo fixed')
  expect(launched[1]).toMatchObject({ name: 'orch-review-1-r1', model: 'sonnet', effort: 'low' })
  expect(launched.map(l => l.model)).not.toContain('haiku')
  expect(SIZING_SYSTEM).toContain('Haiku is never used.')
})
