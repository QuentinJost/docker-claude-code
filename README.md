# Claude Code (Dockerized) with rtk

A containerized [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)
environment. The image bundles common language runtimes (Python, PHP, Go, Node),
a Docker CLI wired to the host daemon, and
[rtk](https://github.com/rtk-ai/rtk) — the "Rust Token Killer" CLI proxy that
compresses command output before it reaches the model, cutting token usage on a
typical session by roughly 80%.

## What's inside

- **Claude Code** — installed globally via `@anthropic-ai/claude-code`
- **rtk** — single Rust binary, installed system-wide to `/usr/local/bin`
- **Runtimes** — Python 3, PHP, Go, Node (from the `node:slim` base image)
- **Docker CLI** — talks to the host daemon via the mounted socket
- Runs as the non-root `www-data` user (UID/GID remapped to 1000)

Mount layout inside the container:

| Container path | Host source | Purpose |
|---|---|---|
| `/app` | `${LOCAL_PATH}` | Your project — Claude Code's working directory |
| `/claude-code` | this repo | The container's own config, editable from inside |
| `/var/www/.claude` | `./.claude` | Claude Code settings, credentials, sessions (persists) |
| `/var/www/.claude.json` | `./.claude.json` | Claude Code global state file (persists) |
| `/var/www/.config` | `./.config` | Misc tool config (persists) |
| `/var/run/docker.sock` | host socket | Docker-in-Docker access |

## Prerequisites

- Docker and Docker Compose on the host
- An Anthropic account (Claude Pro/Max subscription or Console API access) to
  log in on first run

## Initial setup

Run these once after cloning.

### 1. Create your `.env`

```bash
cp .env.dist .env
```

Then edit it:

```bash
LOCAL_PATH=/absolute/path/to/your/project   # mounted at /app in the container
DOCKER_GID=999                              # match your host's docker group GID
DOCKER_NETWORK=claude-code                  # external network to attach to
```

To find your host's docker group GID:

```bash
getent group docker | cut -d: -f3
```

### 2. Create the state file

`.claude.json` is bind-mounted as a **file**. It must exist before the first
`docker compose up`, otherwise Docker creates it as an empty *directory* and
Claude Code breaks:

```bash
cp .claude.json.dist .claude.json
```

### 3. Create the Docker network

The compose network is declared `external`, so create it once (use the name
from your `.env`):

```bash
docker network create claude-code
```

If your project's own compose stack already provides a network,
set `DOCKER_NETWORK` to that name instead and skip this step —
the container can then reach your project's services by hostname.

### 4. Build and start

```bash
docker compose build
docker compose up -d
```

The container runs `sleep infinity`, so it stays alive in the background and
you exec into it to work.

### 5. Log in to Claude Code

```bash
docker compose exec claude-code bash
# inside the container:
claude          # first run walks you through authentication
```

Follow the login flow (browser OAuth for Pro/Max, or paste an API key).
Credentials land in the mounted `.claude/` directory, so you only do this once
— they survive rebuilds and restarts.

### 6. Enable rtk

rtk is already installed in the image; wire it into Claude Code's hooks so
Bash commands like `git status` are transparently rewritten to
`rtk git status`:

```bash
# inside the container:
rtk --version       # confirm the binary is on PATH
rtk init -g         # installs the global hook into .claude/settings.json
```

Then restart Claude Code (exit and relaunch `claude`) for the hook to take
effect. Because `.claude/` is a mounted volume, this also only needs to be
done once.

Quick check that it's working, from inside the container:

```bash
rtk gain            # shows token-savings stats
```

> **Note:** the rtk hook only fires on Bash tool calls. Claude Code's built-in
> `Read`, `Grep`, and `Glob` tools don't pass through it. To get rtk's compact
> output in those workflows, prefer shell commands (`cat`, `rg`, `find`) or
> call `rtk read` / `rtk grep` / `rtk find` directly.

## Daily usage

```bash
docker compose up -d                      # start in background
docker compose exec claude-code bash      # shell into the container
claude                                    # launch Claude Code (project is at /app)
docker compose logs -f                    # follow logs
docker compose down                       # stop and remove
docker compose build --no-cache           # rebuild from scratch
```

## Add a shell alias (optional)

To launch Claude Code from anywhere on the host without typing the full
`docker compose exec` incantation, add an alias to your `~/.bashrc` (or
`~/.zshrc`):

```bash
# adjust the path to wherever you cloned this repo
alias claude='docker compose -f ~/dev/claude-code/compose.yaml exec claude-code claude'
alias claude-sh='docker compose -f ~/dev/claude-code/compose.yaml exec claude-code bash'
```

Reload your shell config:

```bash
source ~/.bashrc
```

Then from any host terminal:

```bash
claude          # drops you straight into Claude Code (working dir: /app)
claude-sh       # plain shell inside the container
```

The container must already be running (`docker compose up -d`); `exec` only
attaches to it. If you want the alias to start it on demand, use:

```bash
alias claude='docker compose -f ~/dev/claude-code/compose.yaml up -d && docker compose -f ~/dev/claude-code/compose.yaml exec claude-code claude'
```

## Notes & gotchas

- **Docker socket** — `/var/run/docker.sock` is mounted so the container can
  run Docker commands against the host daemon. The `group_add` entry must match
  your host's docker GID (`DOCKER_GID`) or socket access will be denied.
- **Volume shadowing** — the image `COPY`s `.config` and `.claude` at build
  time, but the compose mounts override them at runtime. Whatever lives in
  your host `.config` / `.claude` is what Claude Code actually uses; the copied
  versions only matter if you run the image without the compose mounts.
- **Git ignores the state** — `.env`, `.claude.json`, and the contents of
  `.claude/` / `.config/` are gitignored (only `.gitkeep` is tracked). Each
  clone starts from the `.dist` templates; credentials and settings never end
  up in the repo.
- **rtk binary location** — installed to `/usr/local/bin/rtk`
  (world-executable) so the non-root `www-data` user can run it. The
  installer's default `~/.local/bin` location isn't reachable by that user.
- **UID/GID 1000** — `www-data` is remapped to 1000:1000 so files created in
  the mounted project keep sane ownership on a typical Linux host. If your
  host user isn't 1000, adjust the `usermod`/`groupmod` lines in the
  Dockerfile.

## References

- Claude Code docs: https://docs.claude.com/en/docs/claude-code/overview
- rtk: https://github.com/rtk-ai/rtk
