# Orchestra

The `orchestra` mod (`.claude/mods/orchestra`) turns one Claude Code session into an
orchestrator: it queues tasks, runs each one in a background session of its own, has the work
reviewed by another background session, and loops until the review approves. It runs on the
built-in transport (`claude --bg`, `SendMessage`, `ListAgents`): no daemon.

## Commands

| Command | What it does |
|---|---|
| `/orch` | Opens the pane |
| `/orch task <repo> <text> [@role] [model:… effort:…] [after:#n] [from:<branch>] [;; …]` | Queues a task as typed |
| `/orch prompt [<repo>] <request> [@role] [;; …]` | Fable (the Prompt Manager) writes the brief first; without a repo it picks the repo, and it may split a request by domain into tasks per role |
| `/orch answer <answers>` | Answers the questions Fable asked about the last unclear request |
| `/orch retry <id> [note]` | Sends a blocked or escalated task back, with the person's answer |
| `/orch followup <id> [note]` | Queues the reviewer's remaining remarks on an approved task, from its branch |
| `/orch pr <id> [confirm]` | Drafts the pull request of an approved task; `confirm` pushes and opens it |
| `/orch drop <id>` · `/orch stop-idle` | Drops a task · stops the idle sessions |
| `/orch config [<repo>]` | The workspace files found, their faults, and what applies to a repo |
| `/orch <session> <message>` | Sends a message to a session |

## The pipeline

1. **Queue.** Fable sizes the sessions (model and effort, from the task and the past tasks kept in
   `~/.claude/orchestra/history.json`). Development never runs below Opus, no session below Sonnet.
2. **Dispatch.** One task at a time in a repo's main checkout; more in local clones
   (`/app/.orchestra/clones/`) when the workspace allows them (`parallel`). A folder that is not a
   git repo gets `git init` and an empty first commit, local only; a folder that does not exist,
   or that sits inside another repo, blocks the task.
3. **Work.** The worker gets its brief and reports `STATUS / SUMMARY / BRANCH / CHANGES / TESTS /
   NEEDS` with `SendMessage`. The report format and the orchestrator's name are also in its agent
   definition, which a compaction never summarises. An idle worker past half its context window is
   not given another task: a fresh session is.

   A session that goes idle without reporting gets its brief again once, then the task goes to
   the person. That watch rests on an idle subscription, which auto mode may hold (the feed then
   says "idle watch not set"). So every refresh (30 s) also reads the last turn of each working
   worker and reviewer from its transcript: a report written there but never sent (a turn ending
   with "SendMessage to …: VERDICT: …" as text) is handled as if it had come in, and a session
   gone with no report blocks its task for the person.
4. **Checks.** The commands the workspace names (`checks`) run in the repo before any review; a
   failure goes back to the worker with its output (twice at most), and spares a review session.
5. **Review.** A fresh reviewer session per round returns `VERDICT / FINDINGS`. Three rejected
   rounds hand the task to the person.
6. **Done.** The approved task's digest goes to the orchestrator's model, which writes it up for
   the person. Nothing is ever pushed without `/orch pr <id> confirm`.

The queue is kept in `~/.claude/orchestra/queues/<session>.json`: the first `/orch` of a new
session takes over the open queue of an orchestrator session that is gone, tells the live workers
whom to report to, and blocks the tasks whose session is gone (`/orch retry` hands them to a fresh
one).

## Workspaces: where the rules live

The mod knows no project. A folder under `/app` holding an `orchestra.json` is a **workspace**:
its rules apply to every repo under it. A workspace is a folder of repos, never a repo: the apps
stay agnostic of the orchestra. A file may sit in a versioned repo and name the folder it rules
with `"root"`.

| Workspace | File | Rules |
|---|---|---|
| `/app` (every repo) | `claude-code/orchestra/orchestra.json` (`"root": "../.."`) | Cortex role cards, the generic Cortex review rules, capabilities and workflows, the personal engineering practices (`cortex/practices/engineering.md`), The Boys personality, the rules of a new app (Docker Compose) |
| `/app/bluspark-stack` | `bluspark-stack/orchestra.json` | Cortex cards plus the team's overlays and conventions from `agents/` (instead of the personal practices), the Bluspark review rules (Cortex base + `agents` overlay), Jira when the request names a key, the `stack` target |

An inner workspace refines the outer one key by key. So a Bluspark task gets Cortex and
`agents`; a task anywhere else gets Cortex and the personal layer, nothing of Bluspark.

Main keys of `orchestra.json`:

- `roles`: `from` (Cortex's `agents/roles`), `overlays` (a team's `agents/roles`), `byRepo`,
  `default`, `light`, `worker` and `reviewer` lines. Each worker's agent is its role card, whole,
  then its overlay.
- `review.docs`: the reviewer's rules, base first, inlined in its agent.
- `practices.docs`: conventions every worker follows and the reviewer holds the work to, inlined;
  `"docs": []` in an inner workspace opts out of the outer one's.
- `capabilities.from`: capability cards; a worker is pointed at those of its repo's stack
  (`composer.json`, `package.json`, compose files…).
- `workflows.from`: workflows Fable may pick for a task; the worker follows its part.
- `personality`: a Cortex theme; workers play their role's character, the reviewer the character
  of `reviewerAs`. Briefs and Fable's prompts stay neutral.
- `tickets`: a tracker's key pattern and branch rule, applied only when the request names a key.
- `checks`, `checkTimeout` (600 s at most), `integration`, `parallel`, `newApp`, `targets`
  (non-git targets such as the running stack), `overview`, `ignore`, `route`.

## Cortex

The image installs Cortex (`CORTEX_VERSION`, store in `/opt/cortex/versions/<version>`). The role
cards, review rules, capabilities and workflows the orchestra uses are read there; the personality
theme is kept in this repo (`cortex/personalities/the-boys`).
