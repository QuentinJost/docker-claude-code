"""Lists the git repositories under a root, for the orchestra mod to route a request.

Usage: python3 repos.py <root>
Prints one JSON array of {"repo", "about"}: the path relative to the root, and a line saying
what the repo is, from its project-overview.md "Description:" or its README's first sentence.
Dependency and build folders are skipped.
"""

import json
import os
import re
import sys

SKIP = {"node_modules", "vendor", "var", ".git", "dist", "build", ".nuxt", ".output", "graphify-out", "db_prod"}
MAX_DEPTH = 3


def about(path):
    overview = os.path.join(path, "project-overview.md")
    if os.path.isfile(overview):
        with open(overview, encoding="utf-8", errors="replace") as text:
            for line in text:
                match = re.match(r"\*\*Description:\*\*\s*(.+)", line.strip())
                if match and not match.group(1).startswith("<!--"):
                    return match.group(1)[:200]
    for name in ("README.md", "readme.md", "README"):
        readme = os.path.join(path, name)
        if os.path.isfile(readme):
            with open(readme, encoding="utf-8", errors="replace") as text:
                title = ""
                for line in text:
                    line = line.strip()
                    if line.startswith("#") and not title:
                        title = line.lstrip("# ")
                    elif line and not line.startswith(("#", "[!", "![", "<", "```", "|", "---", "[![")):
                        return f"{title}: {line}"[:200] if title else line[:200]
                return title[:200]
    return ""


def walk(root):
    found = []
    for current, dirs, _files in os.walk(root):
        depth = current[len(root):].count(os.sep)
        if os.path.isdir(os.path.join(current, ".git")) and current != root:
            found.append({"repo": os.path.relpath(current, root), "about": about(current)})
        dirs[:] = [] if depth >= MAX_DEPTH else sorted(d for d in dirs if d not in SKIP and not d.startswith("."))
    return found


if __name__ == "__main__":
    print(json.dumps(walk(sys.argv[1].rstrip(os.sep))))
