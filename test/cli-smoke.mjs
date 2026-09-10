import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const staleVersions = [...source.matchAll(/thing-(?:cli|mcp)\/(\d+\.\d+\.\d+)|version: "(\d+\.\d+\.\d+)"/g)]
  .map((match) => match[1] ?? match[2])
  .filter((version) => version !== pkg.version);
assert(staleVersions.length === 0, `version strings out of step with package.json ${pkg.version}: ${staleVersions.join(", ")}`);

let stdout = "";
let stderr = "";
const code = await run(["--help"], {
  cwd: process.cwd(),
  env: process.env,
  stdout: { write: (chunk) => { stdout += String(chunk); } },
  stderr: { write: (chunk) => { stderr += String(chunk); } }
});
assert(code === 0, `thing --help failed: ${stderr}`);
assert(stdout.includes("thing <command>"), "help should include the command usage");

const originalFetch = globalThis.fetch;
const home = await mkdtemp(join(tmpdir(), "thing-cli-home-"));
const cwd = await mkdtemp(join(tmpdir(), "thing-cli-project-"));
const file = join(cwd, "report.html");
writeFileSync(file, "<!doctype html><h1>automatic login push</h1>");

let deviceIntent = null;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = init.body ? JSON.parse(String(init.body)) : null;
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });

  if (url.pathname === "/api/v1/auth/device/code") {
    deviceIntent = body?.intent;
    return json({
      device_code: "device-1",
      user_code: "ABCD-EFGH",
      verification_uri: `${url.origin}/device`,
      verification_uri_complete: `${url.origin}/device?code=ABCD-EFGH`,
      expires_in: 60,
      interval: 1
    });
  }
  if (url.pathname === "/api/v1/auth/device/token") {
    return json({ access_token: "token-1" });
  }
  if (url.pathname === "/api/v1/whoami") {
    assert(init.headers.Authorization === "Bearer token-1", "whoami should use the issued token");
    return json({ user: { email: "cli@example.com" }, defaultTeam: null });
  }
  if (url.pathname === "/api/v1/artifacts" && init.method !== "POST") {
    assert(init.headers.Authorization === "Bearer comments-token", "comments should resolve artifacts with the selected account token");
    return json({ artifacts: [{ id: "artifact-comments", slug: "weekly-report", title: "Weekly report", teamSlug: "personal", projectSlug: null, visibility: "team" }] });
  }
  if (url.pathname === "/api/v1/artifacts") {
    assert(init.headers.Authorization === "Bearer token-1", "push should resume with the issued token");
    return json({
      artifact: {
        id: "artifact-1",
        slug: body.slug,
        teamSlug: "personal",
        visibility: body.visibility,
        url: `${url.origin}/personal/${body.slug}`
      },
      version: { number: 1 }
    });
  }
  if (url.pathname === "/api/v1/artifacts/artifact-comments/comments") {
    assert(init.headers.Authorization === "Bearer comments-token", "comments should use the selected account token");
    return json({
      artifact: { id: "artifact-comments", slug: "weekly-report", title: "Weekly report", visibility: "team" },
      comments: [{ id: "comment-1", parentId: null, resolvedAt: null, body: "Please tighten the summary.", quote: "Summary", region: null, versionId: "version-2", versionNumber: 2, createdAt: "2026-09-10T10:00:00.000Z", author: { id: "user-1", email: "reviewer@example.com", name: "Reviewer" } }]
    });
  }
  return json({ error: `unexpected path ${url.pathname}` }, 404);
};

try {
  let pushStdout = "";
  let pushStderr = "";
  const env = {
    ...process.env,
    THING_NO_BROWSER: "1",
    THING_POLL_INTERVAL_MS: "250",
    THING_TOKEN: "",
    XDG_CONFIG_HOME: join(home, ".config")
  };
  const pushCode = await run([
    "push",
    file,
    "--name",
    "auto-login",
    "--visibility",
    "public",
    "--server",
    "https://thing.test",
    "--no-browser",
    "--json"
  ], {
    cwd,
    env,
    stdout: { write: (chunk) => { pushStdout += String(chunk); } },
    stderr: { write: (chunk) => { pushStderr += String(chunk); } }
  });

  assert(pushCode === 0, `automatic login push failed: ${pushStderr || pushStdout}`);
  const lines = pushStdout.trim().split("\n").map((line) => JSON.parse(line));
  assert(lines[0].userCode === "ABCD-EFGH", "push should emit device login status first");
  assert(lines.at(-1).url === "https://thing.test/personal/auto-login", "push should resume and emit the artifact URL");
  assert(deviceIntent === "push", "automatic authentication should identify push intent");
  const config = JSON.parse(readFileSync(join(home, ".config", "thing", "config.json"), "utf8"));
  assert(config.activeAccount === "cli@example.com", "automatic login should select an account named after the authenticated email");
  assert(config.accounts["cli@example.com"].token === "token-1", "automatic login should store the issued token in the account");

  let loginStdout = "";
  let loginStderr = "";
  const loginCode = await run([
    "login",
    "--account",
    "work",
    "--server",
    "https://thing.test",
    "--no-browser",
    "--json"
  ], {
    cwd,
    env,
    stdout: { write: (chunk) => { loginStdout += String(chunk); } },
    stderr: { write: (chunk) => { loginStderr += String(chunk); } }
  });
  assert(loginCode === 0, `a second named login should succeed: ${loginStderr || loginStdout}`);
  const afterSecondLogin = JSON.parse(readFileSync(join(home, ".config", "thing", "config.json"), "utf8"));
  assert(afterSecondLogin.activeAccount === "work", "the newest named login should become the global default");
  assert(afterSecondLogin.accounts.work.token === "token-1", "the named login should store its credential");
  assert(afterSecondLogin.accounts["cli@example.com"].token === "token-1", "adding an account should not overwrite earlier credentials");
  afterSecondLogin.accounts.comments = { server: "https://thing.test", token: "comments-token" };
  writeFileSync(join(home, ".config", "thing", "config.json"), JSON.stringify(afterSecondLogin));

  let commentsStdout = "";
  let commentsStderr = "";
  const commentsCode = await run(["comments", "weekly-report", "--account", "comments", "--server", "https://thing.test", "--json"], {
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: join(home, ".config") },
    stdout: { write: (chunk) => { commentsStdout += String(chunk); } },
    stderr: { write: (chunk) => { commentsStderr += String(chunk); } }
  });
  assert(commentsCode === 0, `comments command failed: ${commentsStderr || commentsStdout}`);
  const comments = JSON.parse(commentsStdout);
  assert(comments.artifact.slug === "weekly-report", "comments JSON should include the resolved artifact");
  assert(comments.comments[0].versionNumber === 2, "comments JSON should preserve version context");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("CLI smoke passed");
