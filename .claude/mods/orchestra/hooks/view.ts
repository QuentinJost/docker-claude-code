import type { Task, TaskState } from '../types'
import { MAX_ROUNDS } from './pipeline'

/** How each task state is drawn: an icon, a short label and an ANSI colour name. */
export const BADGE: Record<TaskState, { icon: string; label: string; color: string }> = {
  queued: { icon: '◌', label: 'queued', color: 'gray' },
  working: { icon: '●', label: 'working', color: 'yellow' },
  reviewing: { icon: '◐', label: 'review', color: 'cyan' },
  approved: { icon: '✔', label: 'approved', color: 'green' },
  blocked: { icon: '⏸', label: 'blocked', color: 'magenta' },
  escalated: { icon: '⚠', label: 'your call', color: 'red' },
  dropped: { icon: '✕', label: 'dropped', color: 'gray' },
}

/** The review rounds used so far, as dots: ●●○ is round 2 of 3. */
export const roundDots = (task: Task): string => {
  const used = task.state === 'queued' ? 0 : Math.min(task.round, MAX_ROUNDS)
  return '●'.repeat(used) + '○'.repeat(Math.max(0, MAX_ROUNDS - used))
}

/** A short age: 42s, 7m, 3h, 2d. */
export const ago = (since: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

/** One labelled line of a worker report (SUMMARY, CHANGES, TESTS, NEEDS), or ''. */
export const reportLine = (report: string, label: string): string =>
  new RegExp(`^\\s*${label}:\\s*(.+)$`, 'im').exec(report)?.[1]?.trim() ?? ''

/** The findings of the last review, one per line, without blank lines. */
export const lastFindings = (task: Task): string[] =>
  (task.reviews.at(-1)?.findings ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

export const STATES: TaskState[] = ['working', 'reviewing', 'queued', 'blocked', 'escalated', 'approved']

/** Tasks in the order the person reads them: what needs them first, then what moves, then what is done. */
export const ordered = (tasks: Task[]): Task[] => {
  const rank: Record<TaskState, number> = {
    escalated: 0,
    blocked: 1,
    reviewing: 2,
    working: 3,
    queued: 4,
    approved: 5,
    dropped: 6,
  }
  return [...tasks].sort((a, b) => rank[a.state] - rank[b.state] || a.id - b.id)
}
