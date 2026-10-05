"""Lists the git repositories under a root, for the orchestra mod to route a request.

Usage: python3 repos.py <root>
Prints one JSON array of {"repo", "about"}: the path relative to the root, and a line saying
what the repo is, from its project-overview.md "Description:" or its README's first sentence.
Dependency and build folders are skipped, and under a workspace the folders its "ignore" names.

Usage: python3 repos.py --workspaces <root>
Prints one JSON array of the workspaces: each orchestra.json found, as its object plus "path",
the folder relative to the root. An unreadable file is left out.
"""

import json
import os
import re
import sys

SKIP = {"node_modules", "vendor", "var", ".git", "dist", "build", ".nuxt", ".output"}
WORKSPACE_FILE = "orchestra.json"
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


def workspace(path):
    """The orchestra.json of a folder, or None when it has none or it is not a JSON object."""
    try:
        with open(os.path.join(path, WORKSPACE_FILE), encoding="utf-8") as text:
            config = json.load(text)
        return config if isinstance(config, dict) else None
    except (OSError, ValueError):
        return None


def walk(root):
    found, workspaces = [], []
    skip = {root: set()}
    for current, dirs, _files in os.walk(root):
        depth = current[len(root):].count(os.sep)
        ignored = set(skip.pop(current, set()))
        config = workspace(current) if current != root else None
        if config is not None:
            workspaces.append({**config, "path": os.path.relpath(current, root)})
            ignored |= {str(name) for name in config.get("ignore", []) if isinstance(name, str)}
        if os.path.isdir(os.path.join(current, ".git")) and current != root:
            found.append({"repo": os.path.relpath(current, root), "about": about(current)})
        dirs[:] = [] if depth >= MAX_DEPTH else sorted(d for d in dirs if d not in SKIP and d not in ignored and not d.startswith("."))
        for d in dirs:
            skip[os.path.join(current, d)] = ignored
    return found, workspaces


if __name__ == "__main__":
    if sys.argv[1] == "--workspaces":
        print(json.dumps(walk(sys.argv[2].rstrip(os.sep))[1]))
    else:
        print(json.dumps(walk(sys.argv[1].rstrip(os.sep))[0]))
