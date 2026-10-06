import type { WorkerUsage } from '../types'

/** What `usage.py` reports for one transcript. */
export type TranscriptTotals = {
  model: string
  context: number
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  /** The session's last tool call, in one line, and when (ISO). */
  last?: string
  lastAt?: string
  /** The session's subagents, by model: their own transcripts, summed. */
  subagents?: TranscriptTotals[]
}

/**
 * Public Claude API rates in $ per million tokens (claude-api reference, 2026-09-25):
 * input, output, cache write 5 min (1.25× input), cache write 1 h (2× input), cache read;
 * and the context window. A subscription is not billed this way: the cost is an estimate.
 */
export const PRICES: Record<string, { input: number; output: number; write5m: number; write1h: number; read: number; window: number }> = {
  'claude-fable-5-1': { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 0.25, window: 1_000_000 },
  'claude-opus-5-5': { input: 4, output: 20, write5m: 5, write1h: 8, read: 0.2, window: 1_000_000 },
  'claude-sonnet-5-5': { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.2, window: 1_000_000 },
  'claude-haiku-4-5': { input: 1, output: 5, write5m: 1.25, write1h: 2, read: 0.1, window: 200_000 },
}

/** The price row of a model id as transcripts write it (`claude-haiku-4-5-20251001` included). */
export const priceOf = (model: string) =>
  Object.entries(PRICES).find(
    // Transcripts also name a model by its family alone (`claude-opus-5` for Opus 5.5).
    ([id]) => model === id || model.startsWith(`${id}-`) || model.startsWith(`${id}[`) || (/^claude-[a-z]+-\d+$/.test(model) && id.startsWith(`${model}-`)),
  )?.[1]

/** The model aliases sessions are launched with, as transcripts name them. */
const ALIASES: Record<string, string> = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5' }

const priced = (totals: Omit<TranscriptTotals, 'subagents'>): number => {
  const price = priceOf(totals.model)
  return price
    ? (totals.input * price.input +
        totals.output * price.output +
        totals.cacheWrite5m * price.write5m +
        totals.cacheWrite1h * price.write1h +
        totals.cacheRead * price.read) /
        1_000_000
    : 0
}

/** The estimated cost of one call to the orchestrator's model, from what the call reports. */
export const callCost = (
  model: string,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | undefined,
): number =>
  usage === undefined
    ? 0
    : priced({
    model: ALIASES[model] ?? model,
    context: 0,
    turns: 1,
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite5m: usage.cache_creation_input_tokens ?? 0,
        cacheWrite1h: 0,
      })

const tokenSum = (t: Omit<TranscriptTotals, 'subagents'>): number => t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h

/** The estimated cost and context fill of one session from its transcript totals, its subagents included. */
export const toUsage = (totals: TranscriptTotals, at: number): Omit<WorkerUsage, 'task' | 'role'> => {
  const price = priceOf(totals.model)
  const subs = totals.subagents ?? []
  const cost = priced(totals) + subs.reduce((sum, sub) => sum + priced(sub), 0)

  return {
    model: totals.model,
    context: totals.context,
    window: price?.window ?? 1_000_000,
    tokens: tokenSum(totals) + subs.reduce((sum, sub) => sum + tokenSum(sub), 0),
    output: totals.output + subs.reduce((sum, sub) => sum + sub.output, 0),
    turns: totals.turns,
    cost,
    // A session that has not answered yet costs nothing, whatever its model.
    isPriced: (price !== undefined || totals.turns === 0) && subs.every(sub => priceOf(sub.model) !== undefined),
    ...(totals.last ? { last: totals.last, lastAt: Date.parse(totals.lastAt ?? '') || 0 } : {}),
    at,
  }
}

/** A five-cell fill bar and the percentage, as the status line draws it: ▰▰▱▱▱ 34%. */
export const fillBar = (context: number, window: number): string => {
  const ratio = window > 0 ? Math.min(1, context / window) : 0
  const cells = Math.round(ratio * 5)
  return `${'▰'.repeat(cells)}${'▱'.repeat(5 - cells)} ${Math.round(ratio * 100)}%`
}

/** 0.004 → $0.00, 1.234 → $1.23, 12.3 → $12.3. */
export const dollars = (cost: number): string => (cost >= 10 ? `$${cost.toFixed(1)}` : `$${cost.toFixed(2)}`)

/** 950 → 950, 12_340 → 12.3k, 1_234_000 → 1.2M. */
export const tokens = (count: number): string =>
  count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
