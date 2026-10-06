export type Peer = { name: string; ref: string; kind: string; status: string; started: string }

export type TaskState = 'queued' | 'working' | 'checking' | 'reviewing' | 'approved' | 'blocked' | 'escalated' | 'dropped'

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
  /** Tasks that must be approved before this one starts. */
  after?: number[]
  /** The start branch the person asked with `from:`, over the repo's default. */
  from?: string
  /** The task branch, from the worker's BRANCH line. */
  branch?: string
  /** What the brief says about the tasks this one waited for. */
  prior?: string
  /** The pull request drafted by `/orch pr`, sent on `/orch pr <id> confirm`. */
  prDraft?: { title: string; body: string }
  /** The pull request's URL once opened. */
  pr?: string
  /** Where the task works when not in the repo's main checkout: a local clone, for parallel tasks. */
  dir?: string
  /** The orchestrator's own checks that passed on the reported code, for the reviewer. */
  checks?: string
  /** How many times the orchestrator's own checks sent the task back before a review. */
  checkFixes?: number
  /** The orchestrator made the task's folder a repo (git init or a first commit): a new app, with its rules. */
  isNewApp?: boolean
  /** What the orchestrator's own model calls for this task cost (sizing, brief, routing), in $. */
  callCost?: number
}

/** One finished task, kept to size the next ones better. */
export type HistoryEntry = {
  at: number
  repo: string
  role: string
  title: string
  work: Setting
  review: Setting
  /** approved, escalated (rejected at every round) or dropped. */
  outcome: 'approved' | 'escalated' | 'dropped'
  rounds: number
  checkFixes: number
  cost: number
}

/** A background session this orchestrator launched; `task` is the one it holds, if any. */
export type Worker = {
  name: string
  bgId: string
  repo: string
  role: string
  model: string
  effort: string
  task: number | null
  /** The last brief sent to it, sent again once if it goes idle without reporting. */
  brief?: string
  /** How many times that brief went again. */
  nudges?: number
}

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
  /** The task the session held when last read, and its role (`reviewer`, `orchestrator`, a workspace role). */
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
      /** A prompt came in through Remote Control in this session: it is connected. */
      remoteSeen: boolean
      /** The Remote Control reminder was given in this session. */
      reminded: boolean
      /** A request the model answered with questions, kept for /orch answer. */
      pending: { input: string; questions: string[] } | null
    }
  }
}
