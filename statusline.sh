#!/usr/bin/env bash
# Claude Code statusLine script
# Receives JSON from Claude Code on stdin

input=$(cat)

# Current working directory with ~ abbreviation
cwd=$(echo "$input" | jq -r '.cwd // .workspace.current_dir // empty')
if [ -n "$cwd" ]; then
  home="$HOME"
  if [ -n "$home" ] && [[ "$cwd" == "$home"* ]]; then
    cwd="~${cwd#$home}"
  fi
fi

# Git branch (skip optional locks to avoid blocking)
git_branch=""
if [ -n "$cwd" ]; then
  abs_cwd="${cwd/#\~/$HOME}"
  git_branch=$(git -C "$abs_cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)
fi

# Model display name
model=$(echo "$input" | jq -r '.model.display_name // empty')

# Context window usage: "ctx 3% (30.7k)"
ctx=$(echo "$input" | jq -r '
  .context_window as $c |
  if $c and $c.used_percentage != null then
    ($c.total_input_tokens // 0) as $t |
    "ctx " + ($c.used_percentage | tostring) + "%" +
    (if $t > 0 then " (" + (if $t >= 1000 then (($t / 1000 * 10 | floor) / 10 | tostring) + "k" else ($t | tostring) end) + ")" else "" end)
  else empty end')

# Session cost: "$0.48"
cost=$(echo "$input" | jq -r '
  if .cost.total_cost_usd != null then
    "$" + ((.cost.total_cost_usd * 100 | floor) / 100 | tostring)
  else empty end')

# Rate limits: "5h 3% · 7d 4%"
limits=$(echo "$input" | jq -r '
  [(.rate_limits.five_hour.used_percentage // empty | "5h \(.)%"),
   (.rate_limits.seven_day.used_percentage // empty | "7d \(.)%")] |
  join(" · ") | if . == "" then empty else . end')

# Colors (ANSI, reset after each segment)
C_RESET=$'\033[0m'
C_DIR=$'\033[1;34m'     # bold blue
C_GIT=$'\033[1;35m'     # bold magenta
C_MODEL=$'\033[1;36m'   # bold cyan
C_CTX=$'\033[33m'       # yellow
C_COST=$'\033[32m'      # green
C_LIMITS=$'\033[31m'    # red
C_SEP=$'\033[90m'       # dim grey

# Context colour shifts with usage: yellow < 70%, red >= 70%
ctx_pct=$(echo "$input" | jq -r '.context_window.used_percentage // 0')
if [ "${ctx_pct%.*}" -ge 70 ] 2>/dev/null; then C_CTX=$'\033[1;31m'; fi

# Assemble status line
parts=()
[ -n "$cwd" ]        && parts+=("${C_DIR}${cwd}${C_RESET}")
[ -n "$git_branch" ] && parts+=("${C_GIT} ${git_branch}${C_RESET}")
[ -n "$model" ]      && parts+=("${C_MODEL}${model}${C_RESET}")
[ -n "$ctx" ]        && parts+=("${C_CTX}${ctx}${C_RESET}")
[ -n "$cost" ]       && parts+=("${C_COST}${cost}${C_RESET}")
[ -n "$limits" ]     && parts+=("${C_LIMITS}${limits}${C_RESET}")

out=""
for p in "${parts[@]}"; do
  [ -n "$out" ] && out+="${C_SEP} | ${C_RESET}"
  out+="$p"
done
printf '%s' "$out"
