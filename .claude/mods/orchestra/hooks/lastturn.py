"""Reads the last turn of a Claude Code transcript, for the orchestra mod.

Usage: python3 lastturn.py <transcript.jsonl>
Prints one JSON object: the text the session wrote in its last turn (the one that began with
its latest prompt or message), when that text was written (epoch ms), and whether the turn has
ended. A session that wrote its report as text instead of sending it leaves it there.
"""

import json
import sys
from datetime import datetime

# What the harness writes once a turn is over.
TURN_END = {"turn_duration", "stop_hook_summary"}


def is_prompt(entry):
    """A user line that starts a turn: a prompt or a message, not a tool result.

    Meta lines (context the harness adds) and compaction summaries come in the middle of a
    turn: taking them for its start would cut the report written before them.
    """
    if entry.get("type") != "user" or entry.get("isSidechain"):
        return False
    if entry.get("isMeta") or entry.get("isCompactSummary"):
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return True
    return isinstance(content, list) and not any(isinstance(p, dict) and p.get("type") == "tool_result" for p in content)


def epoch_ms(stamp):
    """An ISO timestamp of the transcript in epoch milliseconds; 0 when unreadable."""
    try:
        return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000)
    except (AttributeError, ValueError):
        return 0


def last_turn(path):
    """The text, time and end of the last turn of the transcript at `path` (see the module doc)."""
    entries = []
    with open(path, encoding="utf-8", errors="replace") as lines:
        for line in lines:
            try:
                entries.append(json.loads(line))
            except ValueError:
                continue
    start = max((i for i, e in enumerate(entries) if is_prompt(e)), default=-1)
    texts, at, last_assistant, ended = [], 0, -1, False
    for i, entry in enumerate(entries[start + 1 :], start + 1):
        if entry.get("isSidechain"):
            continue
        if entry.get("type") == "assistant":
            last_assistant = i
            ended = False
            for part in (entry.get("message") or {}).get("content") or []:
                if isinstance(part, dict) and part.get("type") == "text" and part.get("text"):
                    texts.append(part["text"])
                    at = epoch_ms(entry.get("timestamp"))
        elif entry.get("type") == "system" and entry.get("subtype") in TURN_END and last_assistant >= 0:
            ended = True
    return {"text": "\n\n".join(texts), "at": at, "ended": ended}


if __name__ == "__main__":
    print(json.dumps(last_turn(sys.argv[1])))
