"""Lists the git repositories under a root, for the orchestra mod to route a request.

Usage: python3 repos.py <root>
Prints one JSON array of {"repo", "about"}: the path relative to the root, and a line saying
what the repo is, from its project-overview.md "Description:" or its README's first sentence.
Dependency and build folders are skipped, and under a workspace the folders its "ignore" names.

Usage: python3 repos.py --workspaces <root>
Prints one JSON array of the workspaces: each orchestra.json found (the root's own included, which
rules every repo under the root: path ""), as its object plus "path", the folder it rules relative to the root (its own folder, or the one its "root" key names, e.g.
".." for a file kept in a versioned subfolder) and "file", where it was read. A file that is not
a JSON object, or that would rule a git repo (apps stay agnostic of the orchestra: a workspace is
a folder of repos), comes as {"path", "file", "error"}, so the orchestra can say so.

A workspace's "roles": {"from": ...} names a folder of role cards, laid out as cortex's
agents/roles/<folder>/<role>.md (a path, or a list whose first existing one wins; $VARS are
expanded): every card becomes a role of "roles.list", and its title and text go in "roles.cards". "from": "" says the workspace has no cards of its own; "roles": {"overlays": <folder>} adds each
card's workspace overlay, same layout, with its semantic (additive or replacement).

"review": {"docs": [paths]} are read into "review.texts" (the reviewer's rules, base first), and
"practices": {"docs": [paths]} into "practices.texts" (conventions every worker and reviewer holds);
"capabilities": {"from": ...} and "workflows": {"from": [...]} are indexed by name (path under
the folder, without .md) with their title and files, a later folder's overlay kept after its base.

A workspace's "personality": {"from": <theme folder>} names a cortex personality theme
(theme.md, characters.md and one card per character): theme.md goes in "personality.theme", and
each row of characters.md's table (`role` | Character | @alias | [card](File.md) | …) in
"personality.characters", by role, with the character's card. What cannot be read comes in
"problems", for the orchestra to say.
"""

import json
import os
import re
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


CARD_MAX = 16000


def read_cards(source):
    """The role cards under the first existing folder of source: (folder, {role: folder name}, {role: card}) or None."""
    candidates = source if isinstance(source, list) else [source]
    for candidate in candidates:
        if not isinstance(candidate, str):
            continue
        folder = os.path.expandvars(candidate)
        if "$" in folder or not os.path.isdir(folder):
            continue
        listed, cards = {}, {}
        for group in sorted(os.listdir(folder)):
            path = os.path.join(folder, group)
            if not os.path.isdir(path):
                continue
            for name in sorted(os.listdir(path)):
                if not name.endswith(".md") or name.lower() == "readme.md":
                    continue
                role = name[:-3]
                try:
                    with open(os.path.join(path, name), encoding="utf-8", errors="replace") as text:
                        body = text.read()
                except OSError:
                    continue
                title = next((line[2:].strip() for line in body.splitlines() if line.startswith("# ")), role)
                listed[role] = group
                # The whole card: its SYSTEM PROMPT block alone leaves out the standards that follow it.
                cards[role] = {"title": title, "prompt": body.strip()[:CARD_MAX], "file": os.path.join(path, name)}
        return folder, listed, cards
    return None


def with_cards(entry):
    """The workspace entry with its roles.from read into roles.list and roles.cards."""
    roles = entry.get("roles")
    if not isinstance(roles, dict) or "from" not in roles:
        return entry
    source = roles["from"]
    if source in ("", None, []):
        return {**entry, "roles": {**roles, "cards": {}}}
    read = read_cards(source)
    if read is None:
        shown = source if isinstance(source, str) else ", ".join(map(str, source))
        return {**entry, "problems": [f"roles.from: no folder of role cards at {shown}"]}
    folder, listed, cards = read
    problems = []
    overlays = roles.get("overlays")
    if isinstance(overlays, str) and overlays:
        if os.path.isdir(os.path.expandvars(overlays)):
            for role, group in listed.items():
                text = read_text(os.path.join(os.path.expandvars(overlays), group, f"{role}.md"))
                if text is not None:
                    cards[role] = {**cards[role], "overlay": text[:CARD_MAX], "semantic": semantic(text)}
        else:
            problems.append(f"roles.overlays: no folder at {overlays}")
    out = {**entry, "roles": {**roles, "from": folder, "list": {**listed, **(roles.get("list") or {})}, "cards": cards}}
    return {**out, "problems": [*entry.get("problems", []), *problems]} if problems else out


def read_text(path):
    """A text file's content, or None when it cannot be read."""
    try:
        with open(path, encoding="utf-8", errors="replace") as text:
            return text.read().strip()
    except OSError:
        return None


def semantic(text):
    """What an overlay does to its base, from its OVERLAY header: additive or replacement."""
    found = re.search(r"Semantic:\s*(\w+)", text[:600])
    return found.group(1).lower() if found else "additive"


def title_of(text, fallback):
    return next((line[2:].strip() for line in text.splitlines() if line.startswith("# ")), fallback)


def with_docs(entry):
    """The workspace entry with review.docs, capabilities.from and workflows.from read in."""
    problems = list(entry.get("problems", []))
    practices = entry.get("practices")
    if isinstance(practices, dict) and isinstance(practices.get("docs"), list):
        texts = []
        for path in practices["docs"]:
            text = read_text(os.path.expandvars(str(path)))
            if text is None:
                problems.append(f"practices.docs: cannot read {path}")
            else:
                texts.append({"file": str(path), "text": text[:2 * CARD_MAX], "semantic": "base"})
        entry = {**entry, "practices": {**practices, "texts": texts}}
    review = entry.get("review")
    if isinstance(review, dict) and isinstance(review.get("docs"), list):
        texts = []
        for path in review["docs"]:
            text = read_text(os.path.expandvars(str(path)))
            if text is None:
                problems.append(f"review.docs: cannot read {path}")
            else:
                texts.append({"file": str(path), "text": text[:2 * CARD_MAX], "semantic": semantic(text) if text.startswith("<!-- OVERLAY") else "base"})
        entry = {**entry, "review": {**review, "texts": texts}}
    # Capability cards and workflows: an index of the files (not their text), later folders winning.
    for key, problem in (("capabilities", "capabilities.from"), ("workflows", "workflows.from")):
        section = entry.get(key)
        if not isinstance(section, dict) or "from" not in section:
            continue
        sources = section["from"] if isinstance(section["from"], list) else [section["from"]]
        index = {}
        for source in sources:
            folder = os.path.expandvars(str(source))
            if not os.path.isdir(folder):
                problems.append(f"{problem}: no folder at {source}")
                continue
            for top, _dirs, names in os.walk(folder):
                for name in sorted(names):
                    if not name.endswith(".md") or name.lower() == "readme.md":
                        continue
                    path = os.path.join(top, name)
                    item = os.path.relpath(path, folder)[: -len(".md")]
                    text = read_text(path) or ""
                    known = index.get(item)
                    # A workflow overlay of a later folder keeps the base it extends.
                    files = [*(known["files"] if known else []), path] if text.startswith("<!-- OVERLAY") else [path]
                    index[item] = {"title": title_of(text, item), "files": files}
        entry = {**entry, key: {**section, "index": index}}
    return {**entry, "problems": problems} if problems else entry


CHARACTER_ROW = re.compile(r"^\|\s*`([a-z0-9-]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*\[[^\]]*\]\(([^)]+)\)")


def read_theme(folder):
    """A personality theme folder: (theme text, {role: character}), or the reason it cannot be read."""
    folder = os.path.expandvars(folder)
    try:
        with open(os.path.join(folder, "theme.md"), encoding="utf-8", errors="replace") as text:
            theme = text.read().strip()
        with open(os.path.join(folder, "characters.md"), encoding="utf-8", errors="replace") as text:
            rows = [CHARACTER_ROW.match(line) for line in text]
    except OSError as error:
        return f"personality.from: {folder} is no readable theme ({error.strerror}: {error.filename})"
    characters = {}
    for row in filter(None, rows):
        role, name, alias, card = row.groups()
        try:
            with open(os.path.join(folder, card), encoding="utf-8", errors="replace") as text:
                characters[role] = {"name": name, "alias": alias, "card": text.read().strip()[:CARD_MAX]}
        except OSError:
            continue
    if not characters:
        return f"personality.from: {folder}/characters.md maps no role to a readable character card"
    return theme[:CARD_MAX], characters


def with_personality(entry):
    """The workspace entry with its personality theme read in."""
    personality = entry.get("personality")
    if not isinstance(personality, dict) or not isinstance(personality.get("from"), str) or not personality["from"]:
        return entry
    read = read_theme(personality["from"])
    if isinstance(read, str):
        return {**entry, "personality": {}, "problems": [*entry.get("problems", []), read]}
    theme, characters = read
    return {**entry, "personality": {**personality, "theme": theme, "characters": characters}}


def read_workspace(folder, root):
    """The workspace an orchestra.json in folder declares, an error entry, or None without one."""
    file = os.path.join(folder, WORKSPACE_FILE)
    if not os.path.isfile(file):
        return None
    shown = os.path.relpath(file, root)
    try:
        with open(file, encoding="utf-8") as text:
            config = json.load(text)
    except (OSError, ValueError) as error:
        return {"path": os.path.relpath(folder, root), "file": shown, "error": f"not readable JSON ({error})"}
    if not isinstance(config, dict):
        return {"path": os.path.relpath(folder, root), "file": shown, "error": "not a JSON object"}
    ruled = os.path.normpath(os.path.join(folder, str(config.get("root", "."))))
    if ruled != root and not ruled.startswith(root + os.sep):
        return {"path": os.path.relpath(folder, root), "file": shown, "error": f"root {config.get('root')!r} leads outside {root}"}
    # Apps stay agnostic of the orchestra: a workspace rules a folder of repos, never a repo itself.
    inside = ruled
    while inside != root:
        if os.path.isdir(os.path.join(inside, ".git")):
            return {"path": os.path.relpath(folder, root), "file": shown, "error": f"it rules {os.path.relpath(ruled, root)}, which is (inside) the git repo {os.path.relpath(inside, root)}: apps stay agnostic of the orchestra, put its rules in the workspace around it"}
        inside = os.path.dirname(inside)
    entry = {key: value for key, value in config.items() if key != "root"}
    # The root's own file rules every repo under it: its path is "".
    return with_docs(with_personality(with_cards({**entry, "path": "" if ruled == root else os.path.relpath(ruled, root), "file": shown})))


def folders(root, skip_under):
    """Every folder to look into under root, to MAX_DEPTH, minus SKIP and each workspace's ignore."""
    for current, dirs, _files in os.walk(root):
        depth = current[len(root):].count(os.sep)
        rel = os.path.relpath(current, root)
        ignored = set()
        for path, names in skip_under.items():
            if rel == path or rel.startswith(path + os.sep):
                ignored |= names
        dirs[:] = [] if depth >= MAX_DEPTH else sorted(d for d in dirs if d not in SKIP and d not in ignored and not d.startswith("."))
        yield current


def walk(root):
    workspaces = [w for w in (read_workspace(f, root) for f in folders(root, {})) if w is not None]
    skip_under = {}
    for w in workspaces:
        names = w.get("ignore") if "error" not in w else None
        if isinstance(names, list):
            skip_under.setdefault(w["path"], set()).update(str(n) for n in names if isinstance(n, str))
    repos = [
        {"repo": os.path.relpath(f, root), "about": about(f)}
        for f in folders(root, skip_under)
        if f != root and os.path.isdir(os.path.join(f, ".git"))
    ]
    return repos, workspaces


if __name__ == "__main__":
    if sys.argv[1] == "--workspaces":
        print(json.dumps(walk(sys.argv[2].rstrip(os.sep))[1]))
    else:
        print(json.dumps(walk(sys.argv[1].rstrip(os.sep))[0]))
