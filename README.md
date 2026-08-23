# @unravel-tech/thing

CLI for [thing](https://thing.unravel.tech): push, version, and share artifacts — HTML pages, Markdown docs, standalone images and PDFs — from coding agents.

```sh
npm i -g @unravel-tech/thing
thing login                          # defaults to https://thing.unravel.tech
thing push report.html --json
thing push notes.md --json           # Markdown gets a styled reader view
thing push chart.png --json          # images and PDFs too
```

## Commands

| Command | What it does |
| --- | --- |
| `thing login [--server url]` | Device-code login; stores a token (does not pin a team) |
| `thing logout` / `thing whoami` | Clear / show the current identity and where pushes land |
| `thing default [team] [--clear]` | Show or set your server-side default push target (used when no `--team` is given, from any machine) |
| `thing use <team> [project]` | Set a local active team/project override for this machine |
| `thing push <file.html\|.md\|.pdf\|.png\|.jpg\|.gif\|.webp> [--name x] [--team t] [--project p] [--visibility v]` | Push a new immutable version (HTML, Markdown, or image/PDF), print the served URL |
| `thing list` | List artifacts you can see |
| `thing versions <name>` | Version history for an artifact |
| `thing rollback <name> <n>` | Point latest back to version n |
| `thing open <name>` | Open the artifact in a browser |
| `thing mcp` | Run a Model Context Protocol server over stdio (tools: `push_artifact`, `list_artifacts`, `whoami`) |

Every command accepts `--json` for machine-readable output.

Visibility values: `private`, `team`, `anyone-with-link` (prints a tokened share URL), `public`.

## Context resolution

Which team a push lands in is decided in order: `--team` flag → `.thing.json` in the
working directory → a local `thing use` override → your **server-side default**
(`thing default`) → your personal space. Login no longer pins a team, so with none of
the overrides set the server picks your default (e.g. the Unravel org for Unravel members).

## MCP

Any MCP client can push artifacts through your CLI login — register the server as:

```json
{ "command": "thing", "args": ["mcp"] }
```

Requires Node >= 18 or Bun. No runtime dependencies.
