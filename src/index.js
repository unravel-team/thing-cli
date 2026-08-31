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
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_SERVER = process.env.THING_SERVER || "https://usething.ai";
const PACKAGE_NAME = "@unravel-tech/thing";
const PACKAGE_SPEC = `${PACKAGE_NAME}@latest`;
const UPDATE_POLICY_PATH = "/api/v1/client-policy";
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 1500;
const UPDATE_REQUIRED_EXIT_CODE = 3;
const UPDATE_STATUSES = new Set(["current", "update_available", "update_required"]);
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

class UpdateRequiredError extends CliError {
  constructor(policy) {
    const client = policy.client === "thing-mcp" ? "Thing MCP" : "Thing CLI";
    const requiredVersion = policy.minimumVersion || policy.latestVersion;
    super(`${client} ${VERSION} is no longer supported.${requiredVersion ? ` Version ${requiredVersion} or newer is required.` : " An update is required."}`, UPDATE_REQUIRED_EXIT_CODE);
    this.code = "CLIENT_UPDATE_REQUIRED";
    this.policy = policy;
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

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function savedAccounts(global) {
  return isRecord(global.accounts) ? global.accounts : {};
}

function migrateGlobalConfig(value) {
  const global = isRecord(value) ? value : {};
  let migrated = false;
  if (typeof global.token === "string" && global.token) {
    const accounts = savedAccounts(global);
    let name = typeof global.activeAccount === "string" && global.activeAccount.trim()
      ? global.activeAccount.trim()
      : "default";
    if (accounts[name] && accounts[name].token !== global.token) {
      let suffix = 2;
      while (accounts[`default-${suffix}`]) suffix += 1;
      name = `default-${suffix}`;
    }
    accounts[name] = {
      ...(isRecord(accounts[name]) ? accounts[name] : {}),
      server: stripSlash(global.server || DEFAULT_SERVER),
      token: global.token
    };
    global.accounts = accounts;
    global.activeAccount = name;
    delete global.token;
    migrated = true;
  }
  return { global, migrated };
}

function projectConfigPath(cwd) {
  return join(cwd, ".thing.json");
}

function normalizedDirectory(cwd) {
  const path = resolve(cwd);
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function ancestorDirectories(cwd) {
  const directories = [];
  let current = normalizedDirectory(cwd);
  while (true) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

function repositoryRoot(cwd) {
  return ancestorDirectories(cwd).find((directory) => existsSync(join(directory, ".git"))) || null;
}

function directoryAccountBinding(global, cwd) {
  const bindings = isRecord(global.accountBindings) ? global.accountBindings : {};
  for (const directory of ancestorDirectories(cwd)) {
    if (typeof bindings[directory] === "string" && bindings[directory]) {
      return { account: bindings[directory], directory };
    }
  }
  return null;
}

function loadState(cwd, env = process.env) {
  const globalPath = configPath(env);
  const migrated = migrateGlobalConfig(readJson(globalPath));
  if (migrated.migrated) {
    try {
      writeJson(globalPath, migrated.global);
    } catch {
      // A read-only legacy config can still be used for this invocation.
    }
  }
  return {
    env,
    cwd: normalizedDirectory(cwd),
    globalPath,
    global: migrated.global,
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

function cleanAccountName(value) {
  if (typeof value !== "string" || !value.trim()) throw new CliError("Account name cannot be empty.");
  const name = value.trim();
  if (name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new CliError("Account name must be 100 characters or fewer and cannot contain control characters.");
  return name;
}

function accountSelection(state, flags = {}, options = {}) {
  const accounts = savedAccounts(state.global);
  const binding = directoryAccountBinding(state.global, state.cwd);
  let name = null;
  let source = null;
  if (flags.account !== undefined) {
    name = cleanAccountName(flags.account);
    source = "flag";
  } else if (binding) {
    name = binding.account;
    source = "directory";
  } else if (typeof state.global.activeAccount === "string" && state.global.activeAccount) {
    name = state.global.activeAccount;
    source = "global";
  } else {
    const names = Object.keys(accounts);
    if (names.length === 1) {
      [name] = names;
      source = "only";
    }
  }

  const account = name && isRecord(accounts[name]) ? accounts[name] : null;
  if (name && !account && options.strict !== false) {
    const location = source === "directory" && binding ? ` for ${binding.directory}` : "";
    throw new CliError(`Unknown account "${name}"${location}. Run \`thing accounts\` to see saved accounts, then \`thing switch <account>${source === "directory" ? " --local" : ""}\`.`);
  }
  return { name, account, source, binding };
}

function context(state, flags = {}) {
  const env = state.env ?? process.env;
  const selected = accountSelection(state, flags);
  return {
    // THING_SERVER and THING_TOKEN let an MCP client run this with no prior
    // `thing login`: the whole config is a paste, which is the difference
    // between usable and not for anyone who does not live in a terminal.
    server: stripSlash(flags.server || env.THING_SERVER || state.project.server || selected.account?.server || state.global.server || DEFAULT_SERVER),
    token: flags.token || env.THING_TOKEN || selected.account?.token || null,
    team: flags.team || state.project.team || state.global.activeTeam || null,
    project: flags.project || state.project.project || state.global.activeProject || null,
    account: selected.name || null,
    accountSource: selected.source || null
  };
}

function clientKind(name = clientName) {
  return String(name).startsWith("thing-mcp/") ? "thing-mcp" : "thing-cli";
}

function safeVersion(value) {
  const version = String(value || "");
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version) ? version : null;
}

function normalizeUpdatePolicy(value, client = clientKind()) {
  if (!value || typeof value !== "object") return null;
  const status = value.code === "CLIENT_UPDATE_REQUIRED" ? "update_required" : value.status;
  if (!UPDATE_STATUSES.has(status)) return null;
  const latestVersion = safeVersion(value.latestVersion);
  const minimumVersion = safeVersion(value.minimumVersion);
  if (status === "update_available" && !latestVersion) return null;
  if (status === "update_required" && !minimumVersion && !latestVersion) return null;
  return {
    status,
    client,
    currentVersion: VERSION,
    latestVersion,
    minimumVersion,
    package: PACKAGE_NAME
  };
}

function updatePolicyOutput(policy) {
  if (!policy) return { status: "unknown", currentVersion: VERSION, package: PACKAGE_NAME, updateCommand: updateCommand() };
  return {
    ...policy,
    updateCommand: updateCommand()
  };
}

function updateCacheKey(server, client) {
  return `${client}|${server}`;
}

function numberFromEnv(env, name, fallback) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function saveGlobalBestEffort(state) {
  try {
    saveGlobal(state);
  } catch {
    // Update checks must never break an otherwise valid command merely because
    // the config directory is temporarily read-only.
  }
}

async function getUpdatePolicy(state, flags = {}, options = {}) {
  const env = state.env ?? process.env;
  const client = options.client || clientKind();
  const server = context(state, flags).server;
  const key = updateCacheKey(server, client);
  const checks = state.global.updateChecks && typeof state.global.updateChecks === "object"
    ? state.global.updateChecks
    : (state.global.updateChecks = {});
  const cached = checks[key];
  const now = Date.now();
  const interval = numberFromEnv(env, "THING_UPDATE_CHECK_INTERVAL_MS", UPDATE_CHECK_INTERVAL_MS);

  if (!options.forceRefresh && cached && now - Number(cached.checkedAt || 0) < interval) {
    return normalizeUpdatePolicy(cached.policy, client);
  }

  const controller = new AbortController();
  const timeoutMs = numberFromEnv(env, "THING_UPDATE_CHECK_TIMEOUT_MS", UPDATE_CHECK_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let policy = null;
  try {
    const response = await fetch(`${server}${UPDATE_POLICY_PATH}`, {
      headers: {
        Accept: "application/json",
        "X-Thing-Client": `${client}/${VERSION}`
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    policy = normalizeUpdatePolicy(await response.json(), client);
  } catch {
    // Advisory checks fail open. Required updates remain enforced by the 426
    // response on every protected API operation.
  } finally {
    clearTimeout(timeout);
  }

  checks[key] = {
    ...cached,
    checkedAt: now,
    policy
  };
  saveGlobalBestEffort(state);
  return policy;
}

function detectedPackageManager(flags = {}) {
  if (flags.manager) {
    if (flags.manager !== "npm" && flags.manager !== "bun") throw new CliError("Invalid package manager. Use npm or bun.");
    return flags.manager;
  }
  let invokedPath = "";
  try {
    invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
  } catch {
    // Fall through to the runtime check.
  }
  return invokedPath.includes("/.bun/") || process.versions.bun ? "bun" : "npm";
}

function updateCommand(flags = {}) {
  const manager = detectedPackageManager(flags);
  return manager === "bun"
    ? `bun install --global ${PACKAGE_SPEC}`
    : `npm install --global ${PACKAGE_SPEC}`;
}

function ephemeralInvocation() {
  try {
    const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
    if (/[/\\]_npx[/\\]/.test(invokedPath)) return "npx";
    if (/[/\\]\.bun[/\\]install[/\\]cache[/\\]/.test(invokedPath)) return "bunx";
    return null;
  } catch {
    return null;
  }
}

function updateAction(surface) {
  const ephemeral = ephemeralInvocation();
  if (ephemeral) return `Use ${PACKAGE_SPEC} in your ${ephemeral} command, then restart the ${surface === "thing-mcp" ? "MCP client" : "command"}.`;
  const install = `Run: ${updateCommand()}`;
  return surface === "thing-mcp" ? `${install}\nThen restart your MCP client.` : install;
}

function updateNotice(policy, surface = policy?.client || clientKind()) {
  const label = surface === "thing-mcp" ? "Thing MCP" : "Thing CLI";
  if (policy?.status === "update_required") {
    const requiredVersion = policy.minimumVersion || policy.latestVersion;
    return `${label} ${VERSION} is no longer supported.${requiredVersion ? ` Version ${requiredVersion} or newer is required.` : " An update is required."}\n${updateAction(surface)}`;
  }
  if (policy?.status === "update_available") {
    return `Update available: ${label} ${VERSION} → ${policy.latestVersion}.\n${updateAction(surface)}`;
  }
  return "";
}

function advisoryNoticesDisabled(parsed, state) {
  const env = state.env ?? process.env;
  const ci = env.CI && env.CI !== "0" && env.CI !== "false";
  return parsed.json || ci || env.THING_NO_UPDATE_NOTICES === "1";
}

function maybeShowCliUpdate(policy, parsed, state, io) {
  if (policy?.status !== "update_available" || advisoryNoticesDisabled(parsed, state)) return;
  const ctx = context(state, parsed.flags);
  const key = updateCacheKey(ctx.server, "thing-cli");
  const checks = state.global.updateChecks || {};
  const cached = checks[key] || {};
  const now = Date.now();
  const interval = numberFromEnv(state.env ?? process.env, "THING_UPDATE_NOTICE_INTERVAL_MS", UPDATE_NOTICE_INTERVAL_MS);
  if (cached.notifiedVersion === policy.latestVersion && now - Number(cached.notifiedAt || 0) < interval) return;
  io.stderr.write(`\n${updateNotice(policy, "thing-cli")}\n`);
  checks[key] = { ...cached, notifiedVersion: policy.latestVersion, notifiedAt: now };
  state.global.updateChecks = checks;
  saveGlobalBestEffort(state);
}

function updateErrorPayload(error) {
  if (error.code !== "CLIENT_UPDATE_REQUIRED") return { error: error.message };
  return {
    error: error.message,
    code: error.code,
    ...updatePolicyOutput(error.policy)
  };
}

function requireToken(ctx) {
  if (!ctx.token) throw new CliError("Not logged in. Run `thing login`, or remove `--no-login` to authenticate during push.");
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
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal
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
    if (response.status === 426 && data?.code === "CLIENT_UPDATE_REQUIRED") {
      throw new UpdateRequiredError(normalizeUpdatePolicy(data, clientKind()) || {
        status: "update_required",
        client: clientKind(),
        currentVersion: VERSION,
        latestVersion: safeVersion(data.latestVersion),
        minimumVersion: safeVersion(data.minimumVersion),
        package: PACKAGE_NAME
      });
    }
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

function openerCommand(url) {
  if (process.platform === "darwin") return ["open", [url]];
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

function openBrowser(url) {
  try {
    const [cmd, args] = openerCommand(url);
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // A missing desktop opener should not end the login flow: the URL is also
    // printed, so headless and SSH users still have a path forward.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best effort only; the printed URL is the fallback.
  }
}

function loginServer(state, flags = {}) {
  const env = state.env ?? process.env;
  let selectedAccount = null;
  if (flags.account !== undefined) {
    const name = cleanAccountName(flags.account);
    selectedAccount = savedAccounts(state.global)[name] || null;
  } else {
    selectedAccount = accountSelection(state, {}, { strict: false }).account;
  }
  return stripSlash(flags.server || env.THING_SERVER || state.project.server || selectedAccount?.server || state.global.server || DEFAULT_SERVER);
}

async function login(parsed, state, io, options = {}) {
  const server = loginServer(state, parsed.flags);
  const device = await api({ server }, "/api/v1/auth/device/code", {
    method: "POST",
    body: { intent: options.intent || "login" }
  });
  const verificationUrl = device.verification_uri_complete || device.verification_uri;
  const env = state.env ?? process.env;
  const shouldOpenBrowser = !parsed.flags["no-browser"] && env.THING_NO_BROWSER !== "1";
  const loginMessage = `${shouldOpenBrowser ? "Opening" : "Open"} ${verificationUrl}\nEnter code: ${device.user_code}\nWaiting for approval...`;
  output(io, parsed.json, {
    server,
    verificationUri: device.verification_uri,
    verificationUriComplete: device.verification_uri_complete,
    userCode: device.user_code,
    expiresIn: device.expires_in,
    interval: device.interval
  }, loginMessage);
  if (shouldOpenBrowser) openBrowser(verificationUrl);

  const deadline = Date.now() + (Number(device.expires_in || 900) * 1000);
  const interval = Math.max(250, Number(env.THING_POLL_INTERVAL_MS || Math.max(1, Number(device.interval || 5)) * 1000));
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

  const accountName = parsed.flags.account !== undefined
    ? cleanAccountName(parsed.flags.account)
    : cleanAccountName(whoami.user?.email || "default");
  const accounts = savedAccounts(state.global);
  accounts[accountName] = {
    server,
    token: tokenResult.access_token,
    ...(whoami.user?.email ? { email: whoami.user.email } : {})
  };
  state.global.accounts = accounts;
  state.global.activeAccount = accountName;
  state.global.server = server;
  delete state.global.token;
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
    account: accountName,
    server,
    user: whoami.user,
    defaultTeam
  }, `Logged in as ${whoami.user.email} (${accountName})${defaultTeam ? `; pushes default to ${defaultTeam}` : ""}`);

  return context(state, parsed.flags);
}

async function pushContext(parsed, state, io) {
  const ctx = context(state, parsed.flags);
  if (ctx.token) return ctx;
  if (parsed.flags["no-login"]) requireToken(ctx);
  return login(parsed, state, io, { intent: "push" });
}

async function logout(parsed, state, io) {
  const accounts = savedAccounts(state.global);
  if (parsed.flags.all) {
    const count = Object.keys(accounts).length;
    delete state.global.accounts;
    delete state.global.activeAccount;
    delete state.global.accountBindings;
    delete state.global.token;
    delete state.global.activeTeam;
    delete state.global.activeProject;
    saveGlobal(state);
    output(io, parsed.json, { ok: true, all: true, removed: count }, count ? `Logged out of ${count} account${count === 1 ? "" : "s"}` : "No saved accounts");
    return;
  }

  const selected = parsed.flags.account !== undefined
    ? { name: cleanAccountName(parsed.flags.account) }
    : accountSelection(state, parsed.flags, { strict: false });
  const accountName = selected.name;
  if (!accountName || !accounts[accountName]) throw new CliError("No stored account to log out. Run `thing accounts` to see saved accounts.");
  delete accounts[accountName];
  if (Object.keys(accounts).length) state.global.accounts = accounts;
  else delete state.global.accounts;
  if (state.global.activeAccount === accountName) {
    const [nextAccount] = Object.keys(accounts);
    if (nextAccount) state.global.activeAccount = nextAccount;
    else delete state.global.activeAccount;
  }
  if (isRecord(state.global.accountBindings)) {
    for (const [directory, name] of Object.entries(state.global.accountBindings)) {
      if (name === accountName) delete state.global.accountBindings[directory];
    }
    if (!Object.keys(state.global.accountBindings).length) delete state.global.accountBindings;
  }
  delete state.global.token;
  delete state.global.activeTeam;
  delete state.global.activeProject;
  saveGlobal(state);
  output(io, parsed.json, { ok: true, account: accountName }, `Logged out of ${accountName}`);
}

async function accountsCommand(parsed, state, io) {
  const accounts = savedAccounts(state.global);
  const selected = accountSelection(state, parsed.flags, { strict: false });
  const binding = directoryAccountBinding(state.global, state.cwd);
  const items = Object.entries(accounts).map(([name, account]) => ({
    name,
    email: isRecord(account) ? account.email || null : null,
    server: isRecord(account) ? stripSlash(account.server || state.global.server || DEFAULT_SERVER) : null,
    active: state.global.activeAccount === name,
    selected: selected.name === name
  }));
  const payload = {
    selectedAccount: selected.name || null,
    activeAccount: state.global.activeAccount || null,
    directoryBinding: binding ? { account: binding.account, directory: binding.directory } : null,
    accounts: items
  };
  const lines = items.length
    ? items.map((account) => `${account.selected ? "*" : " "} ${account.name}\t${account.email || ""}\t${account.server || ""}`)
    : ["No saved accounts. Run `thing login` to add one."];
  if (binding) lines.push(`Directory: ${binding.directory} → ${binding.account}`);
  output(io, parsed.json, payload, lines.join("\n"));
}

async function switchAccount(parsed, state, io) {
  const accounts = savedAccounts(state.global);
  if (parsed.flags["clear-local"]) {
    const binding = directoryAccountBinding(state.global, state.cwd);
    if (!binding) throw new CliError("This directory does not have an account binding.");
    delete state.global.accountBindings[binding.directory];
    if (!Object.keys(state.global.accountBindings).length) delete state.global.accountBindings;
    saveGlobal(state);
    const selected = accountSelection(state, {}, { strict: false });
    output(io, parsed.json, {
      ok: true,
      account: selected.name || null,
      scope: "directory",
      cleared: binding.directory
    }, `Cleared the account binding for ${binding.directory}${selected.name ? `; now using ${selected.name}` : ""}`);
    return;
  }

  const [rawName] = parsed.positionals;
  if (!rawName) throw new CliError("Usage: thing switch <account> [--local]\n       thing switch --clear-local");
  const accountName = cleanAccountName(rawName);
  if (!isRecord(accounts[accountName])) throw new CliError(`Unknown account "${accountName}". Run \`thing accounts\` to see saved accounts.`);

  if (parsed.flags.local) {
    const directory = repositoryRoot(state.cwd) || state.cwd;
    const bindings = isRecord(state.global.accountBindings) ? state.global.accountBindings : {};
    bindings[directory] = accountName;
    state.global.accountBindings = bindings;
    saveGlobal(state);
    output(io, parsed.json, { ok: true, account: accountName, scope: "directory", directory }, `Using ${accountName} in ${directory}`);
    return;
  }

  state.global.activeAccount = accountName;
  saveGlobal(state);
  output(io, parsed.json, { ok: true, account: accountName, scope: "global" }, `Default account set to ${accountName}`);
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
    { ...data, account: ctx.account, accountSource: ctx.accountSource, server: ctx.server, activeTeam: ctx.team, activeProject: ctx.project },
    `${data.user.email}${ctx.account ? `\naccount: ${ctx.account} (${ctx.accountSource})` : ""}\nserver: ${ctx.server}\npushes go to: ${target}${ctx.project ? `\nproject: ${ctx.project}` : ""}`
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
  const path = resolve(file);
  const doc = docFromFile(path);
  if (parsed.flags.visibility && !VISIBILITIES.has(parsed.flags.visibility)) throw new CliError("Invalid visibility. Use team or public.");
  const ctx = await pushContext(parsed, state, io);
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

async function openCommand(parsed, state, io) {
  const [name] = parsed.positionals;
  if (!name) throw new CliError("Usage: thing open <name>");
  const ctx = context(state, parsed.flags);
  requireToken(ctx);
  const artifact = await resolveArtifact(ctx, name);
  const url = `${ctx.server}/${artifact.teamSlug}/${artifact.slug}`;
  if (!parsed.json && !parsed.flags["no-browser"]) {
    openBrowser(url);
  }
  output(io, parsed.json, { url, artifact }, url);
}

function versionCommand(parsed, io, name = "thing-cli") {
  output(io, parsed.json, { name, version: VERSION }, `${name === "thing-mcp" ? "thing-mcp" : "thing"} ${VERSION}`);
}

async function updateCommandHandler(parsed, state, io) {
  const force = Boolean(parsed.flags.force);
  const manager = detectedPackageManager(parsed.flags);
  const command = updateCommand({ manager });

  const ephemeral = ephemeralInvocation();
  if (ephemeral && !parsed.flags.manager) {
    output(io, parsed.json, {
      ok: true,
      action: "restart",
      currentVersion: VERSION,
      package: PACKAGE_NAME,
      recommendation: `Use ${PACKAGE_SPEC} in the npx command and restart the client.`
    }, `This copy runs through ${ephemeral}. Use ${PACKAGE_SPEC} in the ${ephemeral} command, then restart the CLI or MCP client.`);
    return;
  }

  if (!force) {
    const policy = await getUpdatePolicy(state, parsed.flags, { client: "thing-cli", forceRefresh: true });
    if (policy?.status === "current") {
      output(io, parsed.json, { ok: true, updated: false, ...updatePolicyOutput(policy) }, `Thing CLI ${VERSION} is already current.`);
      return;
    }
  }

  const args = ["install", "--global", PACKAGE_SPEC, ...(force && manager === "npm" ? ["--force"] : [])];
  const runner = io.spawnSync || spawnSync;
  const result = runner(manager, args, {
    stdio: parsed.json ? "pipe" : "inherit",
    encoding: "utf8"
  });
  if (result?.error) throw new CliError(`Could not run ${manager}: ${result.error.message}`);
  if (result?.status !== 0) {
    const detail = parsed.json ? String(result?.stderr || result?.stdout || "").trim() : "";
    throw new CliError(`Update failed with ${manager}${detail ? `: ${detail}` : "."}`);
  }
  output(io, parsed.json, {
    ok: true,
    updated: true,
    forced: force,
    previousVersion: VERSION,
    package: PACKAGE_NAME,
    command
  }, `Installed ${PACKAGE_SPEC}. Restart Thing${clientKind() === "thing-mcp" ? " and your MCP client" : ""} to use the new version.`);
}

// --- MCP server (`thing mcp`) ---------------------------------------------
// Newline-delimited JSON-RPC 2.0 over stdio, per the Model Context Protocol.
// Zero dependencies: four tools that reuse the CLI's own auth and push path,
// so any MCP client (Claude Code, Cursor, a desktop assistant) can publish
// artifacts through the user's existing `thing login`.

const MCP_TOOLS = [
  {
    name: "server_info",
    description:
      "Reports the installed Thing MCP version and whether the Thing server recommends or requires an update. This tool remains available when other tools require a newer client.",
    inputSchema: { type: "object", properties: {} }
  },
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

async function mcpTool(state, parsed, name, args, runtime = {}) {
  if (name === "server_info") {
    return {
      name: "thing-mcp",
      version: VERSION,
      update: updatePolicyOutput(runtime.updatePolicy)
    };
  }
  const ctx = context(state, {
    ...parsed.flags,
    ...(args.team ? { team: args.team } : {}),
    ...(args.project ? { project: args.project } : {})
  });
  if (name === "whoami") {
    requireToken(ctx);
    const data = await api(ctx, "/api/v1/whoami");
    return { user: data.user, account: ctx.account, accountSource: ctx.accountSource, server: ctx.server, defaultTeam: data.defaultTeam?.slug ?? null };
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
  const notify = (method, params) => io.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  const logLevels = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];
  let updatePolicy = null;
  let advisoryDelivered = false;
  let logLevel = "notice";
  const handle = async (req) => {
    if (req.method === "initialize") {
      updatePolicy = await getUpdatePolicy(state, parsed.flags, { client: "thing-mcp", forceRefresh: true });
      const result = {
        protocolVersion: req.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {}, logging: {} },
        serverInfo: { name: "thing", version: VERSION }
      };
      const instructions = updateNotice(updatePolicy, "thing-mcp");
      if (instructions) result.instructions = instructions;
      return result;
    }
    if (req.method === "tools/list") return { tools: MCP_TOOLS };
    if (req.method === "ping") return {};
    if (req.method === "logging/setLevel") {
      const requested = req.params?.level;
      if (!logLevels.includes(requested)) {
        const error = new CliError(`Invalid log level: ${requested}`);
        error.rpcCode = -32602;
        throw error;
      }
      logLevel = requested;
      return {};
    }
    if (req.method === "tools/call") {
      const { name, arguments: args = {} } = req.params || {};
      try {
        if (name !== "server_info" && updatePolicy?.status === "update_required") {
          throw new UpdateRequiredError(updatePolicy);
        }
        const result = await mcpTool(state, parsed, name, args, { updatePolicy });
        const content = [{ type: "text", text: JSON.stringify(result, null, 2) }];
        if (name !== "server_info" && updatePolicy?.status === "update_available" && !advisoryDelivered) {
          content.push({ type: "text", text: updateNotice(updatePolicy, "thing-mcp") });
          advisoryDelivered = true;
        }
        return { content };
      } catch (error) {
        if (error.code === "CLIENT_UPDATE_REQUIRED") updatePolicy = error.policy;
        // Tool failures are results, not protocol errors, per MCP.
        return {
          content: [{ type: "text", text: error.code === "CLIENT_UPDATE_REQUIRED" ? updateNotice(error.policy, "thing-mcp") : error.message }],
          ...(error.code === "CLIENT_UPDATE_REQUIRED" ? { structuredContent: updateErrorPayload(error) } : {}),
          isError: true
        };
      }
    }
    throw new CliError(`Method not found: ${req.method}`);
  };

  const handleNotification = (notification) => {
    if (notification.method !== "notifications/initialized" || !updatePolicy || updatePolicy.status === "current") return;
    const level = updatePolicy.status === "update_required" ? "warning" : "notice";
    if (logLevels.indexOf(level) < logLevels.indexOf(logLevel)) return;
    notify("notifications/message", {
      level,
      logger: "thing-update",
      data: {
        code: updatePolicy.status === "update_required" ? "CLIENT_UPDATE_REQUIRED" : "CLIENT_UPDATE_AVAILABLE",
        message: updateNotice(updatePolicy, "thing-mcp"),
        ...updatePolicyOutput(updatePolicy)
      }
    });
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
      if (request.id === undefined || request.id === null) {
        handleNotification(request);
        continue;
      }
      try {
        respond(request.id, { result: await handle(request) });
      } catch (error) {
        respond(request.id, { error: { code: error.rpcCode || -32601, message: error.message } });
      }
    }
  }
}

function usage() {
  return `Usage: thing <command> [options]

Commands:
  version
  update [--force] [--manager npm|bun]
  login [--account name] [--server url] [--no-browser]
  accounts
  switch <account> [--local]
  switch --clear-local
  logout [--account name] [--all]
  whoami
  use <team> [project]
  default [team] [--clear]
  push <file.html|.md|.pdf|.png|.jpg|.gif|.webp> [--name x] [--team t] [--project p] [--visibility team|public] [--no-login] [--no-browser]
  list
  versions <name>
  rollback <name> <version>
  open <name>
  mcp [--version]         # Model Context Protocol server over stdio

Global options:
  --version, -V
  --account name
  --json
`;
}

export async function run(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd(), env: process.env }) {
  const parsed = parseArgv(argv);
  const state = loadState(io.cwd || process.cwd(), io.env || process.env);
  clientName = parsed.command === "mcp" ? `thing-mcp/${VERSION}` : `thing-cli/${VERSION}`;
  try {
    if (parsed.command === "mcp" && parsed.flags.version) {
      versionCommand(parsed, io, "thing-mcp");
      return 0;
    }

    const localCommands = new Set([undefined, "-h", "--help", "-V", "--version", "version", "update", "login", "logout", "accounts", "switch", "mcp"]);
    const policy = localCommands.has(parsed.command)
      ? null
      : await getUpdatePolicy(state, parsed.flags, { client: "thing-cli" });
    if (policy?.status === "update_required") throw new UpdateRequiredError(policy);

    switch (parsed.command) {
      case "version":
      case "-V":
      case "--version":
        versionCommand(parsed, io);
        break;
      case "update":
        await updateCommandHandler(parsed, state, io);
        break;
      case "login":
        await login(parsed, state, io);
        break;
      case "logout":
        await logout(parsed, state, io);
        break;
      case "accounts":
        await accountsCommand(parsed, state, io);
        break;
      case "switch":
        await switchAccount(parsed, state, io);
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
    maybeShowCliUpdate(policy, parsed, state, io);
    return 0;
  } catch (error) {
    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(updateErrorPayload(error))}\n`);
    } else {
      io.stderr.write(`${error.code === "CLIENT_UPDATE_REQUIRED" ? updateNotice(error.policy, "thing-cli") : error.message}\n`);
    }
    return error.exitCode || 1;
  }
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (import.meta.url === pathToFileURL(invokedPath).href) {
  const code = await run();
  process.exitCode = code;
}
