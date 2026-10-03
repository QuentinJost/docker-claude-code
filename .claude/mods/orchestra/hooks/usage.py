"""Sums the token usage of Claude Code transcripts, for the orchestra mod.

Usage: python3 usage.py <transcript.jsonl>...
Prints one JSON object keyed by path: the last model, the context the last request
carried (input + cache read + cache write), and the totals of every assistant message,
each message counted once, from its last line.
Only the main thread is counted: subagents keep transcripts of their own.
"""

import json
import sys


def summarise(path):
    # A message spread over several lines repeats its usage, updated as it streams: the
    # last line of each message holds its final counts.
    last = {}
    with open(path, encoding="utf-8", errors="replace") as lines:
        for line in lines:
            if '"usage"' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            message = entry.get("message") or {}
            usage = message.get("usage")
            if entry.get("type") != "assistant" or not isinstance(usage, dict) or entry.get("isSidechain"):
                continue
            key = message.get("id") or entry.get("uuid")
            last.pop(key, None)
            last[key] = (message.get("model") or "", usage)

    totals = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite5m": 0, "cacheWrite1h": 0}
    model, context = "", 0
    for model_id, usage in last.values():
        written = usage.get("cache_creation_input_tokens") or 0
        hour = (usage.get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0
        totals["input"] += usage.get("input_tokens") or 0
        totals["output"] += usage.get("output_tokens") or 0
        totals["cacheRead"] += usage.get("cache_read_input_tokens") or 0
        totals["cacheWrite1h"] += hour
        totals["cacheWrite5m"] += max(0, written - hour)
        model = model_id or model
        context = (usage.get("input_tokens") or 0) + (usage.get("cache_read_input_tokens") or 0) + written
    return {"model": model, "context": context, "turns": len(last), **totals}


result = {}
for path in sys.argv[1:]:
    try:
        result[path] = summarise(path)
    except OSError:
        pass
print(json.dumps(result))
