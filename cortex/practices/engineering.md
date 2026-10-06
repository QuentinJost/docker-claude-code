# Engineering practices

> Conventions every worker of the orchestra follows in the personal projects (every repo under
> `~/dev` but the Bluspark workspace, which has its own team conventions). Distilled from the
> Bluspark team's conventions, without what is Bluspark's own (its stack, tools, business rules).
> A repo's own written conventions (its README, CONTRIBUTING, project-context.md) win over these.

| Topic | Rule |
|---|---|
| **Commits** | Conventional Commits with a gitmoji prefix (`✨ feat(scope): …`, `🐛 fix:`, `📝 docs:`, `♻️ refactor:`, `🔧 chore:`, `✅ test:`…), in English. A short subject, 72 characters at most; no body (the diff speaks) and no trailer. |
| **English only** | All code (names of classes, functions, variables, tables, columns, files) and all comments, docblocks and markers are in English, even in a file whose existing comments are in another language. Values shown to users and stored business values keep their language. |
| **Reuse before creating** | Before writing a new script, command, job or module, check that an existing one does not already cover the case, by configuration or a parameter. Extend it rather than add a near-copy. |
| **User-facing messages** | A message meant for the user (an error, a notice) is a translation key, never a hard-coded string, as soon as the project has translations. |
| **API errors** | An endpoint the front end calls answers an error with a proper status and a translated message body; it never lets a raw exception reach the client. |
| **Feature flags** | A feature meant to be opened per client, or sold, goes behind an opt-in flag, off by default. |
| **TODO and FIXME** | A `TODO` or `FIXME` always names what tracks it (an issue, a ticket): `// TODO: #42 <what>`. Without one, nobody follows it up. |
| **Heavy work** | No heavy processing, message dispatch or nested save inside the ORM's save cycle or its listeners: defer it to asynchronous work after the commit. |
| **Data and secrets** | No secret in the code or the repo: environment variables or a secret store. A database is anonymised before any copy out of production. |
