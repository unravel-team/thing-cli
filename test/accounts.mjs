import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function capture(cwd, env) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd,
      env,
      stdout: { write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: (chunk) => { stderr += String(chunk); } }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const originalFetch = globalThis.fetch;
const root = await mkdtemp(join(tmpdir(), "thing-cli-accounts-"));
const configRoot = join(root, "config");
const configFile = join(configRoot, "thing", "config.json");
const repo = join(root, "repo");
const nested = join(repo, "packages", "site");
const elsewhere = join(root, "elsewhere");
mkdirSync(join(repo, ".git"), { recursive: true });
mkdirSync(nested, { recursive: true });
mkdirSync(elsewhere, { recursive: true });
mkdirSync(join(configRoot, "thing"), { recursive: true });
const canonicalRepo = realpathSync(repo);

writeFileSync(configFile, `${JSON.stringify({
  accounts: {
    work: { server: "https://work.thing.test", token: "work-token", email: "work@example.com" },
    personal: { server: "https://personal.thing.test", token: "personal-token", email: "me@example.com" }
  },
  activeAccount: "personal"
}, null, 2)}\n`);

const env = {
  ...process.env,
  XDG_CONFIG_HOME: configRoot,
  THING_TOKEN: "",
  THING_SERVER: "",
  THING_NO_UPDATE_NOTICES: "1"
};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.pathname === "/api/v1/client-policy") {
    return json({ client: "thing-cli", latestVersion: "0.6.0", minimumVersion: "0.6.0", status: "current" });
  }
  if (url.pathname === "/api/v1/whoami") {
    const token = init.headers.Authorization;
    if (url.origin === "https://work.thing.test" && token === "Bearer work-token") {
      return json({ user: { email: "work@example.com" }, defaultTeam: null });
    }
    if (url.origin === "https://personal.thing.test" && token === "Bearer personal-token") {
      return json({ user: { email: "me@example.com" }, defaultTeam: null });
    }
    if (url.origin === "https://legacy.thing.test" && token === "Bearer legacy-token") {
      return json({ user: { email: "legacy@example.com" }, defaultTeam: null });
    }
    return json({ error: `wrong account: ${url.origin} ${token}` }, 401);
  }
  return json({ error: `unexpected path ${url.pathname}` }, 404);
};

try {
  const initial = capture(nested, env);
  assert(await run(["accounts", "--json"], initial.io) === 0, "account listing should succeed");
  const initialPayload = JSON.parse(initial.stdout());
  assert(initialPayload.selectedAccount === "personal", "the global default account should be selected initially");
  assert(initialPayload.accounts.length === 2, "all stored accounts should be listed");
  assert(initialPayload.directoryBinding === null, "an unbound directory should not report a local account");

  const bind = capture(nested, env);
  assert(await run(["switch", "work", "--local", "--json"], bind.io) === 0, `local account binding should succeed: ${bind.stderr()}`);
  const binding = JSON.parse(bind.stdout());
  assert(binding.account === "work" && binding.scope === "directory", "switch --local should report its directory scope");
  assert(binding.directory === canonicalRepo, "a local switch inside a Git repository should bind its root");

  const stored = JSON.parse(readFileSync(configFile, "utf8"));
  assert(stored.accountBindings[canonicalRepo] === "work", "the repository binding should remain machine-local in the global config");

  const nestedIdentity = capture(nested, env);
  assert(await run(["whoami", "--json"], nestedIdentity.io) === 0, `nested commands should inherit the repository account: ${nestedIdentity.stderr()}`);
  const nestedWhoami = JSON.parse(nestedIdentity.stdout());
  assert(nestedWhoami.account === "work", "whoami should expose the resolved account name");
  assert(nestedWhoami.server === "https://work.thing.test", "the repository account should provide its own server");

  const globalIdentity = capture(elsewhere, env);
  assert(await run(["whoami", "--json"], globalIdentity.io) === 0, "commands outside the repository should use the global account");
  assert(JSON.parse(globalIdentity.stdout()).account === "personal", "the global account should remain unchanged by switch --local");

  const overrideIdentity = capture(nested, env);
  assert(await run(["whoami", "--account", "personal", "--json"], overrideIdentity.io) === 0, "--account should override a directory binding for one command");
  assert(JSON.parse(overrideIdentity.stdout()).account === "personal", "the explicit account should have highest precedence");

  const clear = capture(nested, env);
  assert(await run(["switch", "--clear-local", "--json"], clear.io) === 0, "a local binding should be removable");
  assert(JSON.parse(clear.stdout()).account === "personal", "clearing a local binding should reveal the global account");

  const globalSwitch = capture(elsewhere, env);
  assert(await run(["switch", "work", "--json"], globalSwitch.io) === 0, "the global default account should be switchable");
  assert(JSON.parse(globalSwitch.stdout()).scope === "global", "a switch without --local should be global");

  const missing = capture(elsewhere, env);
  assert(await run(["switch", "missing"], missing.io) === 1, "switching to an unknown account should fail");
  assert(missing.stderr().includes("Unknown account") && missing.stderr().includes("thing accounts"), "unknown accounts should have a useful recovery message");

  const legacyRoot = join(root, "legacy-config");
  const legacyFile = join(legacyRoot, "thing", "config.json");
  mkdirSync(join(legacyRoot, "thing"), { recursive: true });
  writeFileSync(legacyFile, `${JSON.stringify({ server: "https://legacy.thing.test", token: "legacy-token" }, null, 2)}\n`);
  const legacyEnv = { ...env, XDG_CONFIG_HOME: legacyRoot };
  const legacyAccounts = capture(elsewhere, legacyEnv);
  assert(await run(["accounts", "--json"], legacyAccounts.io) === 0, "legacy single-login configs should be accepted");
  const legacyPayload = JSON.parse(legacyAccounts.stdout());
  assert(legacyPayload.selectedAccount === "default" && legacyPayload.accounts[0].name === "default", "a legacy login should migrate to a named default account");

  const legacyIdentity = capture(elsewhere, legacyEnv);
  assert(await run(["whoami", "--json"], legacyIdentity.io) === 0, "a migrated legacy login should remain authenticated");
  assert(JSON.parse(legacyIdentity.stdout()).account === "default", "whoami should expose the migrated account name");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Account tests passed");
