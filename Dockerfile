FROM node:slim
WORKDIR /app

# ---------------------------------------------------------------------------
# System packages
#   - jq    : used by the statusline script
#   - pipx  : isolated install for graphify (avoids PEP 668 + runtime-python issues)
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    python3 \
    php \
    golang-go \
    git \
    ca-certificates curl gnupg lsb-release \
    jq pipx \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Docker CE (suite + arch derived from the actual base image, not hardcoded)
# ---------------------------------------------------------------------------
RUN curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
RUN echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
      > /etc/apt/sources.list.d/docker.list
RUN apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# rtk (Rust Token Killer) — installed system-wide so www-data can use it
# ---------------------------------------------------------------------------
RUN curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh \
 && cp /root/.local/bin/rtk /usr/local/bin/rtk \
 && chmod 755 /usr/local/bin/rtk \
 && rtk --version

# ---------------------------------------------------------------------------
# Claude Code — bootstrap via npm, then migrate to the native (sudo-free,
# self-updating) installer as www-data further down. No node_modules chowns.
# ccusage is installed globally so the statusline can read total usage offline.
# ---------------------------------------------------------------------------
RUN npm install -g @anthropic-ai/claude-code ccusage

# ---------------------------------------------------------------------------
# graphify — turns a folder of code/docs into a queryable knowledge graph,
# exposed to Claude Code as a skill. PyPI package is "graphifyy" (double-y);
# the CLI is "graphify". pipx drops launchers in /usr/local/bin (on PATH).
# Add extras as needed, e.g. "graphifyy[mcp,pdf,office]". Avoid [all] unless
# you also add build-essential + python3-dev (tree-sitter-dm compiles on Linux).
# ---------------------------------------------------------------------------
ENV PIPX_HOME=/opt/pipx \
    PIPX_BIN_DIR=/usr/local/bin
RUN pipx install "graphifyy[mcp]" \
 && graphify --version

# ---------------------------------------------------------------------------
# Align www-data to uid/gid 1000 (-o because uid 1000 is the existing node user)
# and give it docker access.
# ---------------------------------------------------------------------------
RUN groupmod -o -g 1000 www-data \
 && usermod -o -u 1000 www-data \
 && usermod -aG docker www-data

# ---------------------------------------------------------------------------
# Config into www-data's home (HOME=/var/www, set below).
# ---------------------------------------------------------------------------
COPY --chown=www-data:www-data .config /var/www/.config
COPY --chown=www-data:www-data .claude /var/www/.claude

# Register the statusline in settings.json (create/merge, don't clobber).
RUN f=/var/www/.claude/settings.json \
 && [ -f "$f" ] || echo '{}' > "$f" \
 && jq '.statusLine = {type:"command", command:"/var/www/.claude/statusline.sh", padding:0}' "$f" > "$f.tmp" \
 && mv "$f.tmp" "$f"

# Writable home tree for claude / rtk / npm / pipx state, cache, tokens.
RUN mkdir -p /var/www/.cache/claude /var/www/.npm /var/www/.local \
 && chown -R www-data:www-data /var/www

# ---------------------------------------------------------------------------
# Runtime environment.
#   HOME : THE key fix — without it, tools look in / (root-owned).
#   PATH : native Claude Code lives in ~/.local/bin; put it first so the
#          self-updating copy shadows the npm bootstrap.
# ---------------------------------------------------------------------------
ENV HOME=/var/www \
    PATH="/var/www/.local/bin:${PATH}"

USER www-data

# Migrate to the native, sudo-free, self-updating Claude Code build.
# (On older builds this command was `claude migrate-installer`.)
RUN claude install

# Register graphify as a Claude Code skill in www-data's home
# (-> /var/www/.claude/skills/graphify).
RUN graphify install --platform claude

CMD ["sleep", "infinity"]