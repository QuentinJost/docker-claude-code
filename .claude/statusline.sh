#!/usr/bin/env bash
# Claude Code statusLine script
# Receives JSON from Claude Code on stdin

input=$(cat)

# ── Colors ───────────────────────────────────────────────
RST=$'\e[0m'
C_DIR=$'\e[1;38;5;81m'      # bold light blue
C_GIT=$'\e[38;5;141m'       # purple
C_MODEL=$'\e[38;5;215m'     # orange
C_COST=$'\e[38;5;114m'      # green
C_LIM=$'\e[38;5;245m'       # gray
C_OK=$'\e[38;5;114m'        # green  (ctx < 50%)
C_WARN=$'\e[38;5;221m'      # yellow (ctx < 80%)
C_HOT=$'\e[38;5;203m'       # red    (ctx >= 80%)
DIMC=$'\e[38;5;240m'
SEP="${DIMC}  ${RST}"

# ── Extract fields ───────────────────────────────────────
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

model=$(echo "$input" | jq -r '.model.display_name // empty')
fast=$(echo "$input" | jq -r '.fast_mode // false')

pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
tokens=$(echo "$input" | jq -r '
  (.context_window.total_input_tokens // 0) as $t |
  if $t >= 1000 then (($t / 1000 * 10 | floor) / 10 | tostring) + "k"
  elif $t > 0 then ($t | tostring)
  else empty end')

cost_raw=$(echo "$input" | jq -r '.cost.total_cost_usd // empty')
cost=""
[ -n "$cost_raw" ] && cost=$(printf '$%.2f' "$cost_raw")

lim5=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
lim7=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')

# ── Build segments ───────────────────────────────────────
parts=()

[ -n "$cwd" ]        && parts+=("${C_DIR}${cwd}${RST}")
[ -n "$git_branch" ] && parts+=("${C_GIT}⎇ ${git_branch}${RST}")

if [ -n "$model" ]; then
  [ "$fast" = "true" ] && model="${model} ⚡"
  parts+=("${C_MODEL}✻ ${model}${RST}")
fi

# Context: colored 5-segment bar + percentage + tokens
if [ -n "$pct" ]; then
  if   [ "$pct" -lt 50 ]; then c="$C_OK"
  elif [ "$pct" -lt 80 ]; then c="$C_WARN"
  else                         c="$C_HOT"; fi
  filled=$(( pct / 20 )); [ "$filled" -gt 5 ] && filled=5
  bar=""
  for ((i = 0; i < 5; i++)); do
    if [ "$i" -lt "$filled" ]; then bar+="▰"; else bar+="▱"; fi
  done
  seg="${c}${bar} ${pct}%${RST}"
  [ -n "$tokens" ] && seg+=" ${DIMC}(${tokens})${RST}"
  parts+=("$seg")
fi

[ -n "$cost" ] && parts+=("${C_COST}${cost}${RST}")

if [ -n "$lim5" ] || [ -n "$lim7" ]; then
  lim=""
  [ -n "$lim5" ] && lim+="5h ${lim5}%"
  [ -n "$lim5" ] && [ -n "$lim7" ] && lim+=" · "
  [ -n "$lim7" ] && lim+="7d ${lim7}%"
  parts+=("${C_LIM}${lim}${RST}")
fi

# ── Assemble ─────────────────────────────────────────────
out=""
for p in "${parts[@]}"; do
  [ -n "$out" ] && out+="$SEP"
  out+="$p"
done
printf '%s' "$out"
