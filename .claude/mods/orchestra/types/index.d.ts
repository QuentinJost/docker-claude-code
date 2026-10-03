export type Peer = { name: string; ref: string; kind: string; status: string; started: string }

export type TaskState = 'queued' | 'working' | 'reviewing' | 'approved' | 'blocked' | 'escalated' | 'dropped'

/** What a session is launched with. */
export type Setting = { model: string; effort: string }

/** The model and effort a task's development and reviews run with, and why. */
export type Sizing = { work: Setting; review: Setting; why: string }

export type Review = { round: number; isApproved: boolean; findings: string }

export type Task = {
  id: number
  repo: string
  role: string
  text: string
  state: TaskState
  /** 1 for the first development, +1 after each rejected review. */
  round: number
  worker: string
  reviewer: string
  /** The branch the task's branch starts from: the one the repo was on at its first task. */
  branchFrom: string
  /** That branch's head when the task was dispatched: what the reviewer diffs against. */
  base: string
  report: string
  sizing: Sizing
  reviews: Review[]
  updatedAt: number
}

/** A background session this orchestrator launched; `task` is the one it holds, if any. */
export type Worker = { name: string; bgId: string; repo: string; role: string; model: string; effort: string; task: number | null }

/** What a session has consumed, read from its transcript; the cost is an estimate at API rates. */
export type WorkerUsage = {
  model: string
  /** Tokens the last request carried, against the model's window. */
  context: number
  window: number
  tokens: number
  output: number
  turns: number
  cost: number
  isPriced: boolean
  /** The task the session held when last read, and its role (`reviewer`, `orchestrator`, a cortex role). */
  task: number | null
  role: string
  at: number
}

export type FeedEntry = { at: number; direction: 'out' | 'in' | 'notice'; peer: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    orchestra: {
      self: string
      peers: Peer[]
      refreshedAt: number
      tasks: Task[]
      workers: Worker[]
      feed: FeedEntry[]
      selected: number
      usage: Record<string, WorkerUsage>
      showDone: boolean
    }
  }
}
