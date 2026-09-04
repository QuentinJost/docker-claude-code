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

# Assemble status line
parts=()
[ -n "$cwd" ]        && parts+=("$cwd")
[ -n "$git_branch" ] && parts+=("$git_branch")
[ -n "$model" ]      && parts+=("$model")
[ -n "$ctx" ]        && parts+=("$ctx")
[ -n "$cost" ]       && parts+=("$cost")
[ -n "$limits" ]     && parts+=("$limits")

out=""
for p in "${parts[@]}"; do
  [ -n "$out" ] && out+=" | "
  out+="$p"
done
printf '%s' "$out"