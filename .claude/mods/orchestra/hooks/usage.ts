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
  Object.entries(PRICES).find(([id]) => model === id || model.startsWith(`${id}-`) || model.startsWith(`${id}[`))?.[1]

/** The estimated cost and context fill of one session from its transcript totals. */
export const toUsage = (totals: TranscriptTotals, at: number): Omit<WorkerUsage, 'task' | 'role'> => {
  const price = priceOf(totals.model)
  const cost = price
    ? (totals.input * price.input +
        totals.output * price.output +
        totals.cacheWrite5m * price.write5m +
        totals.cacheWrite1h * price.write1h +
        totals.cacheRead * price.read) /
      1_000_000
    : 0

  return {
    model: totals.model,
    context: totals.context,
    window: price?.window ?? 1_000_000,
    tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite5m + totals.cacheWrite1h,
    output: totals.output,
    turns: totals.turns,
    cost,
    // A session that has not answered yet costs nothing, whatever its model.
    isPriced: price !== undefined || totals.turns === 0,
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
