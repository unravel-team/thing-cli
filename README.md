# @unravel-tech/thing

CLI for [thing](https://usething.ai): push, version, and share artifacts (HTML pages, Markdown docs, standalone images and PDFs) from coding agents.

```sh
npx -y @unravel-tech/thing push report.html
```

That first push opens browser approval, waits for sign-in, then resumes and
prints the durable URL. Markdown, images, and PDFs work the same way. Install
globally if you use it often: `npm i -g @unravel-tech/thing`.

## Commands

| Command | What it does |
| --- | --- |
| `thing --version` / `thing version` | Show the installed CLI version |
| `thing update [--force] [--manager npm\|bun]` | Install the latest release globally; `--force` runs even when the server reports this version as current |
| `thing login [--server url] [--no-browser]` | Explicit device-code login; opens browser approval and stores a token |
| `thing logout` / `thing whoami` | Clear / show the current identity and where pushes land |
| `thing default [team] [--clear]` | Show or set your server-side default push target (used when no `--team` is given, from any machine) |
| `thing use <team> [project]` | Set a local active team/project override for this machine |
| `thing push <file.html\|.md\|.pdf\|.png\|.jpg\|.gif\|.webp> [--name x] [--team t] [--project p] [--visibility v]` | Authenticate if needed, then push a new immutable version and print the served URL |
| `thing list` | List artifacts you can see |
| `thing versions <name>` | Version history for an artifact |
| `thing rollback <name> <n>` | Point latest back to version n |
| `thing open <name>` | Open the artifact in a browser |
| `thing mcp` | Run a Model Context Protocol server over stdio (tools: `server_info`, `push_artifact`, `list_artifacts`, `whoami`) |

Every command accepts `--json` for machine-readable output.
An unauthenticated `push --json` emits newline-delimited authentication status;
the final JSON object is always the push result. Use `--no-login` to fail fast
instead of starting interactive authentication, such as in CI.

Visibility values: `private`, `team`, `anyone-with-link` (prints a tokened share URL), `public`.

## Updates

Thing supports advisory and required updates published by the Thing server. An
advisory update prints a rate-limited notice to stderr but lets the command
continue. A required update stops normal commands with exit code 3 while
keeping `--help`, `--version`, and `update` available. `--json` returns a
structured `CLIENT_UPDATE_REQUIRED` error.

The CLI checks at most once per hour and shows the same advisory at most once
per day. Set `THING_NO_UPDATE_NOTICES=1` to hide advisory notices; required
updates cannot be suppressed. `thing update --force` reinstalls the latest
release even when the current version is still supported.

MCP sessions expose the installed version through the initialization handshake
and the `server_info` tool. Advisory updates appear in MCP instructions, a log
notification, and the first business-tool result. Required updates leave
`server_info` available but stop artifact tools until Thing is updated and the
MCP client is restarted.

The corresponding Thing server endpoint and enforcement middleware are
specified in [`THING_SERVER_UPDATE_POLICY.md`](./THING_SERVER_UPDATE_POLICY.md).

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
      "args": ["-y", "@unravel-tech/thing@latest", "mcp"],
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
      "args": ["-y", "@unravel-tech/thing@latest", "mcp"],
      "env": { "THING_TOKEN": "paste-your-token-here" }
    }
  }
}
```

The server exposes four tools: `server_info` for the installed version and
update status, `push_artifact` to publish a file or inline content and get back
a link, `list_artifacts` to see what you have, and `whoami` to check which
account and team you are pushing to.

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
