#!/usr/bin/env python3
"""Searches the public-apis catalogue (github.com/public-apis/public-apis, MIT).

The catalogue is a local clone, refreshed with a shallow pull once a day; offline,
the last copy serves. Only the category tables are read (API | Description |
Auth | HTTPS | CORS), not the sponsored sections.
"""

import argparse
import os
import re
import subprocess
import sys
import time

REPO = "https://github.com/public-apis/public-apis.git"
HOME = os.environ.get("PUBLIC_APIS_DIR") or os.path.expanduser("~/.cache/public-apis")
MAX_AGE_S = 24 * 3600
HEADER = re.compile(r"^\|?\s*API\s*\|\s*Description\s*\|\s*Auth\s*\|\s*HTTPS\s*\|\s*CORS", re.I)
ROW = re.compile(r"^\|\s*\[(?P<name>[^\]]+)\]\((?P<url>[^)]+)\)\s*\|(?P<rest>.*?)\|?\s*$")


def ensure_clone(force=False):
    """Clones the catalogue, or pulls it when the copy is a day old. Never fails while a copy exists."""
    readme = os.path.join(HOME, "README.md")
    stamp = os.path.join(HOME, ".git", "FETCH_HEAD")
    try:
        if not os.path.isdir(os.path.join(HOME, ".git")):
            os.makedirs(os.path.dirname(HOME), exist_ok=True)
            subprocess.run(["git", "clone", "-q", "--depth", "1", REPO, HOME], check=True, timeout=120)
        else:
            last = os.path.getmtime(stamp) if os.path.exists(stamp) else os.path.getmtime(readme)
            if force or time.time() - last > MAX_AGE_S:
                subprocess.run(["git", "-C", HOME, "pull", "-q", "--ff-only", "--depth", "1"], check=True, timeout=120)
    except (subprocess.SubprocessError, OSError) as err:
        if not os.path.exists(readme):
            sys.exit(f"public-apis: no local copy and the clone failed: {err}")
        print(f"(could not refresh the catalogue, using the local copy: {err})", file=sys.stderr)
    return readme


def parse(readme):
    """Yields one dict per API of the category tables."""
    category, in_table = None, False
    with open(readme, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line.startswith("### "):
                category, in_table = line[4:].strip(), False
            elif HEADER.match(line):
                in_table = True
            elif in_table and not line.strip():
                in_table = False
            elif in_table and (m := ROW.match(line)):
                cells = [c.strip() for c in m["rest"].split("|")]
                if len(cells) < 4:
                    continue
                auth, https, cors = cells[-3:]
                yield {
                    "category": category,
                    "name": m["name"].strip(),
                    "url": m["url"].strip(),
                    "description": " | ".join(cells[:-3]).strip(),
                    "auth": auth.strip("`") or "No",
                    "https": https,
                    "cors": cors,
                }


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("words", nargs="*", help="words that must all appear (name, description or category)")
    p.add_argument("-c", "--category", help="only this category (substring, case-insensitive)")
    p.add_argument("--categories", action="store_true", help="list the categories with their API count")
    p.add_argument("--no-auth", action="store_true", help="only APIs that need no key")
    p.add_argument("--https", action="store_true", help="only APIs served over HTTPS")
    p.add_argument("--cors", action="store_true", help="only APIs that allow CORS (callable from a browser)")
    p.add_argument("-n", "--limit", type=int, default=40, help="rows at most (default 40, 0 = all)")
    p.add_argument("--refresh", action="store_true", help="pull the catalogue now")
    args = p.parse_args()

    apis = list(parse(ensure_clone(args.refresh)))
    if args.categories:
        counts = {}
        for a in apis:
            counts[a["category"]] = counts.get(a["category"], 0) + 1
        for name, n in counts.items():
            print(f"{name}\t{n}")
        return

    words = [w.lower() for w in args.words]
    rows = [
        a for a in apis
        if (not args.category or args.category.lower() in a["category"].lower())
        and all(w in f'{a["name"]} {a["description"]} {a["category"]}'.lower() for w in words)
        and (not args.no_auth or a["auth"].lower() == "no")
        and (not args.https or a["https"].lower() == "yes")
        and (not args.cors or a["cors"].lower() == "yes")
    ]
    shown = rows if args.limit == 0 else rows[: args.limit]
    for a in shown:
        print(f'{a["name"]} — {a["description"]} [{a["category"]}; auth: {a["auth"]}, https: {a["https"]}, cors: {a["cors"]}] {a["url"]}')
    if len(shown) < len(rows):
        print(f"… {len(rows) - len(shown)} more (-n 0 for all)")
    if not rows:
        print("No match. Try fewer words, or --categories.")


if __name__ == "__main__":
    main()
