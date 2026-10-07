---
name: public-apis
description: Finds free public APIs for a need (weather, cards, maps, finance, open data, games, ~2,000 APIs in 50 categories) in the public-apis catalogue (github.com/public-apis/public-apis), kept as a local clone refreshed daily. Use when a task or an app needs an external data source or third-party API, when choosing between APIs, or when the user asks which API exists for something.
---

# public-apis

The catalogue of [public-apis](https://github.com/public-apis/public-apis) (MIT), searched
from a local clone in `~/.cache/public-apis`. The script clones it on first use and pulls
it once a day; offline, the last copy serves.

```bash
S=~/.claude/skills/public-apis/apis.py
$S weather --no-auth --https           # every word must match: name, description or category
$S -c "games" magic                    # within a category (substring)
$S --categories                        # the 50 categories and their size
$S books --cors -n 0                   # callable from a browser, all rows
$S --refresh scryfall                  # pull the catalogue now
```

Each row: `Name — description [category; auth: No|apiKey|OAuth|…, https: Yes|No, cors: Yes|No|Unknown] url`.

## How to use it

- Search with one or two keywords first, then narrow with `-c`, `--no-auth`, `--https`, `--cors`.
- A front end calling the API directly needs `cors: Yes`; otherwise the call goes through
  the app's back end.
- `auth: No` means no key at all: the simplest for a personal app. An `apiKey` API needs a
  key in the app's settings (an environment variable, never in the repo).
- The catalogue is a community list: before building on an API, open its URL and check it
  still answers, its terms and its rate limits.
- Only the category tables are read; the sponsored sections at the top of the README are not.
