#!/bin/sh
':' //# ; rt="$(command -v node || command -v bun)"; [ -n "$rt" ] || { echo "thing: needs Node >= 18 or Bun on PATH" >&2; exit 127; }; exec "$rt" "$0" "$@"
// The shebang is /bin/sh, not `env node`, so a global install never hard-requires
// a `node` binary: bun links its global bins straight at this file, and the kernel
// would otherwise run `env node` and fail for anyone who installed with `bun i -g`
// and has no node. Line 2 is a command to sh (exec the first runtime we find, node
// first so npm installs behave exactly as before) and a no-op string plus comment
// to JS, so the file stays valid ESM once the runtime re-reads it.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_SERVER = process.env.THING_SERVER || "https://usething.ai";
// One source for the version: hardcoding it here meant the MCP handshake and
// the analytics client header both kept reporting 0.3.0 releases later.
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
let clientName = `thing-cli/${VERSION}`;
const VISIBILITIES = new Set(["team", "public"]);

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function configPath(env = process.env) {
  const root = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "thing", "config.json");
}

function readJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function projectConfigPath(cwd) {
  return join(cwd, ".thing.json");
}

function loadState(cwd, env = process.env) {
  return {
    env,
    globalPath: configPath(env),
    global: readJson(configPath(env)),
    projectPath: projectConfigPath(cwd),
    project: readJson(projectConfigPath(cwd))
  };
}

function saveGlobal(state) {
  writeJson(state.globalPath, state.global);
}

function parseArgv(argv) {
  const args = [...argv];
  const command = args.shift();
  const positionals = [];
  const flags = {};
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }

  return { command, positionals, flags, json };
}

function stripSlash(server) {
  return String(server || DEFAULT_SERVER).replace(/\/+$/, "");
}

function context(state, flags = {}) {
  const env = state.env ?? process.env;
  return {
    // THING_SERVER and THING_TOKEN let an MCP client run this with no prior
    // `thing login`: the whole config is a paste, which is the difference
    // between usable and not for anyone who does not live in a terminal.
    server: stripSlash(flags.server || env.THING_SERVER || state.project.server || state.global.server || DEFAULT_SERVER),
    token: flags.token || env.THING_TOKEN || state.global.token || null,
    team: flags.team || state.project.team || state.global.activeTeam || null,
    project: flags.project || state.project.project || state.global.activeProject || null
  };
}

function requireToken(ctx) {
  if (!ctx.token) throw new CliError("Not logged in. Run `thing login` first.");
}

function slugify(input) {
  return String(input || "artifact")
    .toLowerCase()
    .replace(/\.html?$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "artifact";
}

function titleFromFile(path) {
  const base = path.split(/[\\/]/).pop() || "artifact";
  return base.replace(/\.[^.]+$/, "") || "artifact";
}

// Standalone media types thing accepts as their own artifact. Mirrors the
// server allowlist so we fail fast with a friendly message before uploading.
const MEDIA_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function output(io, json, value, text) {
  if (json) io.stdout.write(`${JSON.stringify(value)}\n`);
  else io.stdout.write(`${text ?? formatText(value)}\n`);
}

function formatText(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

async function api(ctx, path, options = {}) {
  const headers = {
    Accept: "application/json",
    "X-Thing-Client": clientName,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(ctx.token ? { Authorization: `Bearer ${ctx.token}` } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(`${ctx.server}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
  }
  if (!response.ok) {
    const message = data?.error || data?.text || `${response.status} ${response.statusText}`;
    const error = new CliError(message, response.status === 401 ? 2 : 1);
    error.response = data;
    throw error;
  }
  return data ?? {};
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function login(parsed, state, io) {
  const server = stripSlash(parsed.flags.server || state.global.server || DEFAULT_SERVER);
  const device = await api({ server }, "/api/v1/auth/device/code", { method: "POST", body: {} });
  const loginMessage = `Open ${device.verification_uri_complete || device.verification_uri}\nEnter code: ${device.user_code}`;
  output(io, parsed.json, {
    server,
    verificationUri: device.verification_uri,
    verificationUriComplete: device.verification_uri_complete,
    userCode: device.user_code,
    expiresIn: device.expires_in,
    interval: device.interval
  }, loginMessage);

  const deadline = Date.now() + (Number(device.expires_in || 900) * 1000);
  const interval = Math.max(250, Number(process.env.THING_POLL_INTERVAL_MS || Math.max(1, Number(device.interval || 5)) * 1000));
  let tokenResult = null;
  while (Date.now() < deadline) {
    await sleep(interval);
    try {
      tokenResult = await api({ server }, "/api/v1/auth/device/token", {
        method: "POST",
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code
        }
      });
      break;
    } catch (error) {
      if (error.response?.error === "authorization_pending") continue;
      throw error;
    }
  }
  if (!tokenResult?.access_token) throw new CliError("Login timed out before approval.");

  const ctx = { server, token: tokenResult.access_token };
  const whoami = await api(ctx, "/api/v1/whoami");

  state.global.server = server;
  state.global.token = tokenResult.access_token;
  // Login no longer pins an "active team". With none set the CLI sends no team
  // and the server routes the push to the caller's default (e.g. the Unravel
  // org for Unravel members). Clear any team an older CLI pinned so existing
  // installs self-heal; `thing use` stays the explicit opt-in override.
  delete state.global.activeTeam;
  if (!state.global.activeProject) delete state.global.activeProject;
  saveGlobal(state);

  const defaultTeam = whoami.defaultTeam?.slug || null;
  output(io, parsed.json, {
    ok: true,
    server,
    user: whoami.user,
    defaultTeam
  }, `Logged in as ${whoami.user.email}${defaultTeam ? ` (pushes default to ${defaultTeam})` : ""}`);
}

async function logout(parsed, state, io) {
  delete state.global.token;
  delete state.global.activeTeam;
  delete state.global.activeProject;
  saveGlobal(state);
  output(io, parsed.json, { ok: true }, "Logged out");
}

async function whoami(parsed, state, io) {
  const ctx = context(state, parsed.flags);
  requireToken(ctx);
  const data = await api(ctx, "/api/v1/whoami");
  // Where a no-flag push lands: a local override (`thing use`/.thing.json) wins;
  // otherwise the server default; otherwise the personal space.
  const serverDefault = data.defaultTeam?.slug || null;
  const target = ctx.team ? `${ctx.team} (local override)` : serverDefault ? `${serverDefault} (server default)` : "your personal space";
  output(
    io,
    parsed.json,
    { ...data, server: ctx.server, activeTeam: ctx.team, activeProject: ctx.project },
    `${data.user.email}\nserver: ${ctx.server}\npushes go to: ${target}${ctx.project ? `\nproject: ${ctx.project}` : ""}`
  );
}

async function useContext(parsed, state, io) {
  const [team, project] = parsed.positionals;
  if (!team) throw new CliError("Usage: thing use <team> [project]");
  state.global.activeTeam = team;
  if (project) state.global.activeProject = project;
  else delete state.global.activeProject;
  saveGlobal(state);
  output(io, parsed.json, { team, project: project || null }, `Active context set to ${team}${project ? `/${project}` : ""}`);
}

// Sets the server-side default team: the one pushes go to when no --team is
// given, from any client. Distinct from `use`, which is a local-only context.
async function defaultTeam(parsed, state, io) {
  const ctx = context(state, parsed.flags);
  requireToken(ctx);
  const [team] = parsed.positionals;
  const clear = Boolean(parsed.flags.clear);

  if (!team && !clear) {
    const me = await api(ctx, "/api/v1/whoami");
    const current = me.defaultTeam?.slug || null;
    output(io, parsed.json, { defaultTeam: me.defaultTeam ?? null }, current ? `Default push target: ${current}` : "No default push target set");
    return;
  }

  const data = await api(ctx, "/api/v1/me/default-team", { method: "PUT", body: { slug: clear ? null : team } });
  const slug = data.defaultTeam?.slug || null;
  output(io, parsed.json, data, slug ? `Default push target set to ${slug}` : "Default push target cleared");
}

async function list(parsed, state, io) {
  const ctx = context(state, parsed.flags);
  requireToken(ctx);
  const data = await api(ctx, "/api/v1/artifacts");
  let artifacts = data.artifacts || [];
  if (ctx.team) artifacts = artifacts.filter((artifact) => artifact.teamSlug === ctx.team);
  if (ctx.project) artifacts = artifacts.filter((artifact) => artifact.projectSlug === ctx.project);
  output(io, parsed.json, { artifacts }, artifacts.length ? artifacts.map((a) => `${a.teamSlug}/${a.slug}\t${a.visibility}\t${a.title}`).join("\n") : "No artifacts");
}

async function resolveArtifact(ctx, name) {
  const slug = slugify(name);
  const data = await api(ctx, "/api/v1/artifacts");
  const artifacts = data.artifacts || [];
  const matches = artifacts.filter((artifact) => {
    if (ctx.team && artifact.teamSlug !== ctx.team) return false;
    if (ctx.project && artifact.projectSlug !== ctx.project) return false;
    return artifact.slug === slug || artifact.slug === name || artifact.title === name;
  });
  if (matches.length === 0) throw new CliError(`Artifact not found: ${name}`);
  if (matches.length > 1) throw new CliError(`Artifact name is ambiguous: ${name}. Use --team.`);
  return matches[0];
}

async function detail(ctx, artifact) {
  return api(ctx, `/api/v1/artifacts/${encodeURIComponent(artifact.id)}`);
}

// HTML rides as text; Markdown and media ride as base64 bytes with their real
// filename so the server can derive the content-type from the extension.
function docFromFile(path) {
  if (!existsSync(path)) throw new CliError(`File not found: ${path}`);
  const ext = extname(path).toLowerCase();
  const isHtml = ext === ".html" || ext === ".htm";
  const isMarkdown = ext === ".md" || ext === ".markdown";
  if (!isHtml && !isMarkdown && !MEDIA_EXTS.has(ext)) {
    throw new CliError(`Unsupported file type: ${ext || path}. Push an HTML page, a Markdown file, or a pdf/png/jpg/gif/webp file.`);
  }
  return isHtml
    ? { filename: "index.html", html: readFileSync(path, "utf8") }
    : { filename: basename(path), contentBase64: readFileSync(path).toString("base64") };
}

async function pushToServer(ctx, { doc, name, visibility }) {
  requireToken(ctx);
  if (visibility && !VISIBILITIES.has(visibility)) throw new CliError("Invalid visibility. Use team or public.");
  const pushed = await api(ctx, "/api/v1/artifacts", {
    method: "POST",
    body: {
      team: ctx.team || undefined,
      project: ctx.project || undefined,
      slug: slugify(name),
      title: name,
      visibility: visibility || undefined,
      ...doc
    }
  });
  return {
    artifact: pushed.artifact,
    version: pushed.version,
    url: pushed.artifact.url,
    visibility: pushed.artifact.visibility,
    tokenedUrl: null
  };
}

async function push(parsed, state, io) {
  const [file] = parsed.positionals;
  if (!file) throw new CliError("Usage: thing push <file.html|.md|.pdf|.png|.jpg|.gif|.webp> [--name x] [--team t] [--project p] [--visibility team|public]");
  const ctx = context(state, parsed.flags);
  requireToken(ctx);
  const path = resolve(file);
  const doc = docFromFile(path);
  const result = await pushToServer(ctx, {
    doc,
    name: parsed.flags.name || titleFromFile(path),
    visibility: parsed.flags.visibility
  });
  output(io, parsed.json, result, result.url);
}

async function versionsCommand(parsed, state, io) {
  const [name] = parsed.positionals;
  if (!name) throw new CliError("Usage: thing versions <name>");
  const ctx = context(state, parsed.flags);
  requireToken(ctx);
  const artifact = await resolveArtifact(ctx, name);
  const full = await detail(ctx, artifact);
  output(io, parsed.json, full, full.versions.length ? full.versions.map((v) => `v${v.number}\t${v.id === full.artifact.latestVersionId ? "latest" : ""}\t${v.createdAt}`).join("\n") : "No versions");
}

async function rollback(parsed, state, io) {
  const [name, versionText] = parsed.positionals;
  if (!name || !versionText) throw new CliError("Usage: thing rollback <name> <version>");
  const version = Number(versionText);
  if (!Number.isInteger(version) || version <= 0) throw new CliError("Version must be a positive integer.");
  const ctx = context(state, parsed.flags);
  requireToken(ctx);
  const artifact = await resolveArtifact(ctx, name);
  const result = await api(ctx, `/api/v1/artifacts/${encodeURIComponent(artifact.id)}/rollback`, {
    method: "POST",
    body: { version }
  });
  output(io, parsed.json, { artifact, ...result }, `Rolled back ${artifact.teamSlug}/${artifact.slug} to v${result.latestVersion}`);
}

function openerCommand(url) {
  if (process.platform === "darwin") return ["open", [url]];
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

async function openCommand(parsed, state, io) {
  const [name] = parsed.positionals;
  if (!name) throw new CliError("Usage: thing open <name>");
  const ctx = context(state, parsed.flags);
  requireToken(ctx);
  const artifact = await resolveArtifact(ctx, name);
  const url = `${ctx.server}/${artifact.teamSlug}/${artifact.slug}`;
  if (!parsed.json && !parsed.flags["no-browser"]) {
    const [cmd, args] = openerCommand(url);
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  }
  output(io, parsed.json, { url, artifact }, url);
}

// --- MCP server (`thing mcp`) ---------------------------------------------
// Newline-delimited JSON-RPC 2.0 over stdio, per the Model Context Protocol.
// Zero dependencies: three tools that reuse the CLI's own auth and push path,
// so any MCP client (Claude Code, Cursor, a desktop assistant) can publish
// artifacts through the user's existing `thing login`.

const MCP_TOOLS = [
  {
    name: "push_artifact",
    description:
      "Use this whenever the user wants to share, send, show, or publish something you produced: a report, a dashboard, a prototype, a Markdown doc, a PDF, an image. Publishes it to a durable URL that stays live, and returns the link. Pushing the same name again creates a new version at the same link rather than a second link, so prefer reusing a name over inventing one. Pass either `path` (html, md, pdf, png, jpg, gif, webp) or inline `content` with a `filename` (html or md).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to push" },
        content: { type: "string", description: "Inline document text (HTML or Markdown) — use with filename" },
        filename: { type: "string", description: "Filename for inline content, e.g. report.html or notes.md" },
        name: { type: "string", description: "Artifact name (defaults to the filename)" },
        team: { type: "string", description: "Team slug to push to (defaults to the user's default team)" },
        project: { type: "string", description: "Project slug" },
        visibility: { type: "string", enum: ["team", "public"], description: "Who can see it" }
      }
    }
  },
  {
    name: "list_artifacts",
    description:
      "Use this to find a link the user published earlier, or to check whether something is already published before pushing it again. Lists artifacts the signed-in user can see, with team, visibility and title.",
    inputSchema: {
      type: "object",
      properties: {
        team: { type: "string", description: "Only artifacts in this team slug" },
        project: { type: "string", description: "Only artifacts in this project" }
      }
    }
  },
  {
    name: "whoami",
    description:
      "Use this to confirm the user is signed in and which team will own a new artifact. Shows the account, the server, and where pushes land when no team is named.",
    inputSchema: { type: "object", properties: {} }
  }
];

async function mcpTool(state, parsed, name, args) {
  const ctx = context(state, {
    ...parsed.flags,
    ...(args.team ? { team: args.team } : {}),
    ...(args.project ? { project: args.project } : {})
  });
  if (name === "whoami") {
    requireToken(ctx);
    const data = await api(ctx, "/api/v1/whoami");
    return { user: data.user, server: ctx.server, defaultTeam: data.defaultTeam?.slug ?? null };
  }
  if (name === "list_artifacts") {
    requireToken(ctx);
    const data = await api(ctx, "/api/v1/artifacts");
    let artifacts = data.artifacts || [];
    if (ctx.team) artifacts = artifacts.filter((a) => a.teamSlug === ctx.team);
    if (ctx.project) artifacts = artifacts.filter((a) => a.projectSlug === ctx.project);
    return { artifacts };
  }
  if (name === "push_artifact") {
    requireToken(ctx);
    let doc;
    let fallbackName;
    if (args.path) {
      const path = resolve(String(args.path));
      doc = docFromFile(path);
      fallbackName = titleFromFile(path);
    } else if (args.content && args.filename) {
      const ext = extname(String(args.filename)).toLowerCase();
      if (ext === ".html" || ext === ".htm") doc = { filename: "index.html", html: String(args.content) };
      else if (ext === ".md" || ext === ".markdown") doc = { filename: basename(String(args.filename)), contentBase64: Buffer.from(String(args.content)).toString("base64") };
      else throw new CliError("Inline content must be .html or .md; push binaries via `path`.");
      fallbackName = titleFromFile(String(args.filename));
    } else {
      throw new CliError("Provide either `path`, or `content` plus `filename`.");
    }
    return pushToServer(ctx, { doc, name: args.name || fallbackName, visibility: args.visibility });
  }
  throw new CliError(`Unknown tool: ${name}`);
}

async function mcp(parsed, state, io) {
  clientName = `thing-mcp/${VERSION}`;
  const respond = (id, body) => io.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
  const handle = async (req) => {
    if (req.method === "initialize") {
      return {
        protocolVersion: req.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "thing", version: VERSION }
      };
    }
    if (req.method === "tools/list") return { tools: MCP_TOOLS };
    if (req.method === "ping") return {};
    if (req.method === "tools/call") {
      const { name, arguments: args = {} } = req.params || {};
      try {
        const result = await mcpTool(state, parsed, name, args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        // Tool failures are results, not protocol errors, per MCP.
        return { content: [{ type: "text", text: error.message }], isError: true };
      }
    }
    throw new CliError(`Method not found: ${req.method}`);
  };

  let buffer = "";
  for await (const chunk of io.stdin || process.stdin) {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      if (request.id === undefined || request.id === null) continue; // notification
      try {
        respond(request.id, { result: await handle(request) });
      } catch (error) {
        respond(request.id, { error: { code: -32601, message: error.message } });
      }
    }
  }
}

function usage() {
  return `Usage: thing <command> [options]

Commands:
  login [--server url]
  logout
  whoami
  use <team> [project]
  default [team] [--clear]
  push <file.html|.md|.pdf|.png|.jpg|.gif|.webp> [--name x] [--team t] [--project p] [--visibility team|public]
  list
  versions <name>
  rollback <name> <version>
  open <name>
  mcp                     # Model Context Protocol server over stdio

Global options:
  --json
`;
}

export async function run(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd(), env: process.env }) {
  const parsed = parseArgv(argv);
  const state = loadState(io.cwd || process.cwd(), io.env || process.env);
  try {
    switch (parsed.command) {
      case "login":
        await login(parsed, state, io);
        break;
      case "logout":
        await logout(parsed, state, io);
        break;
      case "whoami":
        await whoami(parsed, state, io);
        break;
      case "use":
        await useContext(parsed, state, io);
        break;
      case "default":
        await defaultTeam(parsed, state, io);
        break;
      case "push":
        await push(parsed, state, io);
        break;
      case "list":
        await list(parsed, state, io);
        break;
      case "versions":
        await versionsCommand(parsed, state, io);
        break;
      case "rollback":
        await rollback(parsed, state, io);
        break;
      case "open":
        await openCommand(parsed, state, io);
        break;
      case "mcp":
        await mcp(parsed, state, io);
        break;
      case "-h":
      case "--help":
      case undefined:
        io.stdout.write(usage());
        break;
      default:
        throw new CliError(`Unknown command: ${parsed.command}\n${usage()}`);
    }
    return 0;
  } catch (error) {
    if (parsed.json) {
      io.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    } else {
      io.stderr.write(`${error.message}\n`);
    }
    return error.exitCode || 1;
  }
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (import.meta.url === pathToFileURL(invokedPath).href) {
  const code = await run();
  process.exitCode = code;
}
