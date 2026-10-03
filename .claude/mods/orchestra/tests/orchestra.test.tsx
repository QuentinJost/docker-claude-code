import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseBackgrounded, parseListing } from '../hooks/parse'
import { dollars, fillBar, toUsage } from '../hooks/usage'
import { atLeast, parseNeeds, parseOverrides, parseSizing, parseUpgrade, parseVerdict, plan, roleFor } from '../hooks/pipeline'
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

test('reads a verdict and its findings', async () => {
  expect(parseVerdict(from('r', 'VERDICT: CHANGES_REQUESTED\nFINDINGS:\n- 🔴 a.php:3 — x — y'))).toEqual({
    isApproved: false,
    findings: '- 🔴 a.php:3 — x — y',
  })
  expect(parseVerdict(from('r', 'VERDICT: APPROVED\nFINDINGS:\n'))?.isApproved).toBe(true)
  expect(parseVerdict(from('r', 'looks fine'))).toBeNull()
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

/** Answers what the orchestrator runs: git for the base, claude to start and stop sessions. */
const world = (on: On, sizingReply: string | null = JSON.stringify(SIZING), replyFor: (e: { system?: string; prompt: string }) => string | null = () => sizingReply) => {
  const launched: { name: string; agent: string; model: string; effort: string; prompt: string }[] = []
  const asked: { model: string; prompt: string }[] = []
  const stopped: string[] = []
  const sent: { to: string; text: string }[] = []
  let ids = 0
  let python: (argv: readonly string[]) => string = () => '{}'

  mock.clock(on, { now: Date.UTC(2026, 9, 3, 10, 0) })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.receive', (_$, e) => ({ text: e.text }))
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: LISTING } }))
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
  on('session.send', (_$, e) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
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
      stdout = `backgrounded · ${String(ids).padStart(8, '0')} · ${name}\n`
    } else if (cmd === 'claude' && sub === 'stop') {
      stopped.push(rest[0] ?? '')
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return { launched, stopped, sent, asked, onPython: (answer: typeof python) => { python = answer } }
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
  await receive($, 'orch-review-1-r2', 'VERDICT: APPROVED\nFINDINGS:\n')

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

test('a local peer report, which arrives as a submitted prompt, drives the pipeline and is dropped', async ($, on) => {
  const { launched } = world(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await orch($, 'task core/bluspark-backend BLUSPARK-7300 fix the export')

  // As in the real run: framed by the engine, origin peer.
  const submitted = await $.prompt.submit({
    text: `Another Claude session sent a message:\n${from('orch-lead-backend-bluspark-backend', 'STATUS: done\nSUMMARY: fixed')}`,
    origin: { kind: 'peer' },
    wait: false,
  })
  expect(submitted).toEqual({ drop: 'orchestra: orch-lead-backend-bluspark-backend report handled by the pipeline' })
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
