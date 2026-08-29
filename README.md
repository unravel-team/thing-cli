# @unravel-tech/thing

CLI for [thing](https://usething.ai): push, version, and share artifacts (HTML pages, Markdown docs, standalone images and PDFs) from coding agents.

```sh
npm i -g @unravel-tech/thing         # or: bun i -g @unravel-tech/thing
thing login                          # defaults to https://usething.ai
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

Claude Code, Cursor, Codex, and anything else that speaks Model Context
Protocol can publish through thing. No terminal login needed: create a token at
[usething.ai](https://usething.ai) under Settings, then Tokens, and paste this
into your client's MCP config.

```json
{
  "mcpServers": {
    "thing": {
      "command": "npx",
      "args": ["-y", "@unravel-tech/thing", "mcp"],
      "env": { "THING_TOKEN": "paste-your-token-here" }
    }
  }
}
```

On a machine that has Bun but no Node, swap `npx` for `bunx`:

```json
{
  "mcpServers": {
    "thing": {
      "command": "bunx",
      "args": ["-y", "@unravel-tech/thing", "mcp"],
      "env": { "THING_TOKEN": "paste-your-token-here" }
    }
  }
}
```

The server exposes three tools: `push_artifact` to publish a file or inline
content and get back a link, `list_artifacts` to see what you have, and
`whoami` to check which account and team you are pushing to.

If you already ran `thing login`, the stored credential is used and
`THING_TOKEN` can be left out.

## Runtimes

Node >= 18 or Bun, no runtime dependencies. The `thing` executable launches under
whichever of the two is on your PATH (Node first), so a global install works on a
machine that has never installed Node:

```sh
bun i -g @unravel-tech/thing
thing login
```
