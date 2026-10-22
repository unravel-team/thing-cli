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
| `thing login [--account name] [--server url] [--no-browser]` | Add or refresh a named account with device-code login; defaults the name to the authenticated email |
| `thing accounts` | List saved accounts and show which one this directory resolves to |
| `thing switch <account> [--local]` | Change the global default account, or bind an account to the current Git repository/working directory |
| `thing switch --clear-local` | Remove the account binding inherited by the current directory |
| `thing logout [--account name] [--all]` / `thing whoami` | Remove saved credentials / show the resolved identity and where pushes land |
| `thing default [team] [--clear]` | Show or set your server-side default push target (used when no `--team` is given, from any machine) |
| `thing setup claude [--remove] [--dry-run]` | Let Claude Code auto mode publish to thing without refusals: adds usething.ai and `thing push` to the `autoMode` trust entries in `~/.claude/settings.json`, keeping Claude Code's defaults. Run it yourself (in Claude Code type `! npx -y @unravel-tech/thing@latest setup claude`); `--remove` undoes it |
| `thing use <team> [project]` | Set a local active team/project override for this machine |
| `thing push <file.html\|.md\|.pdf\|.png\|.jpg\|.gif\|.webp> [--name x] [--team t] [--project p] [--visibility v] [--password p]` | Authenticate if needed, then push a new immutable version and print the served URL. `--visibility` is `private` (only you and people you add), `team` (everyone in the org, the default) or `public` (anyone with the link). `--password` lets anyone who knows it open the artifact beside team and people access |
| `thing list` | List artifacts you can see; filter with `--label` or `--search`, sort with `--sort created` or `updated` and `--order asc` or `desc`, page with `--limit` and `--offset` |
| `thing get <name> [--version n] [--output file]` | Read the pushed source of a version. HTML and Markdown print to stdout; PDFs and images save under their download name (never overwriting) or to `--output` |
| `thing comments <name>` | Pull comments and replies from a viewable artifact |
| `thing versions <name>` | Version history for an artifact; works for viewers and public links |
| `thing responses <name> [--mine] [--collection c] [--history] [--csv]` | Read a page's Inputs answers (every respondent for publishers and editors). Each row says whether it came from the browser or an agent |
| `thing respond <name> <collection> (--data '{json}' \| --field key=value ...) [--version n]` | Answer a page's Inputs as the signed-in user. `--field` repeats and types `true`, `false`, `null` and numbers. Recorded as `via: agent` |
| `thing rollback <name> <n>` | Point latest back to version n |
| `thing open <name>` | Open the artifact in a browser |
| `thing mcp` | Run a Model Context Protocol server over stdio (tools: `server_info`, `push_artifact`, `list_artifacts`, `get_artifact`, `list_artifact_versions`, `list_artifact_comments`, `list_artifact_responses`, `submit_artifact_response`, `whoami`) |

`<name>` is an artifact name, `team/slug`, or a pasted link. A `/v/N` link pins
that version and `?k=` link keys are kept. A link on another host is read
without your token unless your own server confirms it is the same artifact.
`push` prints any server `notes` (for example an Inputs mistake) to stderr and
includes them in `--json`.

Every command accepts `--json` for machine-readable output. Authenticated
commands also accept `--account name` to use a saved account once without
changing either the global default or a directory binding.
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

### Accounts

Thing can keep multiple logins on one machine. Give accounts short names when
you add them, list them, and switch the global default:

```sh
thing login --account work
thing login --account personal
thing accounts
thing switch work
```

To associate the current repository with an account, run:

```sh
thing switch work --local
```

Inside a Git repository, this binds its root and every directory beneath it.
Outside Git, it binds the current working directory and its descendants. The
binding is stored in your user config—not `.thing.json`—so personal account
names and credentials never become repository changes. A local binding wins
over the global default; `--account personal` wins over both for one command.
Use `thing switch --clear-local` to remove the binding.

Existing single-login config files migrate automatically to an account named
`default`. New logins without `--account` use the authenticated email address
as the account name.

Account selection is resolved in this order: `--account` → the nearest
repository/directory binding → the global `thing switch` selection → the only
saved account. `THING_TOKEN` and `THING_SERVER` still override stored
credentials for CI and MCP configurations.

### Team and project

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

The server exposes these tools: `server_info` for the installed version and
update status, `push_artifact` to publish a file or inline content and get back
a link (with any server `notes`), `list_artifacts` to see what you have,
`get_artifact` to read a version's source (text inline, PDFs and images saved
to `save_to`), `list_artifact_versions`, `list_artifact_comments`,
`list_artifact_responses` to read a page's Inputs answers,
`submit_artifact_response` to answer them for the user when asked, and
`whoami` to check which account and team you are pushing to. Every tool that
takes an artifact accepts a name, `team/slug`, or link.

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
